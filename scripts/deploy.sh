#!/usr/bin/env bash
# Builds a commit of this repo in a separate deploy directory and points the
# systemd user service at it, so building or testing in this checkout never
# changes the app that is running.
#
#   scripts/deploy.sh                 deploy main, restart if no Shell is live
#   scripts/deploy.sh <ref>           deploy another commit, branch or tag
#   scripts/deploy.sh --force [<ref>] restart even if Shell processes are live
#
# The deploy directory is a detached git worktree of this repo
# (DEPLOY_DIR, default ~/.local/share/<service>/app). Its .env is a link to this
# checkout's .env, so settings live in one place. Restarting the service kills
# every live Shell process, so without --force the restart is skipped while any
# is running and the new build waits for: systemctl --user restart <service>
set -euo pipefail

SERVICE_NAME="${SERVICE_NAME:-pm-dev-stack}"
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEPLOY_DIR="${DEPLOY_DIR:-${XDG_DATA_HOME:-$HOME/.local/share}/$SERVICE_NAME/app}"

FORCE=false
if [[ "${1:-}" == "--force" ]]; then
  FORCE=true
  shift
fi
REF="${1:-main}"

fail() {
  echo "✖ $*" >&2
  exit 1
}

step() {
  echo
  echo "▶ $*"
}

# Processes in the service's cgroup besides the server itself are Shell
# sessions (PTYs and what runs inside them).
count_live_shell_processes() {
  local control_group main_pid procs_file
  control_group="$(systemctl --user show "$SERVICE_NAME" -p ControlGroup --value 2>/dev/null || true)"
  main_pid="$(systemctl --user show "$SERVICE_NAME" -p MainPID --value 2>/dev/null || echo 0)"
  procs_file="/sys/fs/cgroup${control_group}/cgroup.procs"
  if [[ -z "$control_group" || ! -r "$procs_file" ]]; then
    echo 0
    return
  fi
  grep -cvx "$main_pid" "$procs_file" || true
}

COMMIT="$(git -C "$REPO_DIR" rev-parse --verify --quiet "$REF^{commit}")" || fail "Unknown ref: $REF"

if [[ -e "$DEPLOY_DIR/.git" ]]; then
  step "Moving $DEPLOY_DIR to $REF ($(git -C "$REPO_DIR" log -1 --format='%h %s' "$COMMIT"))"
  [[ -z "$(git -C "$DEPLOY_DIR" status --porcelain --untracked-files=no)" ]] \
    || fail "$DEPLOY_DIR has local changes. It only holds deployed commits; remove them first."
  git -C "$DEPLOY_DIR" checkout --quiet --detach "$COMMIT"
else
  step "Creating deploy worktree $DEPLOY_DIR at $REF"
  mkdir -p "$(dirname "$DEPLOY_DIR")"
  git -C "$REPO_DIR" worktree add --quiet --detach "$DEPLOY_DIR" "$COMMIT"
fi

if [[ -f "$REPO_DIR/.env" ]]; then
  ln -sfn "$REPO_DIR/.env" "$DEPLOY_DIR/.env"
fi

cd "$DEPLOY_DIR"
step "Installing dependencies"
npm ci --no-audit --no-fund

step "Building"
npm run build || fail "Build failed in $DEPLOY_DIR. The running service is unchanged."

if ! systemctl --user cat "$SERVICE_NAME" >/dev/null 2>&1; then
  echo
  echo "Built $REF in $DEPLOY_DIR. Install the service with scripts/install-autostart.sh."
  exit 0
fi

SERVICE_DIR="$(systemctl --user show "$SERVICE_NAME" -p WorkingDirectory --value 2>/dev/null || true)"
if [[ "$SERVICE_DIR" != "$DEPLOY_DIR" ]]; then
  echo
  echo "Built $REF in $DEPLOY_DIR, but $SERVICE_NAME still runs from ${SERVICE_DIR:-an unknown directory}."
  echo "Point it here with scripts/install-autostart.sh (that restarts it)."
  exit 0
fi

LIVE="$(count_live_shell_processes)"
if [[ "$LIVE" -gt 0 && "$FORCE" != true ]]; then
  echo
  echo "Built $REF, but $LIVE Shell process(es) are live and a restart would kill them."
  echo "Restart when they are done: systemctl --user restart $SERVICE_NAME (or rerun with --force)."
  exit 0
fi

step "Restarting $SERVICE_NAME"
systemctl --user restart "$SERVICE_NAME"
echo "$SERVICE_NAME now runs $REF ($(git -C "$DEPLOY_DIR" log -1 --format='%h %s'))."
