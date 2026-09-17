const net = require('net');
const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');
const WebSocket = require('ws');

const args = process.argv.slice(2);
const serverArg = args.find(a => a.startsWith('--server='));
const localArg = args.find(a => a.startsWith('--local='));
const subdomainArg = args.find(a => a.startsWith('--subdomain='));
// Service verbs: install (--startup) / remove (--remove) this tunnel as a
// Windows service. Anything else just runs the tunnel below.
const STARTUP = args.includes('--startup');
const REMOVE = args.includes('--remove');

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

// ---------------- Windows service (--startup / --remove) ----------------
// The same exe is installer AND service runtime. A plain exe can't be a
// Windows service (services must speak the SCM protocol), so --startup wraps
// THIS exe with WinSW, copied out of node-windows' bin (only the binary is
// used — node-windows' Service class insists on its own wrapper script, which
// doesn't survive packaging). The service command line is simply this exe
// plus the tunnel flags, so all the reconnect/heartbeat logic above is the
// service's logic too.
const SERVICE_ARGS = args.filter(a => a !== '--startup' && a !== '--remove');
const SUBDOMAIN_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
const SERVICE_ID = REQUESTED_SUBDOMAIN && SUBDOMAIN_RE.test(REQUESTED_SUBDOMAIN)
    ? `hrok-${REQUESTED_SUBDOMAIN}` : 'hrok';

function isAdmin() {
    return spawnSync('net', ['session'], { stdio: 'ignore' }).status === 0;
}

// One UAC prompt total: relaunch this exe with the same args elevated and
// wait. The elevated copy sees itself as admin and does the real work.
// ponytail: no escaping for embedded " in args; no flag value accepts one.
function relaunchElevated() {
    const esc = s => s.replace(/'/g, "''");
    const argList = process.argv.slice(2).map(a => `'\"${esc(a)}\"'`).join(',');
    const ps = `Start-Process -FilePath '${esc(process.execPath)}' -Verb RunAs -Wait -ArgumentList ${argList}`;
    return spawnSync('powershell.exe', ['-NoProfile', '-Command', ps], { stdio: 'inherit' }).status;
}

function serviceInstalled() {
    return spawnSync('sc', ['query', SERVICE_ID], { stdio: 'ignore' }).status === 0;
}

function serviceRunning() {
    return /RUNNING/.test(spawnSync('sc', ['query', SERVICE_ID], { encoding: 'utf8' }).stdout || '');
}

function winsw(daemonDir, subcommand) {
    return spawnSync(path.join(daemonDir, `${SERVICE_ID}.exe`), [subcommand], { stdio: 'inherit' }).status;
}

// Flag values reach an XML file — escape like the Caddy snippet (rule 2).
// One <argument> per flag is safe because flag values contain no spaces.
function serviceXml() {
    const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    return [
        '<service>',
        `  <id>${SERVICE_ID}</id>`,
        `  <name>${SERVICE_ID}</name>`,
        `  <description>${esc(`hrok tunnel: ${SERVER_URL} -> ${LOCAL_TARGET.host}:${LOCAL_TARGET.port}`)}</description>`,
        `  <executable>${esc(process.execPath)}</executable>`,
        ...SERVICE_ARGS.map(a => `  <argument>${esc(a)}</argument>`),
        '  <logmode>rotate</logmode>',
        '</service>'
    ].join('\r\n') + '\r\n';
}

function manageService() {
    const daemonDir = path.join(path.dirname(process.execPath), 'daemon');

    if (REMOVE) {
        if (!serviceInstalled()) { console.log(`Service '${SERVICE_ID}' is not installed.`); process.exit(0); }
        console.log(`Removing service '${SERVICE_ID}'...`);
        if (fs.existsSync(daemonDir)) {
            winsw(daemonDir, 'stop');        // ok to fail if already stopped
            winsw(daemonDir, 'uninstall');
            for (const f of fs.readdirSync(daemonDir)) {
                if (f.startsWith(`${SERVICE_ID}.`)) fs.rmSync(path.join(daemonDir, f), { force: true });
            }
            try { fs.rmdirSync(daemonDir); } catch (e) {} // kept if another hrok-* service shares it
        }
        if (serviceInstalled()) {
            console.error(`Failed to remove '${SERVICE_ID}'. Run from an elevated prompt, or: sc delete ${SERVICE_ID}`);
            process.exit(1);
        }
        console.log(`Service '${SERVICE_ID}' removed.`);
        process.exit(0);
    }

    // --startup. Re-running with new flags = stop, uninstall, install fresh.
    if (serviceInstalled()) {
        console.log(`Service '${SERVICE_ID}' exists — updating...`);
        if (fs.existsSync(daemonDir)) {
            winsw(daemonDir, 'stop');
            winsw(daemonDir, 'uninstall');
        }
    }
    console.log(`Installing service '${SERVICE_ID}': hrok ${SERVICE_ARGS.join(' ')}`);

    fs.mkdirSync(daemonDir, { recursive: true });
    const winswSrc = require.resolve('node-windows/bin/winsw/winsw.exe');
    // readFileSync, not copyFileSync: must read from pkg's virtual fs when packaged.
    fs.writeFileSync(path.join(daemonDir, `${SERVICE_ID}.exe`), fs.readFileSync(winswSrc));
    fs.writeFileSync(path.join(daemonDir, `${SERVICE_ID}.exe.config`),
        fs.readFileSync(path.join(path.dirname(winswSrc), 'winsw.exe.config')));
    fs.writeFileSync(path.join(daemonDir, `${SERVICE_ID}.xml`), serviceXml());
    winsw(daemonDir, 'install');
    // Boot survival + crash recovery. The bundled WinSW 1.x predates
    // <onfailure>, so recovery lives in the SCM itself. 30s restart covers
    // transient fatal errors (port pool exhausted); permanent ones (invalid
    // subdomain) restart every 30s until reconfigured with --startup or
    // removed — surface it via the .err.log rather than dying silently.
    spawnSync('sc', ['config', SERVICE_ID, 'start=', 'auto'], { stdio: 'inherit' });
    spawnSync('sc', ['failure', SERVICE_ID, 'reset=', '99999',
        'actions=', 'restart/30000/restart/30000/restart/30000'], { stdio: 'inherit' });
    winsw(daemonDir, 'start');

    const running = serviceRunning();
    console.log(running
        ? `Service '${SERVICE_ID}' installed and running. Logs: ${path.join(daemonDir, `${SERVICE_ID}.out.log`)}.`
        : `Service '${SERVICE_ID}' installed but NOT running — check ${daemonDir}${path.sep}${SERVICE_ID}.err.log`);
    process.exit(running ? 0 : 1);
}

if (STARTUP || REMOVE) {
    if (process.platform !== 'win32') {
        console.error('--startup/--remove manage a Windows service. On Linux run hrok under systemd/pm2 instead.');
        process.exit(1);
    }
    // Validate before writing anything: a bad subdomain would just fatal-loop
    // as a service (server rejects it every 30s forever).
    if (REQUESTED_SUBDOMAIN && !SUBDOMAIN_RE.test(REQUESTED_SUBDOMAIN)) {
        console.error(`Invalid subdomain '${REQUESTED_SUBDOMAIN}'.`);
        process.exit(1);
    }
    if (!isAdmin()) {
        console.log('Requesting administrator rights (accept the UAC prompt)...');
        relaunchElevated();
        const installed = serviceInstalled();
        const ok = REMOVE ? !installed : installed;
        console.log(ok
            ? (REMOVE ? `Service '${SERVICE_ID}' removed.` : `Service '${SERVICE_ID}' is ${serviceRunning() ? 'running' : 'installed'}.`)
            : 'Operation failed or the UAC prompt was declined — check the elevated console output.');
        process.exit(ok ? 0 : 1);
    }
    manageService();
} else {
    connect();
}
