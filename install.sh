#!/bin/sh
# hrok installer (Linux x64). No sudo; installs to ~/.local/bin.
#   curl -fsSL https://raw.githubusercontent.com/hmdlohar/hrok/main/install.sh | sh
# Re-run to upgrade. HROK_DIR=/some/dir overrides the install dir.
set -eu
DIR="${HROK_DIR:-$HOME/.local/bin}"
URL="https://github.com/hmdlohar/hrok/releases/latest/download/hrok"

case "$(uname -s)-$(uname -m)" in
    Linux-x86_64|Linux-amd64) ;;
    *) echo "hrok: no prebuilt binary for $(uname -s) $(uname -m). Use: npm i -g @hmdlohar/hrok" >&2; exit 1 ;;
esac

mkdir -p "$DIR"
echo "Downloading $URL"
curl -fL --progress-bar "$URL" -o "$DIR/hrok.tmp"
chmod +x "$DIR/hrok.tmp"
# mv, not overwrite: a running service keeps the old inode; restart it to upgrade.
mv -f "$DIR/hrok.tmp" "$DIR/hrok"
echo "Installed $DIR/hrok"

case ":$PATH:" in
    *":$DIR:"*) ;;
    *) echo "Add it to PATH (e.g. in ~/.bashrc):  export PATH=\"$DIR:\$PATH\"" ;;
esac
echo "Run:      hrok --server=ws://<VPS_IP>:8081 --local=3000 --subdomain=myapp"
echo "Service:  hrok --startup --user --server=... --local=3000 --subdomain=myapp"
