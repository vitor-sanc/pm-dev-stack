#!/usr/bin/env bash
# Brings the upstream project's latest changes into this fork, then verifies,
# rebuilds and redeploys. This fork only receives from upstream; it never sends
# changes back.
#
#   scripts/sync-upstream.sh            merge, test, build, restart, push
#   scripts/sync-upstream.sh --no-push  same, but leave the push to you
#
# Stops at the first problem and says what to do next. A merge conflict is left
# in place to resolve. Failing tests or build keep the merge commit, so you can
# fix forward or undo it with `git reset --hard ORIG_HEAD`.
#
# UPSTREAM_REMOTE (default: upstream), UPSTREAM_BRANCH (default: main) and
# SERVICE_NAME (default: pm-dev-stack, see install-autostart.sh) override defaults.
set -euo pipefail

UPSTREAM_REMOTE="${UPSTREAM_REMOTE:-upstream}"
UPSTREAM_BRANCH="${UPSTREAM_BRANCH:-main}"
SERVICE_NAME="${SERVICE_NAME:-pm-dev-stack}"
PUSH=true
[[ "${1:-}" == "--no-push" ]] && PUSH=false

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_DIR"

fail() {
  echo "✖ $*" >&2
  exit 1
}

step() {
  echo
  echo "▶ $*"
}

if ! git remote get-url "$UPSTREAM_REMOTE" >/dev/null 2>&1; then
  fail "No '$UPSTREAM_REMOTE' remote. Add it with: git remote add $UPSTREAM_REMOTE https://github.com/siteboon/claudecodeui.git"
fi
if [[ -n "$(git status --porcelain)" ]]; then
  fail "Uncommitted changes in $REPO_DIR. Commit or stash them first."
fi

step "Fetching $UPSTREAM_REMOTE/$UPSTREAM_BRANCH"
git fetch --quiet "$UPSTREAM_REMOTE" "$UPSTREAM_BRANCH"
UPSTREAM_REF="$UPSTREAM_REMOTE/$UPSTREAM_BRANCH"
INCOMING="$(git rev-list --count "HEAD..$UPSTREAM_REF")"
if [[ "$INCOMING" -eq 0 ]]; then
  echo "Already up to date with $UPSTREAM_REF."
  exit 0
fi
echo "$INCOMING new upstream commit(s):"
git log --oneline "HEAD..$UPSTREAM_REF" | head -20
[[ "$INCOMING" -gt 20 ]] && echo "…and $((INCOMING - 20)) more"

step "Merging"
if ! git merge --no-edit "$UPSTREAM_REF"; then
  echo >&2
  echo "Merge conflict in:" >&2
  git diff --name-only --diff-filter=U | sed 's/^/  /' >&2
  fail "Resolve the files above, 'git add' them and 'git commit', then run this script again. Or give up with 'git merge --abort'."
fi

# A changed lockfile means dependencies moved; anything else can reuse node_modules.
if ! git diff --quiet ORIG_HEAD HEAD -- package-lock.json; then
  step "Dependencies changed, installing"
  npm install --no-audit --no-fund
fi

AFTER_MERGE_HINT="The merge is committed. Fix forward, or undo it with: git reset --hard ORIG_HEAD"

step "Backend tests"
npm test || fail "Backend tests failed. $AFTER_MERGE_HINT"

step "Frontend tests"
npx vitest run || fail "Frontend tests failed. $AFTER_MERGE_HINT"

step "Building"
npm run build || fail "Build failed. $AFTER_MERGE_HINT"

if systemctl --user cat "$SERVICE_NAME" >/dev/null 2>&1; then
  step "Restarting $SERVICE_NAME"
  systemctl --user restart "$SERVICE_NAME"
fi

if [[ "$PUSH" == true ]]; then
  step "Pushing"
  git push origin HEAD
fi

echo
echo "✔ Synced $INCOMING upstream commit(s)."
