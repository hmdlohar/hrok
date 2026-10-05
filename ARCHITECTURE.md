# hrok — Architecture

hrok exposes a local TCP port on a public subdomain.
One WebSocket carries signaling + all tunnel data; Caddy routes public
HTTP to per-tunnel TCP listeners. That's the whole system.

## Data flow

```
public request
  -> Caddy (:80/:443, subdomain match)
  -> 127.0.0.1:<9xxx> (one net.createServer per tunnel, server.js)
  -> WebSocket DATA frame (base64 payload) -> client.js
  -> 127.0.0.1:<--local port> (local service)
```

Return path is the reverse. One client WebSocket multiplexes N public
TCP sessions via `sessionId`.

## Components

- **`server.js`** — `ws` signaling server on `SIGNALING_PORT` (default
  8081) + one `net.createServer` per tunnel on `PORT_RANGE_START..END`
  (default 9000-9100, i.e. max 101 tunnels), bound to `127.0.0.1` only —
  Caddy is the sole public entry point. Owns two maps:
  `clientTunnels` (port → `{ ws, publicServer, subdomain, publicPort }`)
  and `subdomainMap` (subdomain → port). Regenerates the `hrok-tunnels.caddy`
  snippet from `clientTunnels` on every successful bind/disconnect
  (`syncCaddy`).
- **`client.js`** — dials `--server=` (default `ws://localhost:8081`),
  sends `REQUEST_TUNNEL`, bridges each `NEW_CONNECTION` to
  `--local=` (`PORT` or `HOST:PORT`, default `127.0.0.1:3000`). Tracks
  sessions in `activeConnections` (sessionId →
  `{ sock, connected, pending, dead, sent }`). Reconnects with backoff on
  drop; watchdog kills half-open links. Runs well as a service
  (`--startup` on Windows/Linux/macOS — see Service & distribution).
- **`CaddyManager.js`** — owns ONLY the snippet file next to the
  Caddyfile (`hrok-tunnels.caddy`), regenerating it from `clientTunnels`
  on every assign/disconnect (`.bak` kept). On first write it appends a
  single `import <snippet>` line to the main Caddyfile if missing — your
  existing site blocks are never rewritten or deleted, so hrok coexists
  with a Caddy that's already serving something. Then reloads: explicit
  `CADDY_RELOAD_COMMAND` → `systemctl reload caddy` (the production path:
  pm2 runs as root, Caddy is systemd-owned) → `caddy reload --config
  <CADDYFILE_PATH>` (same running Caddy via its admin API, for when
  systemctl isn't usable). Reloads are **async and serialized**: never
  block the event loop every tunnel relays through; a change during a
  reload queues exactly one follow-up reload, which reads the latest
  snippet. 10s timeout per candidate. Missing binaries (shell exit 127)
  are silent; otherwise the first real failure is logged — never an
  exception. **The snippet write (synchronous) is the source of truth.**
  Path overridable via `CADDYFILE_PATH` env (default `/etc/caddy/Caddyfile`).
- **`SETUP.md`** — one-time VPS provisioning (Node 20, Caddy via systemd,
  pm2, UFW, `.env`, DNS). Manual steps, not a script. Update it in the
  same commit if you change anything an operator types during
  provisioning.

## Wire protocol

JSON text frames. All payloads base64 (we send JSON, not binary frames,
so raw TCP bytes must be encoded; ~33% overhead, accepted deliberately).

| Direction | Type | Fields | Meaning |
|---|---|---|---|
| C→S | `REQUEST_TUNNEL` | `requestedSubdomain?` | Ask for a tunnel |
| S→C | `TUNNEL_ASSIGNED` | `publicPort, subdomain, fullUrl` | Tunnel ready |
| S→C | `NEW_CONNECTION` | `sessionId` | New public TCP hit, dial local |
| both | `DATA` | `sessionId, payload(b64)` | Bytes for that session |
| both | `CLOSE_CONNECTION` | `sessionId` | Peer closed, free the session |
| S→C | `ERROR` | `message` | Rejected tunnel (`Invalid subdomain`, `No public ports available`, `Failed to bind public port`) — server closes the ws ~50ms later so the frame flushes; the client treats it as fatal |

 CLI: `node client.js --server=ws://IP:8081 --local=3000 --subdomain=myapp`.
 `requestedSubdomain` empty → server assigns a random 6-char one.
 Only the first `REQUEST_TUNNEL` per connection counts; repeats are
 ignored (one tunnel per ws, so one socket can't drain the port pool).
 Flag values are everything after the first `=`.
 `--local` accepts `PORT` or `HOST:PORT` (default `127.0.0.1:3000`,
 invalid → that default). Extra verbs: `--startup` / `--remove`
 (see Service & distribution).

 ## Heartbeat & reconnect (service readiness)

 NATs, firewalls, and dead peers silently drop idle TCP. hrok detects
 that instead of serving a dead tunnel:

 - **Server → client:** `ws.ping()` every 30s (`HEARTBEAT_INTERVAL`).
   Each connection tracks `ws.isAlive`; a missed `pong` marks it dead,
   the next tick `terminate()`s it, and the normal `close` path frees
   the tunnel + Caddy routes. `ws` auto-replies pong — no app frames,
   no protocol change.
 - **Client watchdog:** the client can't trust `readyState` on a
   half-open link, so it timestamps every inbound frame (`ping`, `pong`,
   `message`). 75s of total silence (`HEARTBEAT_TIMEOUT`) → it
   `terminate()`s the socket, which triggers the reconnect path below.
 - **Client reconnect:** any non-fatal close → fresh `connect()` with
   backoff `min(1s * 2^attempt, 30s) + <1s jitter`, re-sends
   `REQUEST_TUNNEL`, reclaims the same subdomain. Without `--subdomain`
   the client remembers the random name it was assigned and re-requests
   it, so the URL (and its ACME cert — Let's Encrypt rate-limits new
   names) survives blips. If the server hasn't noticed the old ws is
   dead yet, it probes the owner (see Validation & collisions). `ERROR` from the server is fatal — retrying
   a rejected subdomain/empty pool is pointless, so the client exits 1
   and lets the process manager (pm2/systemd) surface it. `SIGINT/SIGTERM`
   shut down cleanly (destroy local sockets, close ws, exit).
  - **Local app down is not fatal.** Each `NEW_CONNECTION` dials
    `--local` fresh, so a down app just refuses that session (public side
    sees a fast close, ~10ms) and the *next* hit redials. Start the app
    later and the tunnel works with zero intervention. This is what makes
   the client safe to run as a service against port 4222 or anything else.
  - **Burst dial RSTs get one retry.** Fragile local servers (xpra's
    Python web server: `request_queue_size=5`) reset bursts of
    simultaneous dials — on Windows backlog overflow is an instant RST,
    which Caddy reports as a random subset of instant 502s on asset-heavy
    pages. The client retries the dial once after 50ms
    (`DIAL_RETRIES`/`DIAL_RETRY_MS`) for transient OS errors
    (`ECONNREFUSED/ECONNRESET/ECONNABORTED`), buffering request bytes in
    `st.pending` until a dial sticks (flushed atomically with the
    `connected` flag so ws/socket event interleaving can't reorder the
    request). No response bytes relayed yet (`sent === 0`) is a retry
    precondition — a mid-stream reset is the local server's own failure
    and is surfaced as-is. Dial failures are logged with the OS error
    code; the retry is absorbed silently.

 ## Service & distribution (`--startup` / `--remove`)

 Two ways to ship the client, same CLI:

 - **Exe** (`dist/hrok.exe`, no Node needed) — details below.
 - **npm** (`npm i -g @hmdlohar/hrok`, needs Node ≥20). `package.json` `files`
   publishes only `client.js`. The service command line is then
   `node <realpath of client.js> <flags>` instead of the exe
   (`SELF` in client.js; `process.pkg` tells the two apart). Caveats:
   the service pins the absolute node path, so switching Node versions
   (nvm) or reinstalling Node means `--startup` again. `npm i -g @hmdlohar/hrok`
   upgrades in place — restart the service to pick it up. `--startup`
   from `npx` refuses (its cache dir gets cleaned → dead service).

 `--startup` registers a boot-time service per OS, native tools only:

 - **Linux (systemd):** `/etc/systemd/system/hrok-<sub>.service`,
   `User=$SUDO_USER`, `Restart=always`, `RestartSec=30`,
   `enable --now`. Non-root re-execs itself under `sudo`. Args are
   quoted in `ExecStart` with `%`→`%%`, `$`→`$$`; control chars in
   flags are rejected up front (no line injection into the unit).
   Logs: `journalctl -u hrok-<sub>`. No systemd (Alpine, old WSL) →
   exit 1, use pm2.
 - **macOS (launchd):** `/Library/LaunchDaemons/hrok-<sub>.plist`,
   `UserName` = `$SUDO_USER`, `RunAtLoad` + `KeepAlive`,
   `ThrottleInterval 30`, loaded with `launchctl bootstrap system`.
   Logs: `/var/log/hrok-<sub>.log` (pre-created, chowned to the user).
   ponytail: untested on real macOS hardware — verify on first Mac user.
 - **Windows (WinSW):** below. Daemon dir is `<exe dir>\daemon\` for
   the exe, `%ProgramData%\hrok\` under npm (not Node's install dir).
 - **`--user` (Linux/macOS, no sudo):** per-user unit instead —
   `~/.config/systemd/user/hrok-<sub>.service` (`systemctl --user`,
   `WantedBy=default.target`, no `User=`/network-online: user managers
   can't see system targets, the client's reconnect covers it) or
   `~/Library/LaunchAgents/hrok-<sub>.plist` (`launchctl bootstrap
   gui/<uid>`, logs `~/Library/Logs/hrok-<sub>.log`). Starts at login,
   not boot. Linux: hrok runs `loginctl enable-linger` (self-allowed by
   polkit on most distros) so it starts at boot and survives logout; if
   that's denied it prints the `sudo loginctl enable-linger` hint.
   macOS has no linger — LaunchAgents need a login. Windows: `--user`
   exits 1 (an HKCU Run key has no crash restart and shows a console
   window; not worth it — use the UAC service).
 - **sudo + nvm:** the root re-exec is `sudo <abs node> <abs client.js>`
   (`SELF`), never `sudo hrok`, so sudo's `secure_path` never needs to
   find an nvm node in `$HOME`. Users must not type `sudo hrok`
   themselves — run `hrok --startup`, it elevates itself.
 - All of them: `--startup` again replaces the service with new flags;
   `--remove` (with the same `--user`/no `--user`) stops + deletes it.

 Windows details:

 - **Packaging:** `@yao-pkg/pkg` (maintained fork of vercel/pkg) bundles
   client.js + Node 22 into one exe. `npm run build:win` (also
   `build:linux` for a raw binary). `package.json` `pkg.assets` embeds
   node-windows' `winsw.exe` + `.config` verbatim inside the exe.
   pkg's babel warnings about the binary are cosmetic noise.
 - **`hrok --startup --server=... --local=... --subdomain=...`**
   installs and starts a service named `hrok-<subdomain>` (or plain
   `hrok` without one). The service command line is THIS exe plus the
   tunnel flags — so the reconnect/heartbeat logic IS the service logic.
 - **WinSW, not node-windows' Service class.** A plain exe can't be a
   service (SCM protocol), so the SCM wrapper is unavoidable. We use the
   WinSW binary vendored in node-windows' `bin/` but generate the XML
   ourselves and skip node-windows' `Service` class entirely: that class
   wraps your script in its own wrapper.js and `child_process.fork`s it —
   which doesn't survive pkg packaging (virtual `/snapshot/` paths).
   `require.resolve('node-windows/bin/winsw/winsw.exe')` +
   `fs.readFileSync` works under both node and pkg (readFileSync reads
   from pkg's virtual fs; copyFileSync does not). Files land in
   `<exe dir>\daemon\`: `<id>.exe` (WinSW copy), `<id>.xml` (config),
   `<id>.out.log` / `.err.log` (rotating service logs).
 - **UAC:** non-admin run relaunches itself once via PowerShell
   `Start-Process -Verb RunAs -Wait` (single prompt; no node-windows
   elevate dependency). The elevated copy does the work, the parent
   verifies with `sc query` and reports.
 - **Boot + crash recovery:** `sc config start= auto` for boot survival;
   `sc failure ... restart/30000` ×3 for crash recovery. The bundled
   WinSW 1.x predates `<onfailure>`, so recovery lives in the SCM.
   ponytail caveat: a permanently-fatal config (e.g. rejected subdomain)
   restart-loops every 30s by design — the `.err.log` shows why; fix
   flags with `--startup` again or `--remove`.
 - **Idempotent:** `--startup` over an existing service stops, uninstalls,
   reinstalls with the new flags. `--remove` stops, uninstalls, deletes
   the daemon dir files (dir kept if another `hrok-*` service shares it).
 - **Subdomain validated before install** (same regex as the server) — a
   bad one would just restart-loop forever as a service.
 - **Releases:** GitHub Action (`.github/workflows/release.yml`) builds
   `hrok.exe` + the Linux x64 binary `hrok` on `v*` tags and attaches
   both to a GitHub release
   (`git tag v1.0.0 && git push origin v1.0.0`).

 ## Concurrency model (read this before touching it)

- **One `ws.on('message')` per connection, on both sides.** The server
  routes via a per-connection `sessions` map (sessionId → public socket);
  the client via `activeConnections`. Never register a ws listener per
  TCP socket — that was a real listener leak, fixed once, don't reintroduce.
- **All sends go through `safeSend`** (checks `OPEN`, try/catch, returns
  bool). Never raw `ws.send` on a socket that may be dead.
- **Teardown uses `'close'`, not `'end'`.** Resets and half-closes skip
  `'end'`; `'close'` always fires, so both sides free the session entry
  and notify the peer exactly once (`endSession` dead-flag guard on the
  client, `sessions.delete` guard on the server). On the client, only the
  live dial generation's `close` ends a session: a retried dial clears
  `st.sock` first so the failed generation's `close` can't end it.
- **Garbage frames are ignored.** `JSON.parse` is wrapped; non-objects
  and unknown shapes return early. Neither side crashes on `'not json'`.

## Validation & collisions

- Subdomains must match `^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$`, enforced
  in `handleTunnelRequest` before anything touches the snippet (the
  snippet is an injection vector — treat subdomain input like SQL).
- Requested name taken → server pings the current owner (`probeOwner`,
  3s `PROBE_TIMEOUT`). No pong → owner is a half-open leftover (typically
  the same client reconnecting before the 30-60s heartbeat reaped it):
  it's terminated and the name handed over. Pong → owner is live, the
  claimant gets a `-xx` suffix (truncated to 63 chars), then random
  names until free. No auth means a live owner is never displaced.
- Port and subdomain are reserved synchronously (`bindTunnel`), then
  the server listens; `TUNNEL_ASSIGNED` and the snippet sync happen
  only in the `listen` callback. `EADDRINUSE` (a foreign process inside
  the range) releases the reservation and tries the next port. Any other
  bind error or exhaustion → `ERROR` + close. A ws that closes mid-bind
  has its server closed in the `listen` callback.

## Config

`.env` (server):

| Var | Default | Notes |
|---|---|---|
| `SIGNALING_PORT` | `8081` | Client `--server=` must match. Non-integer port vars → exit 1 at startup |
| `PORT_RANGE_START/END` | `9000/9100` | Inclusive; raise for >101 tunnels |
| `BASE_DOMAIN` | `local.test` | `SETUP.md` writes the real domain |
| `HTTPS_ENABLED` | `false` | `false` → `http://` hosts; `true` → `https://`, Caddy does ACME on :443 |
| `CADDYFILE_PATH` | `/etc/caddy/Caddyfile` | Dev override (e.g. a temp file) |
| `CADDY_RELOAD_COMMAND` | — | Dev override (e.g. `true` to skip reload) |

Note: some dev `.env` files contain a legacy `CADDY_PORT=8080`. It is
**unused** — nothing in the code reads it. Safe to delete.

## Lifecycle

1. Client connects → `REQUEST_TUNNEL` → server binds a port, maps the
   subdomain, writes the snippet, kicks off an async reload, replies
   `TUNNEL_ASSIGNED` (the route goes live once the reload completes,
   typically well under a second later).
2. Public TCP hit → server mints a `sessionId`, stores the socket,
   sends `NEW_CONNECTION`; client dials local, both sides stream `DATA`.
3. Either side's socket closes → `CLOSE_CONNECTION`, both entries freed.
4. Client ws closes → server destroys that ws's session sockets, closes
   its public servers, deletes map entries, regenerates the snippet (routes
   disappear). Caddy keeps running — only the snippet changes. Dead-peer
   detection (missed pong) lands here too — same cleanup path.
5. Client reconnects (backoff), re-sends `REQUEST_TUNNEL`, reclaims the
   same subdomain, routes reappear.

## Caveats & deliberate non-features

- **No auth.** Anyone who can reach the signaling port can claim any free
  subdomain (one per connection, but many connections still drain the
  pool). Don't expose it to the open internet without a firewall/VPN.
- **No reconnect on the server side, none needed.** The server never dials
  out; it just reaps dead peers (heartbeat) and waits. The client owns
  reconnect.
- **Local `--local` host binding:** `--local=4222` binds `127.0.0.1:4222`.
  Use `--local=0.0.0.0:4222` only if the app listens on a LAN interface.
- **Half backpressure.** Both sides pause the TCP socket feeding the ws
  while `ws.bufferedAmount > 1MB` and resume when that socket's frame
  flushes. The other half — a slow *reader* (public client on the
  server, local app on the client) — still buffers in memory: fixing it
  needs PAUSE/RESUME frames (protocol change) or `ws.pause()` (stalls
  every session). Marked `ponytail:` in both files.
- **Local DNS:** `/etc/hosts` has no wildcards, so each dev subdomain needs
  its own line (`127.0.0.1 myapp.local.test`). Production uses a real
  wildcard A record (`*.<domain> → VPS IP`).
 - **Caddy coexistence:** only `hrok-tunnels.caddy` is regenerated; your
   own site blocks are never touched. Use a separate `BASE_DOMAIN`
   (e.g. `tun.example.com`) so tunnel hostnames can't collide with
   existing sites. See `SETUP.md §2b`.
- **Firewall:** signaling port must be reachable by clients; `9000-9100`
  only needs localhost (Caddy dials it) and the server binds them to
  `127.0.0.1` anyway. `SETUP.md` opens `22/80/443/8081`.

## Verify a change

```
node --check server.js client.js CaddyManager.js e2e.js
npm test   # e2e.js: assign + echo, port-conflict skip, loopback-only
           # bind, invalid subdomain, one tunnel per ws, garbage frame,
           # dead-owner takeover, disconnect cleanup
# still manual: assign tunnel -> TCP echo through it ->
# invalid subdomain rejected+closed -> disconnect removes route ->
# garbage frame ('not json') crashes nothing ->
# local down (fast close) -> local up (works, no restart) ->
# server kill -> client reconnects + reclaims subdomain
# if client.js touched: npm run build:linux and rerun the above
# through dist/hrok (the exe); service verbs: hrok --startup ... ->
# systemctl status hrok-<sub> -> hrok --remove ... (sudo prompt)
```

If your change touches the protocol, ports, Caddy interaction, lifecycle,
env vars, flags, or failure modes, update this file in the same commit.
See `AGENTS.md`.
