#!/usr/bin/env node
'use strict';

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const readline = require('readline');

const C = {
    reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m',
    green: '\x1b[32m', yellow: '\x1b[33m', red: '\x1b[31m', cyan: '\x1b[36m'
};

const args = process.argv.slice(2);
const domainArg = args.find(a => a.startsWith('--domain='));
const rangeArg = args.find(a => a.startsWith('--port-range='));
const nonInteractive = args.includes('--yes') || args.includes('-y');

const PROJECT_DIR = path.dirname(process.argv[1]);

function sh(cmd, opts = {}) {
    return execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts }).toString().trim();
}
function shInherit(cmd) { execSync(cmd, { stdio: 'inherit' }); }
function has(cmd) { try { sh(`command -v ${cmd}`); return true; } catch { return false; } }
function log(msg) { console.log(`${C.dim}▸${C.reset} ${msg}`); }
function ok(msg) { console.log(`${C.green}✓${C.reset} ${msg}`); }
function warn(msg) { console.log(`${C.yellow}!${C.reset} ${msg}`); }
function die(msg) { console.error(`${C.red}✗${C.reset} ${msg}`); process.exit(1); }

function step(title, fn) {
    console.log(`\n${C.bold}${C.cyan}==> ${title}${C.reset}`);
    return Promise.resolve().then(fn).catch(err => die(`${title} failed: ${err.message}`));
}

function prompt(question, defaultVal) {
    return new Promise(resolve => {
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        const suffix = defaultVal ? ` ${C.dim}[${defaultVal}]${C.reset}` : '';
        rl.question(`${question}${suffix}: `, answer => {
            rl.close();
            resolve((answer || '').trim() || defaultVal || '');
        });
    });
}

function detectDistro() {
    try {
        const id = sh('. /etc/os-release && echo $ID');
        return id;
    } catch { return ''; }
}

async function main() {
    if (typeof process.getuid === 'function' && process.getuid() !== 0) {
        log('Need root, re-running with sudo...');
        shInherit(`sudo "${process.execPath}" "${process.argv[1]}" ${args.map(a => `"${a}"`).join(' ')}`);
        process.exit(0);
    }

    console.log(`${C.bold}\n  hrok — VPS setup${C.reset}\n${C.dim}  ${'─'.repeat(40)}${C.reset}`);

    await step('Preflight', () => {
        if (process.platform !== 'linux') die('This setup targets Linux VPS only.');
        if (!fs.existsSync(path.join(PROJECT_DIR, 'server.js'))) {
            die(`Run this from the project directory (cannot find server.js in ${PROJECT_DIR}).`);
        }
        ok('Running as root on Linux');
    });

    const distro = detectDistro();
    const isDebianLike = ['debian', 'ubuntu', 'linuxmint'].includes(distro);

    if (!isDebianLike) {
        warn(`Distro "${distro || 'unknown'}" is not Debian/Ubuntu. Automatic apt installs skipped.`);
        warn('Install Node.js 20+, Caddy, and pm2 manually, then re-run with --yes.');
    }

    if (isDebianLike) {
        await step('Install Node.js 20', () => {
            if (has('node')) {
                const v = sh('node -v').replace('v', '');
                if (parseInt(v) >= 18) return ok(`Node ${v} already installed`);
            }
            log('Adding NodeSource repository...');
            shInherit('curl -fsSL https://deb.nodesource.com/setup_20.x | bash -');
            shInherit('apt-get install -y nodejs');
            ok(`Node ${sh('node -v')} installed`);
        });

        await step('Install Caddy', () => {
            if (has('caddy')) return ok(`Caddy ${sh('caddy version').split(' ')[0]} already installed`);
            shInherit('apt-get install -y debian-keyring debian-archive-keyring apt-transport-https curl');
            sh('install -m 0755 -d /usr/share/keyrings');
            sh(`curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg`);
            sh(`curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | tee /etc/apt/sources.list.d/caddy-stable.list >/dev/null`);
            shInherit('apt-get update');
            shInherit('apt-get install -y caddy');
            ok('Caddy installed');
        });
    }

    await step('Install pm2', () => {
        if (has('pm2')) return ok('pm2 already installed');
        shInherit('npm install -g pm2');
        ok('pm2 installed');
    });

    await step('Caddy capabilities & system service', () => {
        if (has('setcap') && has('caddy')) {
            try { sh(`setcap 'cap_net_bind_service=+ep' $(command -v caddy)`); ok('cap_net_bind_service granted'); }
            catch { warn('setcap failed (ok if already running as root)'); }
        }
        try { sh('systemctl disable --now caddy 2>/dev/null || true'); ok('System caddy.service disabled (we run our own)'); }
        catch { /* ignore */ }
    });

    await step('Install project dependencies', () => {
        shInherit(`npm install --prefix "${PROJECT_DIR}"`);
        ok('node_modules ready');
    });

    await step('Configure .env', async () => {
        const envPath = path.join(PROJECT_DIR, '.env');
        let domain = domainArg ? domainArg.split('=')[1] : null;
        if (!domain && !nonInteractive) domain = await prompt('Base domain (DNS A records: @ + *. -> VPS IP)', 'tunnel.example.com');
        if (!domain) domain = 'tunnel.example.com';

        const range = rangeArg ? rangeArg.split('=')[1] : '9000-9100';
        const [rangeStart, rangeEnd] = range.split('-');

        const env = [
            `SIGNALING_PORT=8081`,
            `PORT_RANGE_START=${rangeStart}`,
            `PORT_RANGE_END=${rangeEnd}`,
            `BASE_DOMAIN=${domain}`,
            `HTTPS_ENABLED=true`,
            `CADDY_PORT=443`
        ].join('\n') + '\n';

        if (fs.existsSync(envPath) && fs.readFileSync(envPath, 'utf8').trim() === env.trim()) {
            ok('.env already up to date');
        } else {
            if (fs.existsSync(envPath)) fs.copyFileSync(envPath, envPath + '.bak');
            fs.writeFileSync(envPath, env);
            ok(`.env written (domain: ${domain})`);
        }
    });

    await step('Configure firewall (UFW)', () => {
        if (!has('ufw')) { warn('ufw not found, skipping firewall rules'); return; }
        try {
            sh('ufw allow OpenSSH 2>/dev/null || ufw allow 22/tcp');
            sh('ufw --force enable');
            sh('ufw allow 80/tcp');
            sh('ufw allow 443/tcp');
            sh('ufw allow 8081/tcp');
            ok('Firewall: 22, 80, 443, 8081 open');
        } catch (e) { warn(`ufw setup skipped: ${e.message}`); }
    });

    await step('Start server with pm2', () => {
        try { sh('pm2 delete hrok 2>/dev/null'); } catch { /* not running yet */ }
        shInherit(`pm2 start "${path.join(PROJECT_DIR, 'server.js')}" --name hrok --cwd "${PROJECT_DIR}"`);
        sh('pm2 save');
        try {
            const startupCmd = sh('pm2 startup systemd -u root --hp /root 2>&1', { stdio: ['ignore', 'pipe', 'pipe'] });
            const line = startupCmd.split('\n').find(l => l.includes('pm2 startup') && l.includes('sudo')) || '';
            if (line) { log('Enabling pm2 boot script...'); shInherit(line.replace('sudo ', '')); ok('pm2 will survive reboots'); }
            else ok('pm2 started (run `pm2 startup` manually if boot-persistence fails)');
        } catch { warn('pm2 startup auto-enable failed; run `pm2 startup` and follow instructions'); }
        ok('hrok running under pm2');
    });

    const envVars = fs.existsSync(path.join(PROJECT_DIR, '.env'))
        ? Object.fromEntries(fs.readFileSync(path.join(PROJECT_DIR, '.env'), 'utf8').split('\n').filter(Boolean).map(l => l.split('=')))
        : {};
    const domain = envVars.BASE_DOMAIN || 'tunnel.example.com';
    const vpsIp = (() => { try { return sh('hostname -I').split(' ')[0]; } catch { return 'VPS_IP'; } })();

    console.log(`\n${C.bold}${C.green}  All done.${C.reset}\n${C.dim}  ${'─'.repeat(40)}${C.reset}`);
    console.log(`  ${C.bold}Public entry${C.reset}      https://*.${domain}  (via Caddy :443)`);
    console.log(`  ${C.bold}Signaling${C.reset}          ws://${vpsIp}:8081  (clients connect here)`);
    console.log(`  ${C.bold}Logs${C.reset}              pm2 logs hrok`);
    console.log(`  ${C.bold}Status${C.reset}            pm2 status`);
    console.log(`\n  ${C.bold}Next:${C.reset}`);
    console.log(`  1. DNS: A @ -> ${vpsIp}  and  A *.${domain} -> ${vpsIp}`);
    console.log(`  2. From your laptop:`);
    console.log(`     node client.js --server=ws://${vpsIp}:8081 --local=3000 --subdomain=myapp`);
    console.log(`  3. Visit https://myapp.${domain}\n`);
}

main().catch(err => die(`Unexpected error: ${err.message}`));
