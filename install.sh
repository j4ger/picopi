#!/usr/bin/env bash
# picopi — install into ~/.pi/agent/
# Usage: ./install.sh [--skip-config]

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PI_DIR="${HOME}/.pi/agent"
SKIP_CONFIG=false

for arg in "$@"; do
  case "$arg" in
    --skip-config) SKIP_CONFIG=true ;;
    *) echo "Unknown option: $arg"; exit 1 ;;
  esac
done

R='\033[0;31m'; G='\033[0;32m'; Y='\033[1;33m'; B='\033[0;34m'; N='\033[0m'
info() { echo -e "${B}==>${N} $*"; }
ok()   { echo -e "${G}  ✓${N} $*"; }
die()  { echo -e "${R}ERR:${N} $*" >&2; exit 1; }

command -v pi   >/dev/null 2>&1 || die "pi not found — install from https://pi.dev"
command -v git  >/dev/null 2>&1 || die "git required (checkpoints use git). Install: brew install git / apt install git"

# ── install ──

info "Installing to ${PI_DIR}"
mkdir -p "${PI_DIR}/"{agents,extensions}
chmod 700 "${PI_DIR}"

if $SKIP_CONFIG; then
  info "Skipping config.json / models.json (--skip-config)"
else
  for f in config.json models.json; do
    if [[ -f "${PI_DIR}/${f}" ]]; then
      cp "${PI_DIR}/${f}" "${PI_DIR}/${f}.bak.$(date +%s)"
    fi
  done
  cp "${SCRIPT_DIR}/config.json" "${PI_DIR}/config.json"
  cp "${SCRIPT_DIR}/models.json" "${PI_DIR}/models.json"
  chmod 600 "${PI_DIR}/config.json"
  chmod 644 "${PI_DIR}/models.json"
fi

cp "${SCRIPT_DIR}/AGENTS.md"      "${PI_DIR}/AGENTS.md"
cp "${SCRIPT_DIR}/agents/"*.md     "${PI_DIR}/agents/"
chmod 644 "${PI_DIR}/AGENTS.md" "${PI_DIR}/agents/"*.md

cp -r "${SCRIPT_DIR}/extensions/picopi" "${PI_DIR}/extensions/"

# ── done ──

echo ""
echo -e "  ${G}picopi installed.${N}"
if $SKIP_CONFIG; then
  echo "  Config files unchanged."
else
  echo -e "  Edit ${Y}${PI_DIR}/models.json${N}  ← add providers & API keys"
  echo -e "  Edit ${Y}${PI_DIR}/config.json${N}  ← set fallback chains & thinking levels"
fi
echo ""
echo "  Then restart Pi or do /reload"
echo ""
