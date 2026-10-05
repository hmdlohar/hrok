#!/usr/bin/env node
const net = require('net');
const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');
const WebSocket = require('ws');

const args = process.argv.slice(2);
// Value after the FIRST '=' so values containing '=' (query strings) survive.
function flag(name) {
    const a = args.find(x => x.startsWith(`--${name}=`));
    return a ? a.slice(name.length + 3) : null;
}
// Service verbs: install (--startup) / remove (--remove) this tunnel as a
// Windows service. Anything else just runs the tunnel below.
const STARTUP = args.includes('--startup');
const REMOVE = args.includes('--remove');
// --user: per-user service (Linux/macOS), no sudo. See OS service below.
const USER_MODE = args.includes('--user');

// Default must match server's SIGNALING_PORT (8081), not Caddy's 8080.
const SERVER_URL = flag('server') || 'ws://localhost:8081';
const REQUESTED_SUBDOMAIN = flag('subdomain');
// No --subdomain: remember the random one the server handed out and ask
// for it again on reconnect, so the public URL (and its TLS cert) stays
// stable across network blips. With --subdomain we always re-ask for the
// user's name, even if a collision once gave us a suffixed one.
let claimedSubdomain = REQUESTED_SUBDOMAIN;

// Accepts "4222" or "127.0.0.1:4222". Invalid -> 127.0.0.1:3000.
function parseLocalTarget(raw) {
    const m = raw ? String(raw).match(/^(?:([^:]+):)?(\d+)$/) : null;
    const port = m ? parseInt(m[2], 10) : NaN;
    if (!m || !Number.isInteger(port) || port <= 0 || port > 65535) {
        return { host: '127.0.0.1', port: 3000 };
    }
    return { host: m[1] || '127.0.0.1', port };
}
const LOCAL_TARGET = parseLocalTarget(flag('local'));

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
// sessionId -> { sock, connected, pending, dead, sent }. sock is the
// current dial generation; pending holds request bytes that arrived
// before a dial stuck; dead means the session is over (no more dials).
const activeConnections = new Map();
// One fast dial retry: fragile local servers (xpra's Python web server has
// request_queue_size=5) RST bursts of simultaneous dials — on Windows
// backlog overflow is an instant RST, which Caddy then reports as a random
// subset of instant 502s. 50ms later the accept queue has drained.
// ponytail: 1 retry fixed; add attempts only with evidence.
const DIAL_RETRIES = 1;
const DIAL_RETRY_MS = 50;
// Errors worth one more dial: the local server was momentarily unwilling.
// Anything else (bad host, no route) fails fast so ops sees the config bug.
const TRANSIENT_DIAL_ERRORS = new Set(['ECONNREFUSED', 'ECONNRESET', 'ECONNABORTED']);
// Above this many queued ws bytes, pause the local socket feeding it.
const WS_HIGH_WATER = 1024 * 1024;

function safeSend(obj, cb) {
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    try {
        ws.send(JSON.stringify(obj), cb);
        return true;
    } catch (e) {
        return false;
    }
}

// Notify the server exactly once per session so it can release its
// session entry; otherwise the server leaks sockets/sessions.
function endSession(sessionId) {
    const st = activeConnections.get(sessionId);
    if (!st || st.dead) return;
    st.dead = true;
    activeConnections.delete(sessionId);
    safeSend({ type: 'CLOSE_CONNECTION', sessionId });
    try { if (st.sock) st.sock.destroy(); } catch (e) {}
}

function dropLocalSockets() {
    for (const [, st] of activeConnections) {
        st.dead = true;
        try { if (st.sock) st.sock.destroy(); } catch (e) {}
    }
    activeConnections.clear();
}

function dialLocal(sessionId, st, attempt) {
    if (st.dead) return;
    st.connected = false;
    const localSocket = net.connect(LOCAL_TARGET.port, LOCAL_TARGET.host);
    st.sock = localSocket;

    // 'connect' and the ws 'message' events come from different sockets,
    // so they can interleave: connected/pending flip atomically inside
    // this callback so request bytes never bypass the pending buffer.
    localSocket.on('connect', () => {
        if (st.pending.length) {
            try { localSocket.write(Buffer.concat(st.pending)); } catch (e) {}
        }
        st.pending = [];
        st.connected = true;
    });

    // Backpressure: pause while the ws is backed up; resume once the
    // frame we just queued has been flushed.
    localSocket.on('data', (buffer) => {
        if (!safeSend({ type: 'DATA', sessionId, payload: buffer.toString('base64') }, () => localSocket.resume())) return;
        st.sent++;
        if (ws.bufferedAmount > WS_HIGH_WATER) localSocket.pause();
    });

    localSocket.on('error', (err) => {
        localSocket.destroy();
        console.error(`Local dial ${sessionId} -> ${LOCAL_TARGET.host}:${LOCAL_TARGET.port} failed: ${err.code || err.message}`);
        if (st.dead || st.sent > 0 || attempt >= DIAL_RETRIES || !TRANSIENT_DIAL_ERRORS.has(err.code)) return;
        // Hand the session to the retry: clear st.sock so this
        // generation's 'close' below can't end the session.
        st.sock = null;
        setTimeout(() => dialLocal(sessionId, st, attempt + 1), DIAL_RETRY_MS);
    });

    // 'close' covers normal end, reset, and connect failure, so the
    // server is always notified (previously 'end' missed abrupt closes
    // and 'error' never notified the server at all). A failed generation
    // has already been replaced in st.sock or the session is dead, so
    // only the live generation's close ends the session.
    localSocket.on('close', () => {
        if (st.dead || st.sock !== localSocket) return;
        endSession(sessionId);
    });
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
        if (!REQUESTED_SUBDOMAIN && typeof msg.subdomain === 'string') claimedSubdomain = msg.subdomain;
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
        const st = { sock: null, connected: false, pending: [], dead: false, sent: 0 };
        activeConnections.set(sessionId, st);
        dialLocal(sessionId, st, 0);
    } else if (msg.type === 'DATA') {
        const { sessionId, payload } = msg;
        if (typeof sessionId !== 'string' || typeof payload !== 'string') return;
        const st = activeConnections.get(sessionId);
        if (!st || st.dead) return;
        const chunk = Buffer.from(payload, 'base64');
        // ponytail: no backpressure toward a slow local app — writes buffer
        // in memory. Needs PAUSE/RESUME frames if bulk uploads ever matter.
        // Live connected socket: write directly (net buffers while
        // connecting). Between a failed dial and its retry there is no
        // socket yet — park the bytes so the request replays in full on
        // the next dial.
        if (st.connected && st.sock && !st.sock.destroyed && st.sock.writable) {
            try { st.sock.write(chunk); } catch (e) {}
        } else {
            st.pending.push(chunk);
        }
    } else if (msg.type === 'CLOSE_CONNECTION') {
        const { sessionId } = msg;
        if (typeof sessionId !== 'string') return;
        endSession(sessionId);
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
            requestedSubdomain: claimedSubdomain
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

// ---------------- OS service (--startup / --remove) ----------------
// The service command line is hrok itself plus the tunnel flags, so all the
// reconnect/heartbeat logic above is the service's logic too. One backend
// per OS, all native: Windows SCM via WinSW, Linux systemd, macOS launchd.
const SERVICE_ARGS = args.filter(a => !['--startup', '--remove', '--user'].includes(a));
const SUBDOMAIN_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
const SERVICE_ID = REQUESTED_SUBDOMAIN && SUBDOMAIN_RE.test(REQUESTED_SUBDOMAIN)
    ? `hrok-${REQUESTED_SUBDOMAIN}` : 'hrok';
// How to run hrok again: the pkg exe is self-contained; under npm it's
// node + this script (realpath: the npm bin is a symlink/shim).
const SELF = process.pkg ? [process.execPath] : [process.execPath, fs.realpathSync(process.argv[1])];
const SERVICE_CMD = [...SELF, ...SERVICE_ARGS];
const xmlEsc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// --- Windows: WinSW wraps the command (a plain exe/node can't speak SCM).
// Only the binary from node-windows' bin is used — its Service class insists
// on its own wrapper script, which doesn't survive packaging.
const WIN_DAEMON_DIR = process.pkg
    ? path.join(path.dirname(process.execPath), 'daemon')
    : path.join(process.env.ProgramData || 'C:\\ProgramData', 'hrok');

function isAdmin() {
    return spawnSync('net', ['session'], { stdio: 'ignore' }).status === 0;
}

// One UAC prompt total: relaunch hrok with the same args elevated and
// wait. The elevated copy sees itself as admin and does the real work.
// ponytail: no escaping for embedded " in args; no flag value accepts one.
function relaunchElevated() {
    const esc = s => s.replace(/'/g, "''");
    const argList = [...SELF.slice(1), ...args].map(a => `'\"${esc(a)}\"'`).join(',');
    const ps = `Start-Process -FilePath '${esc(SELF[0])}' -Verb RunAs -Wait -ArgumentList ${argList}`;
    return spawnSync('powershell.exe', ['-NoProfile', '-Command', ps], { stdio: 'inherit' }).status;
}

function serviceInstalled() {
    return spawnSync('sc', ['query', SERVICE_ID], { stdio: 'ignore' }).status === 0;
}

function serviceRunning() {
    return /RUNNING/.test(spawnSync('sc', ['query', SERVICE_ID], { encoding: 'utf8' }).stdout || '');
}

function winsw(subcommand) {
    return spawnSync(path.join(WIN_DAEMON_DIR, `${SERVICE_ID}.exe`), [subcommand], { stdio: 'inherit' }).status;
}

// Flag values reach an XML file — escape like the Caddy snippet (rule 2).
function serviceXml() {
    return [
        '<service>',
        `  <id>${SERVICE_ID}</id>`,
        `  <name>${SERVICE_ID}</name>`,
        `  <description>${xmlEsc(`hrok tunnel: ${SERVER_URL} -> ${LOCAL_TARGET.host}:${LOCAL_TARGET.port}`)}</description>`,
        `  <executable>${xmlEsc(SERVICE_CMD[0])}</executable>`,
        ...SERVICE_CMD.slice(1).map(a => `  <argument>${xmlEsc(a)}</argument>`),
        '  <logmode>rotate</logmode>',
        '</service>'
    ].join('\r\n') + '\r\n';
}

function manageWindows() {
    const daemonDir = WIN_DAEMON_DIR;

    if (REMOVE) {
        if (!serviceInstalled()) { console.log(`Service '${SERVICE_ID}' is not installed.`); process.exit(0); }
        console.log(`Removing service '${SERVICE_ID}'...`);
        if (fs.existsSync(daemonDir)) {
            winsw('stop');        // ok to fail if already stopped
            winsw('uninstall');
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
            winsw('stop');
            winsw('uninstall');
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
    winsw('install');
    // Boot survival + crash recovery. The bundled WinSW 1.x predates
    // <onfailure>, so recovery lives in the SCM itself. 30s restart covers
    // transient fatal errors (port pool exhausted); permanent ones (invalid
    // subdomain) restart every 30s until reconfigured with --startup or
    // removed — surface it via the .err.log rather than dying silently.
    spawnSync('sc', ['config', SERVICE_ID, 'start=', 'auto'], { stdio: 'inherit' });
    spawnSync('sc', ['failure', SERVICE_ID, 'reset=', '99999',
        'actions=', 'restart/30000/restart/30000/restart/30000'], { stdio: 'inherit' });
    winsw('start');

    const running = serviceRunning();
    console.log(running
        ? `Service '${SERVICE_ID}' installed and running. Logs: ${path.join(daemonDir, `${SERVICE_ID}.out.log`)}.`
        : `Service '${SERVICE_ID}' installed but NOT running — check ${daemonDir}${path.sep}${SERVICE_ID}.err.log`);
    process.exit(running ? 0 : 1);
}

// --- Linux (systemd) / macOS (launchd). Default: system-level unit, runs
// as the user who invoked sudo, starts at boot. --user: per-user unit in
// $HOME, no sudo; starts at login (Linux: at boot too if linger is on).
// Either way: restart every 30s on exit, re-running --startup replaces it.
const MAC = process.platform === 'darwin';
const HOME = process.env.HOME || '';
const UNIX_USER = process.env.SUDO_USER || 'root';
const UNIT_PATH = MAC
    ? (USER_MODE ? path.join(HOME, 'Library/LaunchAgents') : '/Library/LaunchDaemons') + `/${SERVICE_ID}.plist`
    : (USER_MODE ? path.join(HOME, '.config/systemd/user') : '/etc/systemd/system') + `/${SERVICE_ID}.service`;
const MAC_LOG = USER_MODE ? path.join(HOME, 'Library/Logs', `${SERVICE_ID}.log`) : `/var/log/${SERVICE_ID}.log`;
const SYSTEMCTL = USER_MODE ? ['systemctl', '--user'] : ['systemctl'];
const LAUNCHD_DOMAIN = USER_MODE ? `gui/${process.getuid?.()}` : 'system';

// ExecStart quoting: \ and " escaped, % -> %% (specifiers), $ -> $$ (env).
// Control chars are rejected before we get here, so no line injection.
function systemdUnit() {
    const q = s => `"${String(s).replace(/[\\"]/g, '\\$&').replace(/%/g, '%%').replace(/\$/g, '$$$$')}"`;
    return [
        '[Unit]',
        `Description=hrok tunnel ${SERVICE_ID}`,
        // User managers can't see system targets; the client retries anyway.
        ...(USER_MODE ? [] : ['Wants=network-online.target', 'After=network-online.target']),
        '',
        '[Service]',
        `ExecStart=${SERVICE_CMD.map(q).join(' ')}`,
        ...(USER_MODE ? [] : [`User=${UNIX_USER}`]),
        'Restart=always',
        'RestartSec=30',
        '',
        '[Install]',
        `WantedBy=${USER_MODE ? 'default.target' : 'multi-user.target'}`,
    ].join('\n') + '\n';
}

function launchdPlist() {
    const s = v => `<string>${xmlEsc(v)}</string>`;
    return [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
        '<plist version="1.0"><dict>',
        `  <key>Label</key>${s(SERVICE_ID)}`,
        `  <key>ProgramArguments</key><array>${SERVICE_CMD.map(s).join('')}</array>`,
        ...(USER_MODE ? [] : [`  <key>UserName</key>${s(UNIX_USER)}`]),
        '  <key>RunAtLoad</key><true/>',
        '  <key>KeepAlive</key><true/>',
        '  <key>ThrottleInterval</key><integer>30</integer>',
        `  <key>StandardOutPath</key>${s(MAC_LOG)}`,
        `  <key>StandardErrorPath</key>${s(MAC_LOG)}`,
        '</dict></plist>',
    ].join('\n') + '\n';
}

function manageUnix() {
    const run = (cmd, ...a) => spawnSync(cmd, a, { stdio: 'inherit' }).status;
    const quiet = (cmd, ...a) => spawnSync(cmd, a, { stdio: 'ignore' }).status;
    const installed = fs.existsSync(UNIT_PATH);
    // Stop first for both --remove and an updating --startup; ok to fail.
    if (installed) MAC ? quiet('launchctl', 'bootout', `${LAUNCHD_DOMAIN}/${SERVICE_ID}`) : quiet(...SYSTEMCTL, 'disable', '--now', SERVICE_ID);

    if (REMOVE) {
        if (!installed) { console.log(`Service '${SERVICE_ID}' is not installed.`); process.exit(0); }
        fs.rmSync(UNIT_PATH, { force: true });
        if (!MAC) run(...SYSTEMCTL, 'daemon-reload');
        console.log(`Service '${SERVICE_ID}' removed.`);
        process.exit(0);
    }

    console.log(`${installed ? 'Updating' : 'Installing'} ${USER_MODE ? 'user ' : ''}service '${SERVICE_ID}': hrok ${SERVICE_ARGS.join(' ')}`);
    fs.mkdirSync(path.dirname(UNIT_PATH), { recursive: true });
    fs.writeFileSync(UNIT_PATH, MAC ? launchdPlist() : systemdUnit());
    let running;
    if (MAC) {
        // launchd may open the log as UserName — pre-create it owned by them.
        fs.mkdirSync(path.dirname(MAC_LOG), { recursive: true });
        fs.closeSync(fs.openSync(MAC_LOG, 'a'));
        if (!USER_MODE) run('chown', UNIX_USER, MAC_LOG);
        run('launchctl', 'bootstrap', LAUNCHD_DOMAIN, UNIT_PATH);
        running = quiet('launchctl', 'print', `${LAUNCHD_DOMAIN}/${SERVICE_ID}`) === 0;
    } else {
        run(...SYSTEMCTL, 'daemon-reload');
        run(...SYSTEMCTL, 'enable', '--now', SERVICE_ID);
        running = quiet(...SYSTEMCTL, 'is-active', '--quiet', SERVICE_ID) === 0;
        // Without linger the user manager (and the tunnel) dies at logout
        // and only starts at login. Self-enabling is usually allowed by polkit.
        if (USER_MODE && quiet('loginctl', 'enable-linger') !== 0) {
            console.log(`Note: runs only while you're logged in. For boot start: sudo loginctl enable-linger ${process.env.USER || '$USER'}`);
        }
    }
    const logs = MAC ? MAC_LOG : `journalctl ${USER_MODE ? '--user-unit' : '-u'} ${SERVICE_ID} -f`;
    console.log(running
        ? `Service '${SERVICE_ID}' installed and running. Logs: ${logs}`
        : `Service '${SERVICE_ID}' installed but NOT running — check ${logs}`);
    process.exit(running ? 0 : 1);
}

if (STARTUP || REMOVE) {
    // Validate before writing anything: a bad subdomain would just fatal-loop
    // as a service (server rejects it every 30s forever). Control chars
    // could inject lines into the unit/XML files.
    if (REQUESTED_SUBDOMAIN && !SUBDOMAIN_RE.test(REQUESTED_SUBDOMAIN)) {
        console.error(`Invalid subdomain '${REQUESTED_SUBDOMAIN}'.`);
        process.exit(1);
    }
    if (SERVICE_ARGS.some(a => /[\x00-\x1f]/.test(a))) {
        console.error('Flag values must not contain control characters.');
        process.exit(1);
    }
    // npx runs from a cache dir that gets cleaned — the service would vanish.
    if (STARTUP && /[\\/]_npx[\\/]/.test(SELF[SELF.length - 1])) {
        console.error('--startup needs a permanent install: npm i -g @hmdlohar/hrok, then hrok --startup ...');
        process.exit(1);
    }
    if (process.platform === 'win32') {
        if (USER_MODE) {
            console.error('--user is Linux/macOS only. On Windows use --startup (one UAC prompt).');
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
        manageWindows();
    } else if (MAC || fs.existsSync('/run/systemd/system')) {
        // Absolute node + script paths, so sudo's secure_path never has to
        // find node (nvm installs live in $HOME, invisible to `sudo hrok`).
        if (!USER_MODE && process.getuid() !== 0) {
            console.log('Needs root — re-running with sudo (or use --user for a no-sudo user service)...');
            process.exit(spawnSync('sudo', [...SELF, ...args], { stdio: 'inherit' }).status ?? 1);
        }
        manageUnix();
    } else {
        console.error('--startup/--remove need systemd (Linux), launchd (macOS) or Windows. Run hrok under pm2 or your init system instead.');
        process.exit(1);
    }
} else {
    connect();
}
