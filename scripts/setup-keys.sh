#!/usr/bin/env bash
# Bootstrap local API-key config from the committed templates.
#
#   ./scripts/setup-keys.sh
#
# Copies examples/* into local/ (gitignored) if not already present, then points
# you at the files to edit. Never overwrites existing local config.
set -euo pipefail

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
mkdir -p "$repo/local"

copy() { # src dst
  if [ -e "$repo/local/$2" ]; then
    echo "  keep   local/$2 (already exists)"
  else
    cp "$repo/examples/$1" "$repo/local/$2"
    echo "  create local/$2"
  fi
}

echo "Setting up local config in $repo/local/ (gitignored):"
copy secrets.example.env secrets.env
copy models.example.json models.json
copy config.example.json config.json

cat <<EOF

Next:
  1. Edit local/secrets.env       — put your API keys here (the only place).
  2. Edit local/models.json       — declare providers/models; keys use \$ENV refs.
  3. Edit local/config.json       — map the pro/flash aliases to your models.

Then run:  ./scripts/dev.sh "hello"

Tip: keys live ONLY in local/secrets.env as \$ENV_VAR; models.json references
them, so no secret is ever written into a config file or committed.
EOF
