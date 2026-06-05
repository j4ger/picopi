#!/usr/bin/env bash
# Shared picopi launcher core, used by both the script install (scripts/install.sh)
# and the Nix flake. Callers set these env vars:
#   PICOPI_SRC          dir holding src/ agent/ scripts/ (repo or nix store)   [required]
#   PICOPI_PI_BIN       explicit pi binary (Nix pins this); else resolved from PATH
#   PICOPI_PI_FALLBACK  pi path to use if not on PATH (script install bakes this)
#   PICOPI_UPDATE_CMD   command run on `--update`; if unset, prints PICOPI_UPDATE_HINT
#   PICOPI_UPDATE_HINT  update guidance shown when PICOPI_UPDATE_CMD is unset (e.g. Nix)
set -euo pipefail

src="${PICOPI_SRC:?PICOPI_SRC not set}"
dir="${PICOPI_HOME:-${XDG_CONFIG_HOME:-$HOME/.config}/picopi}"

case "${1:-}" in
  --update)
    if [ -n "${PICOPI_UPDATE_CMD:-}" ]; then exec "$PICOPI_UPDATE_CMD" "${@:2}"; fi
    echo "${PICOPI_UPDATE_HINT:-To update, reinstall picopi.}"; exit 0 ;;
  -h | --help)
    cat <<'PICOPIHELP'
picopi — a pi wrapper. All options are forwarded to pi; see 'pi --help'.

  picopi [pi options...]   launch picopi
  picopi --update          update picopi (add --no-pi to skip pi)
  picopi -h, --help        show this help
PICOPIHELP
    exit 0 ;;
esac

# Seed user-owned files once; never clobber.
mkdir -p "$dir"
[ -e "$dir/config.json" ]   || cp "$src/agent/config.json" "$dir/config.json"
[ -e "$dir/settings.json" ] || cp "$src/agent/settings.json" "$dir/settings.json"
[ -e "$dir/models.json" ]   || printf '{\n  "providers": {}\n}\n' > "$dir/models.json"

pi_bin="${PICOPI_PI_BIN:-}"
[ -n "$pi_bin" ] || pi_bin="$(command -v pi || true)"
[ -n "$pi_bin" ] || pi_bin="${PICOPI_PI_FALLBACK:-pi}"

export PI_CODING_AGENT_DIR="$dir"
exec "$pi_bin" \
  --extension "$src/src" \
  --prompt-template "$src/agent/prompts" \
  --theme "$src/agent/themes" \
  --append-system-prompt "$src/agent/AGENTS.md" \
  "$@"
