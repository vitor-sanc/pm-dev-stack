#!/usr/bin/env bash
# Runs the deployed build as a systemd *user* service, so the UI is up whenever
# the machine (or WSL distribution) is, without a terminal kept open for it.
#
#   scripts/install-autostart.sh              install or update, then (re)start
#   scripts/install-autostart.sh --uninstall  stop and remove
#
# The service runs the build that scripts/deploy.sh makes in a separate deploy
# directory (DEPLOY_DIR, same default as there), so building or testing in this
# checkout never touches the running app. Server settings (HOST, SERVER_PORT,
# CLAUDE_CONFIG_DIR, ...) come from this checkout's .env, which the deploy
# directory links to. Linux and WSL with systemd enabled only.
#
# After changes land on main: scripts/deploy.sh
set -euo pipefail

SERVICE_NAME="${SERVICE_NAME:-pm-dev-stack}"
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEPLOY_DIR="${DEPLOY_DIR:-${XDG_DATA_HOME:-$HOME/.local/share}/$SERVICE_NAME/app}"
UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
UNIT_FILE="$UNIT_DIR/$SERVICE_NAME.service"

if ! command -v systemctl >/dev/null 2>&1 || ! systemctl --user show-environment >/dev/null 2>&1; then
  echo "systemd user services are not available here." >&2
  echo "On WSL, add 'systemd=true' under [boot] in /etc/wsl.conf, then run 'wsl --shutdown' from Windows." >&2
  exit 1
fi

if [[ "${1:-}" == "--uninstall" ]]; then
  systemctl --user disable --now "$SERVICE_NAME" 2>/dev/null || true
  rm -f "$UNIT_FILE"
  systemctl --user daemon-reload
  echo "Removed $SERVICE_NAME."
  exit 0
fi

if [[ ! -f "$DEPLOY_DIR/dist-server/server/index.js" ]]; then
  echo "No deployed build in $DEPLOY_DIR. Run scripts/deploy.sh first." >&2
  exit 1
fi

mkdir -p "$UNIT_DIR"
cat > "$UNIT_FILE" <<EOF
[Unit]
Description=PM Dev Stack from $DEPLOY_DIR
After=network.target

[Service]
Type=simple
WorkingDirectory=$DEPLOY_DIR
# An interactive bash, because most ~/.bashrc files return early otherwise: that
# is what puts nvm's node, the claude CLI and the variables you export in reach
# of every session started from the UI, exactly as in your terminal. Without a
# terminal, bash logs a harmless "no job control" warning at start.
ExecStart=/bin/bash -ic 'exec node dist-server/server/index.js'
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
EOF

systemctl --user daemon-reload
systemctl --user enable "$SERVICE_NAME" >/dev/null 2>&1
systemctl --user restart "$SERVICE_NAME"

# Without lingering, user services stop with the last login session and only
# come back at the next login; with it they start when the machine boots.
if [[ "$(loginctl show-user "$USER" -p Linger --value 2>/dev/null)" != "yes" ]]; then
  if ! loginctl enable-linger "$USER" 2>/dev/null; then
    echo "Note: run 'sudo loginctl enable-linger $USER' so the service also starts at boot."
  fi
fi

echo "$SERVICE_NAME is running. Logs: journalctl --user -u $SERVICE_NAME -f"
echo "After changes land on main: scripts/deploy.sh"
