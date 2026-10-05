# hrok

Expose a local TCP port on a public subdomain. A tiny self-hosted ngrok:
one Node server on your VPS behind Caddy (automatic HTTPS), one client
on your machine. Nothing else.

```
browser ─▶ https://myapp.example.com ─▶ Caddy ─▶ hrok server ══ws══▶ hrok client ─▶ localhost:3000
```

## Install the client

**Linux (x64)** — installs to `~/.local/bin`, no sudo:

```bash
curl -fsSL https://raw.githubusercontent.com/hmdlohar/hrok/main/install.sh | sh
```

**Windows (x64, PowerShell)** — installs to `%LOCALAPPDATA%\hrok` and adds it to PATH, no admin:

```powershell
irm https://raw.githubusercontent.com/hmdlohar/hrok/main/install.ps1 | iex
```

**Any OS with Node ≥20** (incl. macOS):

```bash
npm i -g @hmdlohar/hrok
```

Or grab `hrok` / `hrok.exe` from [Releases](https://github.com/hmdlohar/hrok/releases).
Re-running an installer upgrades in place.

## Use

```bash
hrok --server=ws://<VPS_IP>:8081 --local=3000 --subdomain=myapp
# -> https://myapp.<your-domain>
```

| Flag | Default | |
|---|---|---|
| `--server=` | `ws://localhost:8081` | your hrok server |
| `--local=` | `127.0.0.1:3000` | `PORT` or `HOST:PORT` to expose |
| `--subdomain=` | random | `a-z0-9-`, max 63 chars |

The client reconnects on its own and keeps its subdomain across blips.

## Run at startup

```bash
hrok --startup --server=ws://<VPS_IP>:8081 --local=3000 --subdomain=myapp
hrok --remove --subdomain=myapp
```

- **Windows:** service `hrok-myapp` (one UAC prompt).
- **Linux:** systemd unit (asks for sudo itself; don't type `sudo hrok`).
- **macOS:** launchd daemon (asks for sudo itself).
- **No sudo?** Add `--user` (Linux/macOS) for a per-user service. Pass
  `--user` to `--remove` too.

Same flags again with `--startup` replaces the service. Details and logs:
[SETUP.md §7–8](SETUP.md).

## Run the server

One VPS with a wildcard DNS record (`*.example.com`), Node 20, Caddy and
pm2. Step-by-step: [SETUP.md](SETUP.md). How it works:
[ARCHITECTURE.md](ARCHITECTURE.md).

## Develop

```bash
npm install
npm test               # end-to-end: real server + client, temp Caddyfile
npm run build:win      # dist/hrok.exe
npm run build:linux    # dist/hrok
```

Releases: push a `v*` tag; GitHub Actions builds both binaries and
attaches them to the release.

License: ISC
