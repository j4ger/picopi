#!/usr/bin/env bash
# picopi dev launcher — run straight from the repo, no install, no Nix rebuild.
#
#   ./scripts/dev.sh "your prompt"      # or no args for interactive
#
# Builds a throwaway agent dir at local/picopi/ (the agent dir IS the config
# dir), sources keys from local/secrets.env, and symlinks the live src/ so code
# edits apply immediately. Your local/{config,models}.json override the
# defaults. Everything under local/ is gitignored; see scripts/setup-keys.sh.
set -euo pipefail

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
loc="$repo/local"
dir="$loc/picopi"

[ -f "$loc/secrets.env" ] && set -a && . "$loc/secrets.env" && set +a

# Rebuild the agent dir from the repo template, with the live src/ symlinked.
rm -rf "$dir"
cp -r "$repo/agent" "$dir"
chmod -R u+w "$dir"
ln -sfn "$repo/src" "$dir/src"
python3 - "$dir" <<'PY'
import json, sys
p = f"{sys.argv[1]}/settings.json"
s = json.load(open(p))
s.update(extensions=["src"], packages=[], skills=[], prompts=["prompts"], themes=["themes"])
json.dump(s, open(p, "w"), indent=2)
PY

# Your local overrides win when present.
[ -f "$loc/config.json" ] && cp "$loc/config.json" "$dir/config.json"
[ -f "$loc/models.json" ] && cp "$loc/models.json" "$dir/models.json"

export PI_CODING_AGENT_DIR="$dir"
exec pi "$@"
