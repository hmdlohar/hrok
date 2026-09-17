# hrok — VPS Setup

One-time provisioning. ~10 minutes on a fresh VPS, less on one that
already runs Caddy (see §2b).
Debian/Ubuntu commands shown; other distros need manual equivalents.

You need: root (or sudo), a domain whose DNS you control, a VPS IP.

## 0. DNS first (so ACME works later)

At your registrar, point both records at the VPS IP:

```
A  @          -> <VPS_IP>
A  *.<domain> -> <VPS_IP>
```

Get the IP with `hostname -I | awk '{print $1}'`.

## 1. Node.js 20

Skip if `node -v` is already v18+.

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo bash -
sudo apt-get install -y nodejs
node -v
```

Non-Debian distros: install Node 20+ from your package manager, then
continue below.

## 2. Caddy (systemd-owned)

Skip if `caddy version` already works.

```bash
sudo apt-get install -y debian-keyring debian-archive-keyring apt-transport-https curl
sudo install -m 0755 -d /usr/share/keyrings
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
  | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
  | sudo tee /etc/apt/sources.list.d/caddy-stable.list >/dev/null
sudo apt-get update
sudo apt-get install -y caddy
```

Enable + start the service. **On a fresh VPS this blanks
`/etc/caddy/Caddyfile` — back it up first if the machine already
serves something:**

```bash
sudo cp /etc/caddy/Caddyfile /etc/caddy/Caddyfile.orig  # if it has content
echo "" | sudo tee /etc/caddy/Caddyfile
sudo systemctl enable caddy
sudo systemctl restart caddy
```

## 2b. Caddy already serving something? (coexist, don't wipe)

**Skip the blanking step above.** hrok never rewrites your Caddyfile —
it writes only its own snippet (`/etc/caddy/hrok-tunnels.caddy`) and
adds one `import` line to your existing file. Your site blocks are left
alone.

What you must do manually, once:

1. Pick a domain (or subdomain) for tunnels that does NOT collide with
   existing sites, e.g. tunnels on `*.tun.example.com` while your app
   serves `app.example.com`. Add the wildcard DNS:
   `A *.tun.example.com -> <VPS_IP>`.
2. Make sure that domain isn't already claimed by an existing site block
   (Caddy routes by hostname — first match wins, duplicates warn).
3. Use that domain as `BASE_DOMAIN` in §3 below. On first tunnel the
   server appends `import /etc/caddy/hrok-tunnels.caddy` to your
   Caddyfile and reloads — verify with
   `caddy fmt --overwrite /etc/caddy/Caddyfile && systemctl reload caddy`
   if the reload ever complains.

Optional, lets Caddy bind :80/:443 without root:

```bash
sudo setcap 'cap_net_bind_service=+ep' "$(command -v caddy)"
```

## 3. hrok server

```bash
git clone <repo-url> /opt/hrok   # or wherever you keep it
cd /opt/hrok
npm install
```

Write `.env` (production values — note `HTTPS_ENABLED=true` so Caddy
provisions ACME certs on :443):

```
SIGNALING_PORT=8081
PORT_RANGE_START=9000
PORT_RANGE_END=9100
BASE_DOMAIN=<your-domain>
HTTPS_ENABLED=true
```

## 4. Firewall

Skip if you don't use UFW. **Order matters: allow SSH before enabling,
or you lock yourself out.**

```bash
sudo ufw allow OpenSSH   # or: sudo ufw allow 22/tcp
sudo ufw --force enable
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw allow 8081/tcp  # signaling; clients dial this
```

`9000-9100` stays localhost-only (Caddy dials it). Never expose it.

## 5. Run the server under pm2

```bash
sudo npm install -g pm2
pm2 start /opt/hrok/server.js --name hrok --cwd /opt/hrok
pm2 save
pm2 startup systemd -u root --hp /root  # prints a command — run it
```

## 6. Verify

```bash
pm2 status          # hrok should be online
pm2 logs hrok       # watch for "Client assigned port ..."
systemctl is-active caddy
```

From your laptop:

```bash
node client.js --server=ws://<VPS_IP>:8081 --local=3000 --subdomain=myapp
# visit https://myapp.<your-domain>
```

## Maintenance

- Update: `cd /opt/hrok && git pull && npm install && pm2 restart hrok`.
- Change domain/port range: edit `.env`, then `pm2 restart hrok`.
- Logs: `pm2 logs hrok`. Status: `pm2 status`.
- Caddy routes live in `/etc/caddy/hrok-tunnels.caddy` (auto-imported
  from your Caddyfile) — never hand-edit that snippet while hrok runs.
  Your own site blocks are untouched.
