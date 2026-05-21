const net = require('net');
const WebSocket = require('ws');
const CaddyManager = require('./CaddyManager');
require('dotenv').config();

const SIGNALING_PORT = parseInt(process.env.SIGNALING_PORT || 8081);
const PORT_RANGE_START = parseInt(process.env.PORT_RANGE_START || 9000);
const PORT_RANGE_END = parseInt(process.env.PORT_RANGE_END || 9100);
const BASE_DOMAIN = process.env.BASE_DOMAIN || 'local.test';
const HTTPS_ENABLED = process.env.HTTPS_ENABLED === 'true';
const CADDY_PORT = parseInt(process.env.CADDY_PORT || 8080);

const wss = new WebSocket.Server({ port: SIGNALING_PORT });
const clientTunnels = new Map(); // Maps publicPort -> { ws, publicServer, subdomain }
const subdomainMap = new Map(); // Maps subdomain -> publicPort

const caddy = new CaddyManager({
    baseDomain: BASE_DOMAIN,
    caddyPort: CADDY_PORT,
    httpsEnabled: HTTPS_ENABLED
});

caddy.start();

process.on('SIGINT', () => {
    caddy.stop();
    process.exit();
});

wss.on('connection', (ws) => {
    ws.on('message', (data) => {
        try {
            const msg = JSON.parse(data);
            if (msg.type === 'REQUEST_TUNNEL') {
                handleTunnelRequest(ws, msg.requestedSubdomain);
            }
        } catch (e) {}
    });

    ws.on('close', () => {
        // Find associated port for this ws and cleanup
        for (const [port, info] of clientTunnels) {
            if (info.ws === ws) {
                console.log(`Client on port ${port} (${info.subdomain}) disconnected`);
                info.publicServer.close();
                clientTunnels.delete(port);
                subdomainMap.delete(info.subdomain);
                
                const tunnelConfig = new Map();
                for (const [p, i] of clientTunnels) {
                    tunnelConfig.set(i.subdomain, p);
                }
                caddy.updateCaddyfile(tunnelConfig);
                break;
            }
        }
    });
});

function handleTunnelRequest(ws, requestedSubdomain) {
    let assignedPort = -1;
    for (let p = PORT_RANGE_START; p <= PORT_RANGE_END; p++) {
        if (!clientTunnels.has(p)) {
            assignedPort = p;
            break;
        }
    }

    if (assignedPort === -1) {
        ws.send(JSON.stringify({ type: 'ERROR', message: 'No public ports available' }));
        ws.close();
        return;
    }

    let finalSubdomain = requestedSubdomain || Math.random().toString(36).substring(2, 8);
    if (subdomainMap.has(finalSubdomain)) {
        finalSubdomain = `${finalSubdomain}-${Math.random().toString(36).substring(2, 4)}`;
    }
    
    const publicServer = net.createServer((socket) => {
        if (!ws || ws.readyState !== WebSocket.OPEN) {
            socket.destroy();
            return;
        }
        const session = Math.random().toString(36).substring(7);
        ws.send(JSON.stringify({ type: 'NEW_CONNECTION', sessionId: session }));
        socket.on('data', (data) => {
            ws.send(JSON.stringify({
                type: 'DATA',
                sessionId: session,
                payload: data.toString('base64')
            }));
        });
        socket.on('end', () => {
            ws.send(JSON.stringify({ type: 'CLOSE_CONNECTION', sessionId: session }));
        });
        socket.on('error', (err) => {
            console.error(`Public socket error on port ${assignedPort}:`, err);
        });
        ws.on('message', (msgData) => {
            try {
                const msg = JSON.parse(msgData);
                if (msg.type === 'DATA' && msg.sessionId === session) {
                    socket.write(Buffer.from(msg.payload, 'base64'));
                }
            } catch(e) {}
        });
    });

    publicServer.listen(assignedPort);
    clientTunnels.set(assignedPort, { ws, publicServer, subdomain: finalSubdomain });
    subdomainMap.set(finalSubdomain, assignedPort);

    const tunnelConfig = new Map();
    for (const [port, info] of clientTunnels) {
        tunnelConfig.set(info.subdomain, port);
    }
    caddy.updateCaddyfile(tunnelConfig);

    ws.send(JSON.stringify({ 
        type: 'TUNNEL_ASSIGNED', 
        publicPort: assignedPort,
        subdomain: finalSubdomain,
        fullUrl: `${HTTPS_ENABLED ? 'https' : 'http'}://${finalSubdomain}.${BASE_DOMAIN}${HTTPS_ENABLED ? '' : ':' + CADDY_PORT}`
    }));

    console.log(`Client assigned port ${assignedPort} and subdomain ${finalSubdomain}.`);
}
