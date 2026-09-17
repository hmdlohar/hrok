const net = require('net');
const WebSocket = require('ws');
const CaddyManager = require('./CaddyManager');
require('dotenv').config();

const SIGNALING_PORT = parseInt(process.env.SIGNALING_PORT || 8081);
const PORT_RANGE_START = parseInt(process.env.PORT_RANGE_START || 9000);
const PORT_RANGE_END = parseInt(process.env.PORT_RANGE_END || 9100);
const BASE_DOMAIN = process.env.BASE_DOMAIN || 'local.test';
const HTTPS_ENABLED = process.env.HTTPS_ENABLED === 'true';

// Only lowercase alphanumerics + hyphens, cannot start/end with hyphen.
// Prevents Caddyfile injection via crafted subdomain.
const SUBDOMAIN_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

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

function safeSend(ws, obj) {
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    try {
        ws.send(JSON.stringify(obj));
        return true;
    } catch (e) {
        return false;
    }
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

function handleTunnelRequest(ws, requestedSubdomain, sessions) {
    if (requestedSubdomain !== undefined && requestedSubdomain !== null && requestedSubdomain !== '') {
        if (typeof requestedSubdomain !== 'string' || !SUBDOMAIN_RE.test(requestedSubdomain)) {
            safeSend(ws, { type: 'ERROR', message: 'Invalid subdomain (use 1-63 chars: a-z, 0-9, hyphen)' });
            // Delay close one tick so the ERROR frame flushes before the handshake.
            setTimeout(() => { try { ws.close(); } catch (e) {} }, 50);
            return;
        }
    }

    let assignedPort = -1;
    for (let p = PORT_RANGE_START; p <= PORT_RANGE_END; p++) {
        if (!clientTunnels.has(p)) {
            assignedPort = p;
            break;
        }
    }

    if (assignedPort === -1) {
        safeSend(ws, { type: 'ERROR', message: 'No public ports available' });
        setTimeout(() => { try { ws.close(); } catch (e) {} }, 50);
        return;
    }

    let finalSubdomain = requestedSubdomain || Math.random().toString(36).substring(2, 8);
    if (subdomainMap.has(finalSubdomain)) {
        const suffix = Math.random().toString(36).substring(2, 4);
        finalSubdomain = `${finalSubdomain.slice(0, 63 - suffix.length - 1)}-${suffix}`;
    }
    if (subdomainMap.has(finalSubdomain)) {
        finalSubdomain = Math.random().toString(36).substring(2, 8);
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
            safeSend(ws, {
                type: 'DATA',
                sessionId: session,
                payload: data.toString('base64')
            });
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

    publicServer.on('error', (err) => {
        console.error(`Public server error on port ${assignedPort}:`, err.message);
        clientTunnels.delete(assignedPort);
        subdomainMap.delete(finalSubdomain);
        safeSend(ws, { type: 'ERROR', message: 'Failed to bind public port' });
        syncCaddy();
    });

    publicServer.listen(assignedPort);
    clientTunnels.set(assignedPort, { ws, publicServer, subdomain: finalSubdomain, publicPort: assignedPort });
    subdomainMap.set(finalSubdomain, assignedPort);

    syncCaddy();

    safeSend(ws, {
        type: 'TUNNEL_ASSIGNED',
        publicPort: assignedPort,
        subdomain: finalSubdomain,
        fullUrl: `${HTTPS_ENABLED ? 'https' : 'http'}://${finalSubdomain}.${BASE_DOMAIN}`
    });

    console.log(`Client assigned port ${assignedPort} and subdomain ${finalSubdomain}.`);
}
