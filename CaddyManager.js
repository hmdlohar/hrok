const { spawnSync } = require('child_process');
const fs = require('fs');

const DEFAULT_CADDYFILE_PATH = '/etc/caddy/Caddyfile';

class CaddyManager {
    constructor(options = {}) {
        this.baseDomain = options.baseDomain || 'local.test';
        this.httpsEnabled = options.httpsEnabled || false;
        // Overridable via CADDYFILE_PATH env (server.js) so local dev does
        // not need to touch /etc/caddy.
        this.caddyfilePath = options.caddyfilePath
            || process.env.CADDYFILE_PATH
            || DEFAULT_CADDYFILE_PATH;
        this.reloadCommand = options.reloadCommand
            || process.env.CADDY_RELOAD_COMMAND
            || null;
        // Snippet holding only hrok routes. On a shared Caddy the main
        // file keeps `import`ing it, so existing sites are never touched.
        // ponytail: fixed name next to the Caddyfile; configurable if ops needs it.
        this.snippetName = options.snippetName || 'hrok-tunnels.caddy';
    }

    snippetPath() {
        return require('path').join(require('path').dirname(this.caddyfilePath), this.snippetName);
    }

    updateCaddyfile(tunnels) {
        let config = '# Managed by hrok — do not hand-edit. Regenerated on every tunnel change.\n\n';

        for (const [subdomain, port] of tunnels) {
            const protocol = this.httpsEnabled ? 'https://' : 'http://';
            const host = `${protocol}${subdomain}.${this.baseDomain}`;

            config += `${host} {\n    reverse_proxy localhost:${port}\n}\n\n`;
        }

        const snippet = this.snippetPath();
        try {
            if (fs.existsSync(snippet)) {
                fs.copyFileSync(snippet, snippet + '.bak');
            }
            fs.writeFileSync(snippet, config);
            this.ensureImport();
            this.reload();
        } catch (error) {
            console.error('Error writing Caddy snippet:', error.message);
        }
    }

    // Adds a single `import <snippet>` line to the main Caddyfile if
    // missing. Never rewrites or deletes existing site blocks.
    // Returns true when the main file was changed (reload needed even
    // for an empty tunnel set), false when the import already existed.
    ensureImport() {
        const main = this.caddyfilePath;
        const snippet = this.snippetPath();
        const line = `import ${snippet}`;
        let existing = '';
        try {
            existing = fs.existsSync(main) ? fs.readFileSync(main, 'utf8') : '';
        } catch (error) {
            console.error('Error reading Caddyfile:', error.message);
            return false;
        }
        if (existing.split('\n').some((l) => l.trim() === line || l.trim() === `import ${this.snippetName}`)) {
            return false;
        }
        try {
            if (fs.existsSync(main)) {
                fs.copyFileSync(main, main + '.bak');
            }
            const prefix = existing.length && !existing.endsWith('\n') ? '\n' : '';
            fs.writeFileSync(main, `${existing}${prefix}\n# Added by hrok — loads tunnel routes.\n${line}\n`);
            return true;
        } catch (error) {
            console.error('Error writing Caddyfile:', error.message);
            return false;
        }
    }

    reload() {
        // Prefer explicit command; fall back to systemctl only when it exists.
        const candidates = [this.reloadCommand, 'systemctl reload caddy', 'caddy reload'].filter(Boolean);
        for (let i = 0; i < candidates.length; i++) {
            const cmd = candidates[i];
            const isLast = i === candidates.length - 1;
            const result = spawnSync(cmd, { shell: true, stdio: 'pipe', encoding: 'utf8' });
            if (result.status === 0) {
                console.log('Caddy configuration reloaded successfully.');
                return;
            }
            // Binary missing (dev machine without caddy/systemd): not an
            // error worth spamming; remaining candidates will be tried, and
            // if none exist we stay silent since the file was still written.
            if (result.error && result.error.code === 'ENOENT') {
                if (isLast) return;
                continue;
            }
            if (!isLast) continue;
            console.error(`Caddy reload failed (${cmd}):`, (result.stderr || result.error || '').toString().trim());
        }
    }
}

module.exports = CaddyManager;
