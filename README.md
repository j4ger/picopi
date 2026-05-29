# picopi

A batteries-included [pi](https://github.com/earendil-works/pi) agent, driven by
one config and shipped as a single self-contained extension — **zero external
packages fetched**, installable via Nix or a plain script.

- **Web search + fetch** — zero-config (DuckDuckGo), optional Exa / Perplexity / Brave
- **opencode-style undo** — rewinds conversation **and** workspace files, on double-ESC
- **Simple todo list** — branch-aware, with a live widget and `/todos` panel
- **Slim multi-agent** — `planner` / `explorer` / `fixer` / `auditor` / `web-searcher`
- **Role + fallback model resolution** — orchestrator, agents, compaction, web search from one config
- **Elegant TUI** — footer status, inline panels, custom theme
- **Centralized config** — one hot-reloaded `~/.config/picopi/config.json`

---

# Quickstart

## 1. Run it

**With Nix** — no install needed, just run (builds once, then cached):

```bash
nix run github:j4ger/picopi --accept-flake-config
```

Or install it as a permanent `picopi` command:

```bash
nix profile install github:j4ger/picopi --accept-flake-config
picopi
```

**Without Nix** — needs [`pi`](https://github.com/earendil-works/pi) on `PATH`
and `python3`:

```bash
git clone https://github.com/j4ger/picopi && cd picopi
./scripts/install.sh        # installs into ~/.config/picopi + a `picopi` launcher
picopi
```

The installer drops a `picopi` command in `~/.local/bin` (override with
`$PICOPI_BINDIR`) that runs pi against picopi's dir — your plain `pi` and
`~/.pi/agent` stay untouched. If `~/.local/bin` isn't on your `PATH`, the
installer tells you.

Everything lives in one directory — **`~/.config/picopi/`** — for every install
method. It's the pi agent dir, so it holds both picopi's resources and pi's own
config:

```
~/.config/picopi/
  config.json     picopi roles/aliases   ┐
  models.json     providers/models       ├ edit these
  settings.json   pi settings            ┘
  src/ agents/ prompts/ themes/          picopi resources (managed)
  auth.json  sessions/  …                pi state
```

First launch seeds `config.json`/`settings.json`/`models.json` (the script
installer writes them immediately; Nix on first run) and never overwrites them
afterward. Existing pi settings are merged in, preserving your current setup.

## 2. Authenticate

picopi uses pi's own auth, so any provider pi supports works. Two ways:

- **Subscriptions / API keys via `/login`** — launch picopi and type `/login`,
  then pick a provider (Claude Pro/Max, ChatGPT/Codex, Copilot, or an API key).
  Credentials persist in your agent dir, so this works even with `nix run` — no
  install required.
- **Environment variables** — e.g. `export ANTHROPIC_API_KEY=...` or
  `export OPENAI_API_KEY=...` before launching.

See pi's [provider docs](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/providers.md)
for the full list of providers, env-var names, and OAuth options.

## 3. Point the aliases at your models

picopi routes every role through two aliases — **`pro`** (smart) and **`flash`**
(fast). Edit `~/.config/picopi/config.json` (hot-reloaded, same path for every
install) so they name models you can use:

```jsonc
// ~/.config/picopi/config.json — examples; use any provider/model pi supports
"aliases": {
  "pro":   ["anthropic/claude-opus-4-5"],
  "flash": ["anthropic/claude-sonnet-4-5"]
}
```

Then run `/picopi` to confirm what resolved. Custom gateways, fallback chains,
and per-role thinking levels are in [Customization](#customization).

## Commands

| Command | Effect |
|---------|--------|
| `/picopi` | Show resolved roles / models / config source |
| `/undo` | Rewind to the previous user turn (conversation + files) |
| `/checkpoints` | List workspace checkpoints on this branch |
| `/todos` | Open the todo panel |
| `/implement <task>` | explorer → planner → fixer chain |
| `/review [focus]` | auditor on the working tree |
| `/research <q>` | web-searcher synthesis |

Web search works with **no key** (DuckDuckGo). Double-ESC rewinds — see
[Undo](#undo--double-esc).

---

# Customization

Everything below is optional. The quickstart above is enough to use picopi.

## The config — `~/.config/picopi/config.json`

Each role maps to an **alias** + thinking level + (for subagents) a timeout. An
alias is an ordered list of `provider/id` models — preferred first, fallbacks
after — and the first entry with a working API key wins.

```jsonc
{
  "orchestrator": { "model": "pro", "thinking": "high" },

  "agents": {
    "planner":      { "model": "pro",   "thinking": "xhigh",  "timeout": 600 },
    "explorer":     { "model": "flash", "thinking": "low",    "timeout": 300 },
    "fixer":        { "model": "flash", "thinking": "medium", "timeout": 180 },
    "auditor":      { "model": "pro",   "thinking": "high",   "timeout": 300 },
    "web-searcher": { "model": "flash", "thinking": "low",    "timeout": 300 }
  },

  "aliases": {
    "pro":   ["google/gemini-2.5-pro",   "anthropic/claude-opus-4-5"],
    "flash": ["google/gemini-2.5-flash", "anthropic/claude-sonnet-4-5"]
  },

  "compaction": { "model": "flash" },
  "webSearch":  { "provider": "auto", "searchModel": null }
}
```

- **Orchestrator** — resolved model + thinking applied to the interactive
  session on startup, shown in the footer.
- **Agents** — spawned as isolated `pi` processes; `--model` is the full chain so
  pi does the fallback walk itself, and `--thinking` is set per role.
- **Compaction** — optionally summarizes context with a cheaper alias.
- **Web search** — `provider`: `exa` / `perplexity` / `brave` / `duckduckgo` /
  `auto`. Keyed providers come from env (`EXA_API_KEY`, `PERPLEXITY_API_KEY`,
  `BRAVE_API_KEY`); `auto` uses the first present, else DuckDuckGo. `searchModel`
  applies to Perplexity.

The config is read from `<agent dir>/config.json` — `~/.config/picopi/config.json`
by default — and is hot-reloaded; `/picopi` shows the resolved result. (A flake
can bake a config via `$PICOPI_CONFIG`; see
[Composing into other flakes](#composing-into-other-flakes).)

## Custom providers / gateways

Providers/models are declared in **`~/.config/picopi/models.json`** (pi's model
registry), then referenced from `config.json`'s `aliases` as `provider/model-id`.
Keys use `$ENV_VAR` references so no secret lands in a config file. See
[`examples/models.example.json`](examples/models.example.json) and pi's
[models docs](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/models.md).

```jsonc
// ~/.config/picopi/models.json — declare the provider
"providers": { "openrouter": { "baseUrl": "https://openrouter.ai/api/v1", "api": "openai-completions", "apiKey": "$OPENROUTER_API_KEY", "models": [{ "id": "anthropic/claude-opus-4", "reasoning": true }] } }
```

```jsonc
// ~/.config/picopi/config.json — gateway primary, built-in fallbacks after
"aliases": {
  "pro": ["openrouter/anthropic/claude-opus-4", "anthropic/claude-opus-4-5", "google/gemini-2.5-pro"]
}
```

> Both files live directly in the agent dir (`~/.config/picopi/` by default) for
> every install, and persist across upgrades.

## Dev loop (hack on picopi itself)

Run from a clone with no install and no Nix rebuild. The helpers keep all real
config under the gitignored `local/`:

```bash
./scripts/setup-keys.sh        # examples/* -> local/{secrets.env,models.json,config.json}
$EDITOR local/secrets.env      # your keys go here (the only place)
./scripts/dev.sh "explain this repo"   # runs picopi from source; live-reloads code edits
```

`scripts/dev.sh` sources `local/secrets.env`, builds a throwaway agent dir at
`local/picopi/`, and symlinks the live `src/` so edits apply immediately. Secrets
stay only in `secrets.env` (referenced as `$ENV_VAR` from `models.json`) and
never touch the git tree.

## Composing into other flakes

```nix
{
  inputs.picopi.url = "github:j4ger/picopi";

  # Home Manager:
  imports = [ inputs.picopi.homeModules.default ];
  programs.picopi = {
    enable = true;
    config = ./my-config.json;             # replace config.json
    extraSettings = { theme = "dark"; };   # deep-merged into settings.json
    extraEnv = { PI_SKIP_VERSION_CHECK = "1"; };
    extraAgents = [ ./agents/dba.md ];     # extra subagent definitions
  };
}
```

Or build a customized package directly (the overlay also exposes `pkgs.picopi`):

```nix
inputs.picopi.lib.${system}.mkPicopi {
  picopiConfig = ./my-config.json;
  extraSettings = { defaultThinkingLevel = "high"; };
}
```

## Undo / double-ESC

`agent/settings.json` ships `"doubleEscapeAction": "fork"`. Double-ESC opens the
fork picker; choosing a point fires `session_before_fork`, where picopi offers
to restore the workspace files to the checkpoint captured for that turn. `/undo`
rewinds one full turn (conversation + files) in a single keystroke;
`/checkpoints` lists restore points. Requires a git repo.

## How it's packaged

The repo's `agent/` directory is the template for **the** agent dir, which by
design is also the config dir (pi reads everything from `PI_CODING_AGENT_DIR`).
The Nix wrapper points it at `$PICOPI_HOME` (default `~/.config/picopi`); the
non-Nix installer and `dev.sh` populate the same kind of dir. On launch, picopi
resources (`src/`, `agents/`, `prompts/`, `themes/`, `AGENTS.md`) are refreshed
from the store/repo, while user files (`config.json`, `settings.json`,
`models.json`, `auth.json`, `sessions/`) are seeded once and then left alone —
no symlinks anywhere. A flake that bakes a config ships it as `config.json` and
pins it via `$PICOPI_CONFIG`. pi resolves the extension's peer deps via its own
`NODE_PATH`, so no `node_modules` is shipped.

## Layout

```
src/                  # the one extension: index + web, undo, todo, subagent, orchestrator, config
agent/                # template for the agent dir (= config dir, ~/.config/picopi by default)
  config.json         #   default picopi roles/aliases (seeded, then user-owned)
  settings.json       #   default pi settings (seeded, then user-owned)
  AGENTS.md           #   operating rules baked into the system prompt
  agents/*.md         #   subagent prompts (model comes from config.json)
  prompts/*.md        #   workflow templates
  themes/picopi.json  #   the picopi theme
examples/             # sanitized config templates (keys as $ENV refs)
scripts/              # install.sh (non-Nix), setup-keys.sh, dev.sh
local/                # gitignored: your real keys + dev agent dir
nix/picopi.nix        # agent-dir + wrapper builder
flake.nix             # packages, lib.mkPicopi, homeModules, overlay
```

## TODO

- **Updating**: document/streamline updates. Nix: `nix profile upgrade picopi`
  (or `nix run --refresh`); non-Nix: `git pull && ./scripts/install.sh`. Resources
  refresh automatically; `config.json`/`settings.json`/`models.json` are
  seeded-once, so new *default* aliases/settings don't reach existing installs —
  consider a merge/migration step.
