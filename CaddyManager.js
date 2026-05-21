const { spawn, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

class CaddyManager {
    constructor(options = {}) {
        this.baseDomain = options.baseDomain || 'local.test';
        this.caddyPort = options.caddyPort || 8080;
        this.httpsEnabled = options.httpsEnabled || false;
        this.caddyfilePath = path.join(process.cwd(), 'Caddyfile');
        this.caddyProcess = null;
    }

    async start() {
        console.log('Starting Caddy server...');
        try {
            fs.writeFileSync(this.caddyfilePath, '');
            this.caddyProcess = spawn('caddy', ['run', '--config', this.caddyfilePath], {
                detached: true,
                stdio: 'ignore'
            });
            console.log('Caddy process started.');
        } catch (error) {
            console.error('Error starting Caddy:', error);
        }
    }

    stop() {
        if (this.caddyProcess) {
            console.log('Stopping Caddy process...');
            this.caddyProcess.kill('SIGTERM');
            this.caddyProcess = null;
        }
    }

    updateCaddyfile(tunnels) {
        let config = '';
        
        for (const [subdomain, port] of tunnels) {
            const protocol = this.httpsEnabled ? 'https://' : 'http://';
            const portSuffix = this.httpsEnabled ? '' : `:${this.caddyPort}`;
            const host = `${protocol}${subdomain}.${this.baseDomain}${portSuffix}`;
            
            config += `${host} {\n    reverse_proxy localhost:${port}\n}\n\n`;
        }

        try {
            fs.writeFileSync(this.caddyfilePath, config);
            this.reload();
        } catch (error) {
            console.error('Error writing Caddyfile:', error);
        }
    }

    reload() {
        try {
            execSync('caddy reload --config ' + this.caddyfilePath);
            console.log('Caddy configuration reloaded successfully.');
        } catch (error) {
            console.error('Caddy reload failed:', error);
        }
    }
}

module.exports = CaddyManager;
