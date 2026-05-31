# picopi

A batteries-included [pi](https://github.com/earendil-works/pi) extension that
adds web search, undo, todos, subagents, and role-based model routing — all
driven by one config file.

## Features

| Feature | Description |
|---------|-------------|
| **Web search + fetch** | Zero-config DuckDuckGo, optional Exa / Perplexity / Brave |
| **Undo** | Rewind conversation and workspace files on double-ESC |
| **Todos** | Branch-aware task list with live widget |
| **Subagents** | Specialist agents with real-time status panel and timeout detection |
| **Model routing** | Role-based aliases with fallback chains from one config |

## Quickstart

### Install

**Nix** (recommended):

```bash
nix run github:j4ger/picopi --accept-flake-config
```

Or install permanently:

```bash
nix profile install github:j4ger/picopi --accept-flake-config
```

**Without Nix** (requires [pi](https://github.com/earendil-works/pi) on PATH):

```bash
git clone https://github.com/j4ger/picopi && cd picopi
./scripts/install.sh
```

### Configure models

Edit `~/.config/picopi/config.json` — just change the aliases:

```jsonc
{
  "aliases": {
    "pro":   ["anthropic/claude-sonnet-4-5"],    // smart model
    "flash": ["anthropic/claude-haiku-4-5"]      // fast model
  }
}
```

Run `/picopi` to verify what resolved.

### Authenticate

picopi uses pi's auth. See [pi's provider docs](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/providers.md) for API keys and OAuth setup.

---

## Commands

| Command | Effect |
|---------|--------|
| `/picopi` | Show config status panel (resolved roles, models, fallback chain, config source). Press Enter or Esc to close. |
| `/undo` | Rewind one turn (conversation + files) |
| `/checkpoints` | List workspace checkpoints |
| `/todos` | Open todo panel |
| `/review [focus]` | Run auditor on working tree |
| `/research <q>` | Web search synthesis |
| `/tree` | Session tree navigator |
| `/fork` | Fork current session |
| `/compact` | Compact context |

---

## Subagents

Specialist agents that run in isolated context windows. The main agent delegates
scoped work to them so the conversation stays focused.

### Available agents

| Agent | Purpose | Default tools |
|-------|---------|---------------|
| **planner** | Step-by-step implementation plans | read, grep, find, ls |
| **explorer** | Fast codebase reconnaissance | read, grep, find, ls, bash |
| **fixer** | Targeted code changes | read, write, edit, bash |
| **auditor** | Code review and bug hunting | read, grep, find, ls, bash |
| **web-searcher** | Research and synthesis | web_search, fetch_content, read |

### Usage

```
# Single agent
Use explorer to find all authentication code

# Parallel (up to 6 tasks, 3 concurrent)
Run explorer and auditor in parallel on the auth module

# Chain
Have planner create a plan, then fixer implements it
```

### Status panel

Running agents appear in a right-side overlay:

```
+-------------------+
| Subagents         |
| o explorer 3.2s   |
|   grep: auth.ts   |
| + planner 1.2s    |
| 1 active          |
+-------------------+
```

| Icon | Status |
|------|--------|
| `o` | Running |
| `+` | Completed |
| `!` | Stuck (timeout) |
| `x` | Failed |

### Watchdog timeout

If a provider stops responding, the agent is killed after a timeout (default:
120s). Configure per-agent in `config.json`:

```jsonc
{
  "agents": {
    "explorer": { "model": "flash", "timeout": 90 },
    "planner":  { "model": "pro",   "timeout": 180 }
  }
}
```

Or per-task: `Use explorer with timeout 60 to find auth code`

### Custom agents

Create markdown files in `~/.config/picopi/agents/`:

```markdown
---
name: reviewer
description: Focused code review
tools: read, grep, find, ls
---

You are a code reviewer. Focus on correctness, edge cases, and security.
```

---

## Customization

Everything below is optional. The quickstart above is enough.

### Config reference

`~/.config/picopi/config.json` (hot-reloaded):

```jsonc
{
  // Main session model
  "orchestrator": { "model": "pro", "thinking": "high" },

  // Subagent configs
  "agents": {
    "planner":      { "model": "pro",   "thinking": "xhigh",  "timeout": 600 },
    "explorer":     { "model": "flash", "thinking": "low",    "timeout": 300 },
    "fixer":        { "model": "flash", "thinking": "medium", "timeout": 180 },
    "auditor":      { "model": "pro",   "thinking": "high",   "timeout": 300 },
    "web-searcher": { "model": "flash", "thinking": "low",    "timeout": 300 }
  },

  // Model aliases (ordered fallback chain)
  "aliases": {
    "pro":   ["anthropic/claude-sonnet-4-5", "google/gemini-2.5-pro"],
    "flash": ["anthropic/claude-haiku-4-5",  "google/gemini-2.5-flash"]
  },

  // Optional
  "compaction": { "model": "flash" },
  "webSearch":  { "provider": "auto" }
}
```

- **Aliases** — ordered list of `provider/model` entries. First with a working key wins.
- **Thinking** — `off`, `minimal`, `low`, `medium`, `high`, `xhigh`
- **Timeout** — seconds before watchdog kills a stuck agent

### Web search providers

| Provider | Key | Notes |
|----------|-----|-------|
| DuckDuckGo | None | Default, works out of the box |
| Exa | `EXA_API_KEY` | |
| Perplexity | `PERPLEXITY_API_KEY` | `searchModel` applies |
| Brave | `BRAVE_API_KEY` | |
| `auto` | — | First keyed provider, else DuckDuckGo |

### Custom models / gateways

Declare providers in `~/.config/picopi/models.json`, then reference as
`provider/model` in config aliases. See
[pi's models docs](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/models.md).

### Nix flake integration

```nix
{
  inputs.picopi.url = "github:j4ger/picopi";

  # Home Manager
  programs.picopi = {
    enable = true;
    config = ./my-config.json;
    extraSettings = { theme = "dark"; };
    extraAgents = [ ./agents/dba.md ];
  };
}
```

---

## Undo

Double-ESC opens the fork picker. Choosing a point offers to restore workspace
files to that checkpoint. `/undo` rewinds one turn instantly. Requires a git
repo.

---

## Troubleshooting

| Problem | Fix |
|---------|-----|
| `Unknown agent` | Check agent name matches a `.md` file in `agents/` |
| Subagent timeout | Increase `timeout` in config, or check provider status |
| `No API key` | Run `/login` or set env var. See [pi docs](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/providers.md) |
| Model not found | Run `/picopi` to check resolved aliases |
| Stale config | Config is hot-reloaded. Run `/picopi` to verify |

---

## Layout

```
src/                  # Extension: index, web, undo, todo, subagent, orchestrator, config
agent/                # Read-only resources + seeded defaults
  config.json         #   Roles/aliases (seeded once, then user-owned)
  settings.json       #   Pi settings (seeded once, then user-owned)
  AGENTS.md           #   System prompt additions
  agents/*.md         #   Subagent definitions
  prompts/*.md        #   Workflow templates
  themes/picopi.json  #   Theme
examples/             # Config templates
scripts/              # install.sh (non-Nix)
nix/picopi.nix        # Nix builder
flake.nix             # Flake outputs
```

## Updating

**Nix:** `nix profile upgrade picopi` or `nix run --refresh`  
**Non-Nix:** `git pull` (launcher reads from repo)

Config files are seeded once and never overwritten. New defaults don't reach
existing installs — merge manually if needed.
