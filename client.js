const net = require('net');
const WebSocket = require('ws');

const args = process.argv.slice(2);
const serverArg = args.find(a => a.startsWith('--server='));
const localArg = args.find(a => a.startsWith('--local='));
const subdomainArg = args.find(a => a.startsWith('--subdomain='));

const SERVER_URL = serverArg ? serverArg.split('=')[1] : 'ws://localhost:8080';
const LOCAL_TARGET_PORT = localArg ? parseInt(localArg.split('=')[1]) : 3000;
const REQUESTED_SUBDOMAIN = subdomainArg ? subdomainArg.split('=')[1] : null;

const ws = new WebSocket(SERVER_URL);
const activeConnections = new Map();

console.log(`Connecting to signaling server at ${SERVER_URL}...`);

ws.on('open', () => {
    console.log('Connected to signaling server');
    // Request a tunnel immediately
    ws.send(JSON.stringify({ 
        type: 'REQUEST_TUNNEL', 
        requestedSubdomain: REQUESTED_SUBDOMAIN 
    }));
});

ws.on('message', (data) => {
    const msg = JSON.parse(data);

    if (msg.type === 'TUNNEL_ASSIGNED') {
        console.log(`\x1b[32mTunnel established!\x1b[0m`);
        console.log(`Public URL: ${msg.fullUrl}`);
        console.log(`Local Port: ${LOCAL_TARGET_PORT}`);
    } else if (msg.type === 'NEW_CONNECTION') {
        const { sessionId } = msg;

        const localSocket = net.connect(LOCAL_TARGET_PORT, () => {
            // Connection established
        });

        activeConnections.set(sessionId, localSocket);

        localSocket.on('data', (buffer) => {
            ws.send(JSON.stringify({
                type: 'DATA',
                sessionId,
                payload: buffer.toString('base64')
            }));
        });

        localSocket.on('end', () => {
            activeConnections.delete(sessionId);
        });

        localSocket.on('error', (err) => {
            activeConnections.delete(sessionId);
        });
    } else if (msg.type === 'DATA') {
        const { sessionId, payload } = msg;
        const localSocket = activeConnections.get(sessionId);
        if (localSocket) {
            localSocket.write(Buffer.from(payload, 'base64'));
        }
    } else if (msg.type === 'CLOSE_CONNECTION') {
        const { sessionId } = msg;
        const localSocket = activeConnections.get(sessionId);
        if (localSocket) {
            localSocket.destroy();
            activeConnections.delete(sessionId);
        }
    } else if (msg.type === 'ERROR') {
        console.error(`Server Error: ${msg.message}`);
        process.exit(1);
    }
});

ws.on('close', () => {
    console.log('Disconnected from signaling server');
    process.exit(1);
});
