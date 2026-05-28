#!/usr/bin/env bash
# picopi installer — copies files into ~/.pi/agent/
# Add your API keys to ~/.pi/agent/models.json after installation.
#
# Usage: ./install.sh [--skip-config]
#   --skip-config    Skip copying config.json and models.json (for updates)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PI_DIR="${HOME}/.pi/agent"
SKIP_CONFIG=false

# Parse args
for arg in "$@"; do
  case "$arg" in
    --skip-config) SKIP_CONFIG=true ;;
    *) echo "Unknown option: $arg"; exit 1 ;;
  esac
done

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; BLUE='\033[0;34m'; NC='\033[0m'
info() { echo -e "${BLUE}==>${NC} $*"; }
ok()   { echo -e "${GREEN}OK:${NC} $*"; }
warn() { echo -e "${YELLOW}WARN:${NC} $*"; }
die()  { echo -e "${RED}ERR:${NC} $*" >&2; exit 1; }

command -v pi >/dev/null 2>&1 || die "Pi not found. Install: https://pi.dev/"

if ! command -v git >/dev/null 2>&1; then
  echo ""
  echo -e "${RED}git is required but not installed.${NC}"
  echo ""
  echo "  picopi uses git to power its /checkpoint, /undo, and /redo features."
  echo "  Without git, these features won't work."
  echo ""
  echo "  Install:"
  echo "    macOS:  brew install git"
  echo "    Ubuntu: sudo apt install git"
  echo "    Fedora: sudo dnf install git"
  echo ""
  exit 1
fi

info "Creating directories..."
mkdir -p "${PI_DIR}/"{agents,extensions}
chmod 700 "${PI_DIR}"

if [[ "$SKIP_CONFIG" == true ]]; then
  info "Skipping config.json and models.json (--skip-config)"
else
  # Backup existing configs before overwriting
  for f in config.json models.json; do
    if [[ -f "${PI_DIR}/${f}" ]]; then
      bak="${PI_DIR}/${f}.bak.$(date +%s)"
      cp "${PI_DIR}/${f}" "${bak}"
      warn "Existing ${f} backed up to ${bak}"
    fi
  done

  cp "${SCRIPT_DIR}/config.json" "${PI_DIR}/config.json"
  cp "${SCRIPT_DIR}/models.json" "${PI_DIR}/models.json"
  chmod 600 "${PI_DIR}/config.json"
  chmod 644 "${PI_DIR}/models.json"
fi

info "Copying files..."
cp "${SCRIPT_DIR}/AGENTS.md" "${PI_DIR}/AGENTS.md"
cp "${SCRIPT_DIR}/agents/"*.md "${PI_DIR}/agents/"
chmod 644 "${PI_DIR}/AGENTS.md"
chmod 644 "${PI_DIR}/agents/"*.md

if [[ -d "${SCRIPT_DIR}/extensions/picopi" ]]; then
  cp -r "${SCRIPT_DIR}/extensions/picopi" "${PI_DIR}/extensions/"
  ok "Extension copied"
fi

echo ""
echo -e "${GREEN}picopi installed.${NC}"
if [[ "$SKIP_CONFIG" == true ]]; then
  echo ""
  echo "  Config files unchanged (--skip-config)"
else
  echo ""
  echo "  Next step: add your API keys"
  echo -e "  ${YELLOW}→ ${PI_DIR}/models.json${NC}"
fi
echo ""
echo "  Then: pi"
echo "        /reload"
echo ""
echo -e "  ${YELLOW}Security:${NC} config.json has chmod 600. NEVER commit or share it."
echo ""
