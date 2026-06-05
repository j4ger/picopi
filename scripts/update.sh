#!/usr/bin/env bash
# picopi updater (run via `picopi --update`).
# Updates picopi (git pull + re-run install.sh) and pi (`pi update pi`).
#   picopi --update            update both
#   picopi --update --no-pi    update picopi only (manage pi yourself)
set -euo pipefail

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=scripts/_lib.sh
. "$repo/scripts/_lib.sh"

with_pi=yes
[ "${1:-}" = "--no-pi" ] && with_pi=no

echo -e "$H picopi — updating"

# ── git pull ──────────────────────────────────────────────────────────────────
if [ -n "$(git -C "$repo" status --porcelain)" ]; then
  fail "repo has local changes — commit or stash first"
  exit 1
fi
if ! git -C "$repo" pull --ff-only; then
  fail "pull failed — resolve conflicts in $repo"
  exit 1
fi
ok "pulled latest"

# ── re-run install (suppress its header) ─────────────────────────────────────
PICOPI_NO_HEADER=1 bash "$repo/scripts/install.sh"

# ── update pi ─────────────────────────────────────────────────────────────────
if [ "$with_pi" = yes ]; then
  if command -v pi >/dev/null; then
    if pi update pi; then
      ok "pi updated"
    else
      warn "pi update failed — update manually"
    fi
  else
    warn "'pi' not on PATH — skipping"
  fi
fi

echo -e "$H done"
