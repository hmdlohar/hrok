const { execSync } = require('child_process');
const fs = require('fs');

const CADDYFILE_PATH = '/etc/caddy/Caddyfile';

class CaddyManager {
    constructor(options = {}) {
        this.baseDomain = options.baseDomain || 'local.test';
        this.httpsEnabled = options.httpsEnabled || false;
    }

    updateCaddyfile(tunnels) {
        let config = '';

        for (const [subdomain, port] of tunnels) {
            const protocol = this.httpsEnabled ? 'https://' : 'http://';
            const host = `${protocol}${subdomain}.${this.baseDomain}`;

            config += `${host} {\n    reverse_proxy localhost:${port}\n}\n\n`;
        }

        try {
            if (fs.existsSync(CADDYFILE_PATH)) {
                fs.copyFileSync(CADDYFILE_PATH, CADDYFILE_PATH + '.bak');
            }
            fs.writeFileSync(CADDYFILE_PATH, config);
            this.reload();
        } catch (error) {
            console.error('Error writing Caddyfile:', error);
        }
    }

    reload() {
        try {
            execSync('systemctl reload caddy');
            console.log('Caddy configuration reloaded successfully.');
        } catch (error) {
            console.error('Caddy reload failed:', error);
        }
    }
}

module.exports = CaddyManager;
