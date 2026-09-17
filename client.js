const net = require('net');
const WebSocket = require('ws');

const args = process.argv.slice(2);
const serverArg = args.find(a => a.startsWith('--server='));
const localArg = args.find(a => a.startsWith('--local='));
const subdomainArg = args.find(a => a.startsWith('--subdomain='));

// Default must match server's SIGNALING_PORT (8081), not Caddy's 8080.
const SERVER_URL = serverArg ? serverArg.split('=')[1] : 'ws://localhost:8081';
const REQUESTED_SUBDOMAIN = subdomainArg ? subdomainArg.split('=')[1] : null;

// Accepts "4222" or "127.0.0.1:4222". Invalid -> 127.0.0.1:3000.
function parseLocalTarget(raw) {
    const m = raw ? String(raw).match(/^(?:([^:]+):)?(\d+)$/) : null;
    const port = m ? parseInt(m[2], 10) : NaN;
    if (!m || !Number.isInteger(port) || port <= 0 || port > 65535) {
        return { host: '127.0.0.1', port: 3000 };
    }
    return { host: m[1] || '127.0.0.1', port };
}
const LOCAL_TARGET = parseLocalTarget(localArg ? localArg.split('=')[1] : null);

// ponytail: fixed backoff 1s doubling to 30s cap + <1s jitter.
// Env-tunable if ops ever needs it.
function reconnectDelay(attempt) {
    return Math.min(1000 * 2 ** attempt, 30000) + Math.floor(Math.random() * 1000);
}
// Server pings every 30s; 75s of total silence means a half-open link.
const HEARTBEAT_TIMEOUT = 75000;

let ws = null;
let reconnectAttempt = 0;
let reconnectTimer = null;
let fatalError = null;
let shuttingDown = false;
let lastSeen = Date.now();
const activeConnections = new Map();

function safeSend(obj) {
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    try {
        ws.send(JSON.stringify(obj));
        return true;
    } catch (e) {
        return false;
    }
}

// Notify the server exactly once per session so it can release its
// session entry; otherwise the server leaks sockets/sessions.
function closeSession(sessionId, localSocket) {
    if (!activeConnections.has(sessionId)) return;
    activeConnections.delete(sessionId);
    safeSend({ type: 'CLOSE_CONNECTION', sessionId });
    try { localSocket.destroy(); } catch (e) {}
}

function dropLocalSockets() {
    for (const [, s] of activeConnections) {
        try { s.destroy(); } catch (e) {}
    }
    activeConnections.clear();
}

function scheduleReconnect() {
    if (shuttingDown || fatalError || reconnectTimer) return;
    const delay = reconnectDelay(reconnectAttempt++);
    console.log(`Reconnecting in ${(delay / 1000).toFixed(1)}s (attempt ${reconnectAttempt})...`);
    // Must stay ref'd: after a disconnect this timer is the only thing
    // keeping the event loop alive. unref here = silent process exit.
    reconnectTimer = setTimeout(() => { reconnectTimer = null; connect(); }, delay);
}

function handleMessage(data) {
    let msg;
    try {
        msg = JSON.parse(data);
    } catch (e) { return; }
    if (!msg || typeof msg !== 'object') return;

    if (msg.type === 'TUNNEL_ASSIGNED') {
        console.log(`\x1b[32mTunnel established!\x1b[0m`);
        console.log(`Public URL: ${msg.fullUrl}`);
        console.log(`Local target: ${LOCAL_TARGET.host}:${LOCAL_TARGET.port}`);
    } else if (msg.type === 'NEW_CONNECTION') {
        const { sessionId } = msg;
        if (typeof sessionId !== 'string' || activeConnections.has(sessionId)) return;

        // Dialed fresh per session: if the local app is down this
        // fails, the public side sees a refused connection, and the
        // NEXT hit redials — no manual intervention when the app
        // comes back up.
        const localSocket = net.connect(LOCAL_TARGET.port, LOCAL_TARGET.host);

        activeConnections.set(sessionId, localSocket);

        localSocket.on('data', (buffer) => {
            safeSend({
                type: 'DATA',
                sessionId,
                payload: buffer.toString('base64')
            });
        });

        // 'close' covers normal end, reset, and connect failure, so the
        // server is always notified (previously 'end' missed abrupt closes
        // and 'error' never notified the server at all).
        localSocket.on('close', () => {
            closeSession(sessionId, localSocket);
        });

        localSocket.on('error', () => {
            // 'close' follows 'error' and does the cleanup; destroy here
            // so 'close' fires promptly on connect refusal.
            try { localSocket.destroy(); } catch (e) {}
        });
    } else if (msg.type === 'DATA') {
        const { sessionId, payload } = msg;
        if (typeof sessionId !== 'string' || typeof payload !== 'string') return;
        const localSocket = activeConnections.get(sessionId);
        if (localSocket && !localSocket.destroyed) {
            try {
                localSocket.write(Buffer.from(payload, 'base64'));
            } catch (e) {}
        }
    } else if (msg.type === 'CLOSE_CONNECTION') {
        const { sessionId } = msg;
        if (typeof sessionId !== 'string') return;
        const localSocket = activeConnections.get(sessionId);
        if (localSocket) {
            activeConnections.delete(sessionId);
            try { localSocket.destroy(); } catch (e) {}
        }
    } else if (msg.type === 'ERROR') {
        // Server rejects the tunnel itself (bad subdomain, no ports) —
        // retrying the same request is pointless, so exit and let the
        // process manager surface it.
        fatalError = msg.message || 'unknown error';
        console.error(`Server Error: ${fatalError}`);
        try { ws.close(); } catch (e) {}
        setTimeout(() => process.exit(1), 500).unref?.();
    }
}

function connect() {
    if (shuttingDown || fatalError) return;
    console.log(`Connecting to signaling server at ${SERVER_URL}...`);
    lastSeen = Date.now();

    let watched = true;
    const watchdog = setInterval(() => {
        if (!watched) { clearInterval(watchdog); return; }
        if (!ws || ws.readyState !== WebSocket.OPEN) { clearInterval(watchdog); watched = false; return; }
        if (Date.now() - lastSeen > HEARTBEAT_TIMEOUT) {
            console.error('Heartbeat timeout (no frames for 75s), dropping connection...');
            watched = false;
            clearInterval(watchdog);
            try { ws.terminate(); } catch (e) {}
        }
    }, 15000);
    if (typeof watchdog.unref === 'function') watchdog.unref();

    ws = new WebSocket(SERVER_URL);

    ws.on('open', () => {
        reconnectAttempt = 0;
        lastSeen = Date.now();
        console.log('Connected to signaling server');
        safeSend({
            type: 'REQUEST_TUNNEL',
            requestedSubdomain: REQUESTED_SUBDOMAIN
        });
    });

    // ws auto-replies pong to the server's ping; these events just
    // prove the link is alive for the watchdog above.
    ws.on('ping', () => { lastSeen = Date.now(); });
    ws.on('pong', () => { lastSeen = Date.now(); });
    ws.on('message', (data) => { lastSeen = Date.now(); handleMessage(data); });

    ws.on('close', (code) => {
        watched = false;
        clearInterval(watchdog);
        dropLocalSockets();
        if (fatalError) { process.exit(1); return; }
        if (shuttingDown) { process.exit(0); return; }
        // Server drops our tunnel routes on its 'close' handler, so a
        // fresh connect() re-claims the same subdomain cleanly.
        console.log(`Disconnected from signaling server (code ${code}).`);
        scheduleReconnect();
    });

    ws.on('error', (err) => {
        console.error(`Signaling connection error: ${err.message}`);
    });
}

function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`Received ${signal}, shutting down...`);
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    dropLocalSockets();
    try {
        if (ws && ws.readyState === WebSocket.OPEN) ws.close();
        else process.exit(fatalError ? 1 : 0);
    } catch (e) {
        process.exit(fatalError ? 1 : 0);
    }
    setTimeout(() => process.exit(fatalError ? 1 : 0), 1000).unref?.();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

connect();
