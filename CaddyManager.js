const { exec } = require('child_process');
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

    // Async + serialized: a slow systemctl/caddy must never block the
    // event loop every tunnel relays through. A change arriving mid-reload
    // sets reloadPending and gets ONE follow-up reload, which picks up the
    // latest snippet (the file write above is synchronous).
    reload() {
        if (this.reloading) { this.reloadPending = true; return; }
        this.reloading = true;
        // Explicit command first; systemctl is the production path (caddy
        // under systemd); `caddy reload` hits the admin API of the same
        // running caddy when systemctl isn't usable (non-root, no systemd).
        const candidates = [
            this.reloadCommand,
            'systemctl reload caddy',
            `caddy reload --config "${this.caddyfilePath}"`
        ].filter(Boolean);
        const done = () => {
            this.reloading = false;
            if (this.reloadPending) { this.reloadPending = false; this.reload(); }
        };
        let failure = null;
        const attempt = (i) => {
            const cmd = candidates[i];
            const isLast = i === candidates.length - 1;
            // ponytail: 10s timeout per candidate — a hung systemctl/caddy
            // (stalled dbus, dead admin endpoint) delays the route, never
            // loses it: the snippet is already written (project rule 6).
            exec(cmd, { timeout: 10000 }, (err, stdout, stderr) => {
                if (!err) {
                    console.log('Caddy configuration reloaded successfully.');
                    return done();
                }
                // Shell exit 127 = binary missing (dev machine without
                // caddy/systemd): not worth logging. Remember the first
                // real failure so it's what ops sees if nothing works.
                if (err.code !== 127 && !failure) {
                    failure = `Caddy reload failed (${cmd}): ${(stderr || err.message).toString().trim()}`;
                }
                if (!isLast) return attempt(i + 1);
                if (failure) console.error(failure);
                done();
            });
        };
        attempt(0);
    }
}

module.exports = CaddyManager;
