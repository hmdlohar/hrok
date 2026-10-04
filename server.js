const net = require('net');
const WebSocket = require('ws');
const CaddyManager = require('./CaddyManager');
require('dotenv').config();

function envInt(name, def) {
    const n = Number(process.env[name] || def);
    if (!Number.isInteger(n)) {
        console.error(`${name} must be an integer, got '${process.env[name]}'`);
        process.exit(1);
    }
    return n;
}

const SIGNALING_PORT = envInt('SIGNALING_PORT', 8081);
const PORT_RANGE_START = envInt('PORT_RANGE_START', 9000);
const PORT_RANGE_END = envInt('PORT_RANGE_END', 9100);
const BASE_DOMAIN = process.env.BASE_DOMAIN || 'local.test';
const HTTPS_ENABLED = process.env.HTTPS_ENABLED === 'true';

// Only lowercase alphanumerics + hyphens, cannot start/end with hyphen.
// Prevents Caddyfile injection via crafted subdomain.
const SUBDOMAIN_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

// Above this many queued ws bytes, pause the TCP socket feeding it.
const WS_HIGH_WATER = 1024 * 1024;
// How long a subdomain's current owner gets to answer a ping before a
// new claimant takes the name over (see probeOwner).
const PROBE_TIMEOUT = 3000;

const wss = new WebSocket.Server({ port: SIGNALING_PORT });
wss.on('error', (err) => {
    console.error('Signaling server error:', err.message);
});
// ponytail: fixed 30s heartbeat, env-tunable if ops ever needs it.
const HEARTBEAT_INTERVAL = 30000;
const hbTimer = setInterval(() => {
    for (const ws of wss.clients) {
        if (ws.isAlive === false) {
            try { ws.terminate(); } catch (e) {}
            continue;
        }
        ws.isAlive = false;
        try { ws.ping(); } catch (e) {}
    }
}, HEARTBEAT_INTERVAL);
if (typeof hbTimer.unref === 'function') hbTimer.unref();
wss.on('close', () => clearInterval(hbTimer));
const clientTunnels = new Map(); // Maps publicPort -> { ws, publicServer, subdomain }
const subdomainMap = new Map(); // Maps subdomain -> publicPort

const caddy = new CaddyManager({
    baseDomain: BASE_DOMAIN,
    httpsEnabled: HTTPS_ENABLED,
    caddyfilePath: process.env.CADDYFILE_PATH
});

function safeSend(ws, obj, cb) {
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    try {
        ws.send(JSON.stringify(obj), cb);
        return true;
    } catch (e) {
        return false;
    }
}

function rejectAndClose(ws, message) {
    safeSend(ws, { type: 'ERROR', message });
    // Delay close one tick so the ERROR frame flushes before the handshake.
    setTimeout(() => { try { ws.close(); } catch (e) {} }, 50);
}

function syncCaddy() {
    const tunnelConfig = new Map();
    for (const [, info] of clientTunnels) {
        tunnelConfig.set(info.subdomain, info.publicPort);
    }
    caddy.updateCaddyfile(tunnelConfig);
}

function cleanupTunnels(ws) {
    let changed = false;
    for (const [port, info] of clientTunnels) {
        if (info.ws === ws) {
            console.log(`Client on port ${port} (${info.subdomain}) disconnected`);
            try { info.publicServer.close(); } catch (e) {}
            clientTunnels.delete(port);
            subdomainMap.delete(info.subdomain);
            changed = true;
        }
    }
    if (changed) syncCaddy();
}

wss.on('connection', (ws) => {
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });
    // sessionId -> public-side socket. Single map per ws, routed by ONE
    // message handler (previously a new ws.on('message') was added per
    // TCP connection and never removed -> listener leak).
    const sessions = new Map();

    ws.on('message', (data) => {
        let msg;
        try {
            msg = JSON.parse(data);
        } catch (e) { return; }
        if (!msg || typeof msg !== 'object') return;

        if (msg.type === 'REQUEST_TUNNEL') {
            handleTunnelRequest(ws, msg.requestedSubdomain, sessions);
        } else if (msg.type === 'DATA' && typeof msg.sessionId === 'string') {
            const socket = sessions.get(msg.sessionId);
            if (socket && typeof msg.payload === 'string') {
                // ponytail: no backpressure toward a slow public reader —
                // writes buffer in memory. Needs PAUSE/RESUME frames (or
                // ws.pause(), which stalls every session) if bulk downloads
                // to slow clients ever matter.
                try {
                    socket.write(Buffer.from(msg.payload, 'base64'));
                } catch (e) {}
            }
        } else if (msg.type === 'CLOSE_CONNECTION' && typeof msg.sessionId === 'string') {
            const socket = sessions.get(msg.sessionId);
            sessions.delete(msg.sessionId);
            if (socket) {
                try { socket.destroy(); } catch (e) {}
            }
        }
    });

    ws.on('close', () => {
        for (const [, socket] of sessions) {
            try { socket.destroy(); } catch (e) {}
        }
        sessions.clear();
        cleanupTunnels(ws);
    });

    ws.on('error', () => {});
});

function randomName() {
    return Math.random().toString(36).substring(2, 8);
}

function pickSubdomain(name) {
    name = name || randomName();
    if (subdomainMap.has(name)) {
        const suffix = Math.random().toString(36).substring(2, 4);
        name = `${name.slice(0, 63 - suffix.length - 1)}-${suffix}`;
    }
    while (subdomainMap.has(name)) name = randomName();
    return name;
}

// A reconnecting client may find its own old, half-open ws still holding
// the name (server notices dead peers only after up to 60s). Ping the
// owner: no pong in PROBE_TIMEOUT → it's dead, reap it now and hand the
// name over. A live owner keeps it; the claimant gets a suffix.
function probeOwner(owner, cb) {
    let done = false;
    const finish = (alive) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        owner.removeListener('pong', onPong);
        cb(alive);
    };
    const onPong = () => finish(true);
    const timer = setTimeout(() => finish(false), PROBE_TIMEOUT);
    owner.on('pong', onPong);
    try { owner.ping(); } catch (e) { finish(false); }
}

function handleTunnelRequest(ws, requestedSubdomain, sessions) {
    if (requestedSubdomain !== undefined && requestedSubdomain !== null && requestedSubdomain !== '') {
        if (typeof requestedSubdomain !== 'string' || !SUBDOMAIN_RE.test(requestedSubdomain)) {
            rejectAndClose(ws, 'Invalid subdomain (use 1-63 chars: a-z, 0-9, hyphen)');
            return;
        }
    }
    // One tunnel per connection: otherwise a single socket can loop
    // REQUEST_TUNNEL and drain the whole port pool.
    if (ws.tunnelRequested) return;
    ws.tunnelRequested = true;

    const ownerPort = requestedSubdomain ? subdomainMap.get(requestedSubdomain) : undefined;
    if (ownerPort === undefined) {
        bindTunnel(ws, pickSubdomain(requestedSubdomain), sessions, PORT_RANGE_START);
        return;
    }
    const owner = clientTunnels.get(ownerPort).ws;
    probeOwner(owner, (alive) => {
        if (ws.readyState !== WebSocket.OPEN) return;
        if (!alive) {
            console.log(`Owner of '${requestedSubdomain}' missed probe, reaping it`);
            try { owner.terminate(); } catch (e) {}
            cleanupTunnels(owner);
        }
        bindTunnel(ws, pickSubdomain(requestedSubdomain), sessions, PORT_RANGE_START);
    });
}

// Reserves the first free port >= fromPort plus the subdomain
// synchronously (so concurrent requests can't double-book), then
// listens. EADDRINUSE (a foreign process on that port) moves on to the
// next port instead of failing every client that lands on it.
function bindTunnel(ws, subdomain, sessions, fromPort) {
    let port = fromPort;
    while (port <= PORT_RANGE_END && clientTunnels.has(port)) port++;
    if (port > PORT_RANGE_END) {
        rejectAndClose(ws, 'No public ports available');
        return;
    }

    const publicServer = net.createServer((socket) => {
        if (!ws || ws.readyState !== WebSocket.OPEN) {
            socket.destroy();
            return;
        }
        let session;
        do {
            session = Math.random().toString(36).substring(2, 8);
        } while (sessions.has(session));
        sessions.set(session, socket);
        safeSend(ws, { type: 'NEW_CONNECTION', sessionId: session });
        socket.on('data', (data) => {
            // Backpressure: pause this socket while the ws is backed up;
            // resume once the frame we just queued has been flushed.
            const sent = safeSend(ws, {
                type: 'DATA',
                sessionId: session,
                payload: data.toString('base64')
            }, () => socket.resume());
            if (sent && ws.bufferedAmount > WS_HIGH_WATER) socket.pause();
        });
        // 'close' (not 'end') so half-closed/reset sockets also notify
        // the client and release the session entry.
        socket.on('close', () => {
            if (sessions.delete(session)) {
                safeSend(ws, { type: 'CLOSE_CONNECTION', sessionId: session });
            }
        });
        socket.on('error', () => {
            socket.destroy();
        });
    });

    clientTunnels.set(port, { ws, publicServer, subdomain, publicPort: port });
    subdomainMap.set(subdomain, port);

    publicServer.on('error', (err) => {
        if (publicServer.listening) {
            console.error(`Public server error on port ${port}:`, err.message);
            return;
        }
        // Bind failed: release the reservation (only if still ours — the
        // ws may have closed and been cleaned up meanwhile).
        if (clientTunnels.get(port)?.publicServer !== publicServer) return;
        clientTunnels.delete(port);
        subdomainMap.delete(subdomain);
        if (err.code === 'EADDRINUSE') {
            console.error(`Port ${port} in use by another process, trying next`);
            bindTunnel(ws, subdomain, sessions, port + 1);
            return;
        }
        console.error(`Public server error on port ${port}:`, err.message);
        rejectAndClose(ws, 'Failed to bind public port');
    });

    // Bound to loopback only: Caddy is the sole entry point (TLS, host
    // routing). The firewall is a second layer, not the only one.
    publicServer.listen(port, '127.0.0.1', () => {
        // ws closed during the async bind: cleanupTunnels already dropped
        // the reservation, so just release the port.
        if (clientTunnels.get(port)?.publicServer !== publicServer) {
            publicServer.close();
            return;
        }
        syncCaddy();
        safeSend(ws, {
            type: 'TUNNEL_ASSIGNED',
            publicPort: port,
            subdomain,
            fullUrl: `${HTTPS_ENABLED ? 'https' : 'http'}://${subdomain}.${BASE_DOMAIN}`
        });
        console.log(`Client assigned port ${port} and subdomain ${subdomain}.`);
    });
}
