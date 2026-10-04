// End-to-end check (project rule 5). Real server + real client.js, temp
// Caddyfile, no caddy needed. Run: npm test
const assert = require('assert');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const WebSocket = require('ws');

const SIG = 18081, START = 19000, END = 19009;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hrok-e2e-'));
const snippet = path.join(dir, 'hrok-tunnels.caddy');
const env = {
    ...process.env, SIGNALING_PORT: SIG, PORT_RANGE_START: START, PORT_RANGE_END: END,
    BASE_DOMAIN: 'e2e.test', CADDYFILE_PATH: path.join(dir, 'Caddyfile'), CADDY_RELOAD_COMMAND: 'true'
};
const procs = [];
const run = (file, args = []) => {
    const p = spawn(process.execPath, [path.join(__dirname, file), ...args], { env, stdio: 'ignore' });
    procs.push(p);
    return p;
};
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const read = () => (fs.existsSync(snippet) ? fs.readFileSync(snippet, 'utf8') : '');
async function until(fn, what, ms = 5000) {
    for (const t = Date.now() + ms; Date.now() < t; await sleep(50)) if (fn()) return;
    throw new Error(`timeout: ${what}`);
}
const portOf = (sub) => Number((read().match(new RegExp(`${sub}\\.e2e\\.test \\{\\n\\s+reverse_proxy localhost:(\\d+)`)) || [])[1]);

// Raw protocol client: resolves with the first non-DATA reply and whether the ws closed.
function raw(requestedSubdomain, opts = {}) {
    return new Promise((resolve) => {
        const ws = new WebSocket(`ws://127.0.0.1:${SIG}`, opts);
        const msgs = [];
        ws.on('open', () => {
            ws.send('not json');
            ws.send(JSON.stringify({ type: 'REQUEST_TUNNEL', requestedSubdomain }));
            if (opts.twice) ws.send(JSON.stringify({ type: 'REQUEST_TUNNEL', requestedSubdomain: 'second' }));
        });
        ws.on('message', (d) => { msgs.push(JSON.parse(d)); if (msgs.length === 1) resolve({ ws, msg: msgs[0], msgs }); });
        ws.on('close', () => { ws.closed = true; });
        ws.on('error', () => {});
    });
}

function echoThrough(port, text) {
    return new Promise((resolve, reject) => {
        const s = net.connect(port, '127.0.0.1', () => s.write(text));
        s.on('data', (d) => { resolve(d.toString()); s.destroy(); });
        s.on('error', reject);
    });
}

(async () => {
    // A foreign process on START: tunnels must skip it, not fail.
    const squatter = net.createServer().listen(START, '127.0.0.1');
    const echo = net.createServer((s) => s.pipe(s)).listen(0, '127.0.0.1');
    await new Promise(r => echo.once('listening', r));

    run('server.js');
    await sleep(500);

    const client = run('client.js', [`--server=ws://127.0.0.1:${SIG}`, `--local=${echo.address().port}`, '--subdomain=t1']);
    await until(() => portOf('t1'), 't1 route');
    assert.strictEqual(portOf('t1'), START + 1, 'skips EADDRINUSE port');
    assert.strictEqual(await echoThrough(portOf('t1'), 'hello'), 'hello', 'TCP echo through tunnel');
    console.log('ok  assign + echo + port conflict skipped');

    const lan = Object.values(os.networkInterfaces()).flat().find(i => i.family === 'IPv4' && !i.internal);
    if (lan) {
        await assert.rejects(new Promise((res, rej) => {
            const s = net.connect(portOf('t1'), lan.address, () => { s.destroy(); res(); });
            s.on('error', rej);
        }), 'tunnel port must not accept on LAN address');
        console.log('ok  tunnel port is loopback-only');
    }

    const bad = await raw('Bad_Sub');
    assert.strictEqual(bad.msg.type, 'ERROR');
    await until(() => bad.ws.closed, 'bad subdomain closed');
    console.log('ok  invalid subdomain rejected + closed');

    const twice = await raw('once', { twice: true });
    await sleep(300);
    assert.strictEqual(twice.msgs.filter(m => m.type === 'TUNNEL_ASSIGNED').length, 1);
    assert.ok(!read().includes('second.'), 'second REQUEST_TUNNEL ignored');
    console.log('ok  one tunnel per connection, garbage frame ignored');

    // Half-open owner (never pongs) loses its name to a new claimant.
    const dead = await raw('dead1', { autoPong: false });
    assert.strictEqual(dead.msg.subdomain, 'dead1');
    const taker = await raw('dead1');
    assert.strictEqual(taker.msg.subdomain, 'dead1', 'dead owner reaped');
    // A live owner keeps its name; claimant gets a suffix.
    const live = await raw('once');
    assert.match(live.msg.subdomain, /^once-[a-z0-9]{1,2}$/);
    console.log('ok  dead owner reaped, live owner kept');

    client.kill();
    await until(() => !read().includes('t1.'), 't1 route removed');
    console.log('ok  disconnect removes route');

    squatter.close(); echo.close();
    console.log('all passed');
})().catch((e) => { console.error('FAIL', e.message); process.exitCode = 1; })
    .finally(() => { procs.forEach(p => p.kill()); fs.rmSync(dir, { recursive: true, force: true }); setTimeout(() => process.exit(), 100); });
