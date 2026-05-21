# Project: Custom TCP Tunneling System (Ngrok-like)

## 📌 Overview
This project implements a robust, multi-client TCP tunneling system that allows exposing local services to the internet via a public server. It uses a **hybrid architecture**: a WebSocket-based "Control & Data Plane" for the tunnel itself, and a Caddy-based "Reverse Proxy" for domain-based routing.

## 🏗 Architecture & Design Choices

### 1. The Tunneling Logic (Layer 4)
The core tunnel is built on **WebSockets (`ws`)** instead of raw TCP for the client-to-server connection. 
- **Why?** WebSockets are more resilient to firewalls, handle heartbeats natively, and allow multiplexing multiple TCP sessions over a single connection.
- **The Data Flow:** `Public Request` $\rightarrow$ `Caddy` $\rightarrow$ `Node Server (TCP)` $\rightarrow$ `WebSocket (Base64 Encoded)` $\rightarrow$ `Client` $\rightarrow$ `Local Service (TCP)`.
- **Binary Data:** Since WebSockets can be interpreted as text, all raw TCP buffers are Base64 encoded to prevent data corruption during transit.

### 2. The Routing Layer (Layer 7)
The project uses **Caddy** as a reverse proxy.
- **Why Caddy?** Designing a high-performance, SSL-capable reverse proxy in Node.js is complex and prone to memory leaks. Caddy provides industry-standard performance, automatic ACME/SSL certificate management, and zero-downtime reloads.
- **Subdomain Mapping:** The server dynamically modifies a `Caddyfile` to map subdomains (e.g., `app1.local.test`) to internal TCP ports (e.g., `9000`).

### 3. Port Strategy
- **Signaling Port (8081):** Used exclusively for the WebSocket handshake and tunnel control.
- **Caddy Port (8080/80):** The public entry point for users.
- **Public Port Range (9000-9100):** Used internally by the server to create temporary TCP listeners that bridge to the specific WebSocket client.

## ⚠️ Caveats & Nuances

### SSL/TLS Development vs. Production
- **Development:** (`HTTPS_ENABLED=false`)forcing Caddy to use `http://` prefixes. Without this, Caddy attempts to use HTTPS by default, causing "Client sent HTTP request to HTTPS server" errors on non-standard ports.
- **Production:** (`HTTPS_ENABLED=true`) removes the protocol prefix and port, allowing Caddy to automatically provision SSL certificates on port 443.

### Local DNS Simulation
Since the system uses subdomains, it requires DNS resolution. For local development, each subdomain must be manually added to the `/etc/hosts` file because standard OS hosts files do not support wildcard entries (e.g., `*.local.test`).

### Process Lifecycle
The Node.js server acts as the "Master Process." It spawns Caddy as a child process and handles its lifecycle. If the server is terminated, it attempts to kill the Caddy process to avoid leaving orphaned listeners on port 8080.

## 🛠 Operational Guide for Agents
When extending this codebase:
1. **Adding Features:** If adding a new routing rule, ensure it is updated in `CaddyManager.js` and the `Caddyfile` is reloaded.
2. **Scaling:** The current system is limited by the `PORT_RANGE`. If more clients are needed, increase the range in `.env`.
3. **Stability:** Always use the `CaddyManager` for config changes; do not modify the `Caddyfile` manually while the server is running.
