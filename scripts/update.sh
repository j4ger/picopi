#!/usr/bin/env bash
# picopi updater (run via `picopi --update`).
# Updates picopi (git pull + re-run install.sh) and pi (`pi update pi`).
#   picopi --update            update both
#   picopi --update --no-pi    update picopi only (manage pi yourself)
set -euo pipefail

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
with_pi=yes
[ "${1:-}" = "--no-pi" ] && with_pi=no

echo "Updating picopi in $repo"
if [ -n "$(git -C "$repo" status --porcelain)" ]; then
  echo "error: repo has local changes; commit/stash them first, then retry." >&2
  exit 1
fi
if ! git -C "$repo" pull --ff-only; then
  echo "error: 'git pull --ff-only' failed (diverged history?). Resolve manually in $repo." >&2
  exit 1
fi

# Re-run install to regenerate the launcher and apply any migrations (keeps config).
bash "$repo/scripts/install.sh"

if [ "$with_pi" = yes ]; then
  if command -v pi >/dev/null; then
    echo "Updating pi"
    pi update pi || echo "warning: 'pi update pi' failed; update pi manually." >&2
  else
    echo "warning: 'pi' not on PATH; skipping pi update." >&2
  fi
fi

echo "Done."
