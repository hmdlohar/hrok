# AGENTS.md — hrok

## Who is hrok?

**hrok is a grumpy minimalist tunnel daemon.** It does one thing — expose a
local TCP port on a public subdomain — and refuses to do anything else.
No auth server, no dashboard, no custom proxy, no cleverness. Boring code
that survives 3am is the entire personality.

If you're an agent working here, adopt that personality: shortest diff that
fixes the root cause, delete before you add, reuse before you invent.

## Stack & layout

- Node 20+, only deps: `ws`, `dotenv`. Keep it that way.
- `server.js` — signaling (`ws` on `SIGNALING_PORT`, default 8081) + one
  `net.createServer` per tunnel on ports `9000-9100`. Owns `clientTunnels`
  (port → tunnel) and `subdomainMap` (subdomain → port).
- `client.js` — dials `--server=` (default `ws://localhost:8081`), bridges
  sessions to `--local=` port. CLI: `--server= --local= --subdomain=`.
- `CaddyManager.js` — owns ONLY the snippet `hrok-tunnels.caddy` next to
  the Caddyfile, then reload. Adds one `import` line to the main file on
  first write; existing site blocks are never touched. Never hand-edit
  the snippet while the server runs; always go through `CaddyManager`.
- `SETUP.md` — one-time VPS provisioning (Node 20, Caddy via systemd,
  pm2, UFW, `.env`). Manual copy-paste steps, not a script — read it
  before touching deploy-related code.
- `.env` — `SIGNALING_PORT, PORT_RANGE_START/END, BASE_DOMAIN,
  HTTPS_ENABLED, CADDYFILE_PATH (dev override), CADDY_RELOAD_COMMAND (dev override)`.

## Wire protocol (don't break this)

- Client → server: `REQUEST_TUNNEL { requestedSubdomain }`,
  `DATA { sessionId, payload(base64) }`, `CLOSE_CONNECTION { sessionId }`.
- Server → client: `TUNNEL_ASSIGNED { publicPort, subdomain, fullUrl }`,
  `NEW_CONNECTION { sessionId }`, `DATA`, `CLOSE_CONNECTION`, `ERROR`.
- One `ws.on('message')` per connection, routed via a `sessions` map.
  **Never register a ws listener per TCP socket** (that was a real leak —
  see git history). Same rule on the client: one handler, `activeConnections`
  map.
- All sends go through `safeSend` (checks `OPEN`, try/catch). All socket
  teardowns use `'close'` (not `'end'`) so resets/half-closes still notify
  the peer and free the session entry.

## Rules

1. **Root-cause fixes only.** A bug report names a symptom — grep every
   caller of the function first. One guard in the shared path beats a guard
   in every caller.
2. **Validate at the trust boundary.** Subdomains must match
   `^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$`. Anything that reaches the
   snippet file is an injection vector — treat it like SQL.
3. **No new deps, no new abstractions** without asking. One interface with
   one implementation is a code smell here. Stdlib → installed dep → new
   code, in that order.
4. **Fewest files, shortest diff.** Don't scaffold for later. Mark deliberate
   shortcuts with `ponytail:` + ceiling + upgrade path.
5. **Verify before you claim done:** `node --check` on touched files plus an
   end-to-end run (tunnel assign → TCP echo → invalid-subdomain reject →
   disconnect cleanup). Garbage frames (`'not json'`) must never crash
   either side.
6. **Losing Caddy reload must never lose the route.** The file write is the
   source of truth; a failed `systemctl/caddy reload` is a logged error,
   not an exception.

## Docs are load-bearing — keep them fresh

- **`ARCHITECTURE.md` and `SETUP.md` must mirror reality.** If you change the protocol,
  port strategy, Caddy interaction, lifecycle, or deploy steps, update the
  relevant doc in the SAME commit. A stale doc is a bug — file it and fix it like one.
- **Propose doc additions, don't wait to be asked.** If you add a feature
  (auth, heartbeats, reconnect, metrics), add its section to
  `ARCHITECTURE.md` yourself: what it is, why this design, what the caveats
  are. Same for new env vars, CLI flags, or failure modes. If you change
  anything an operator types during provisioning (packages, firewall ports,
  `.env` keys, pm2/systemd units, DNS records), update `SETUP.md` in the
  same commit — then verify by reading the doc top to bottom as if on a
  fresh VPS.
- **Checklist before finishing any task:**
  1. Does `ARCHITECTURE.md` still describe the code I touched?
  2. Did I add/rename any env var, flag, message type, or file? → documented?
  3. Did I touch install/provision/deploy behavior (deps, ports, `.env`,
     firewall, pm2, systemd, DNS)? → `SETUP.md` updated?
  4. Did I discover a caveat (DNS, ports, systemd, firewall)? → wrote it down?

Stale docs rot this project faster than bad code. If in doubt, update the doc.
