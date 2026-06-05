# picopi

A batteries-included [pi](https://github.com/earendil-works/pi) extension with web
search, undo, todos, subagents, and role-based model routing — all from one
config file. Ships with an **Ayu Dark**-inspired terminal theme.

## Features

- **Web search + fetch** — DuckDuckGo by default, optional Exa / Perplexity / Brave
- **Undo** — Rewind conversation and workspace files on double-ESC
- **Todos** — Branch-aware task list with live widget
- **Subagents** — Specialist agents (planner, explorer, fixer, auditor, web-searcher) with real-time status and timeout detection
- **Model routing** — Role-based aliases with ordered fallback chains

## Quickstart

### Install

**Nix** (recommended):

```bash
nix run github:j4ger/picopi --accept-flake-config
# or install permanently:
nix profile install github:j4ger/picopi --accept-flake-config
```

**Without Nix** (requires [pi](https://github.com/earendil-works/pi) on PATH):

```bash
git clone https://github.com/j4ger/picopi && cd picopi
./scripts/install.sh
```

### Authenticate

picopi uses pi's auth. Launch it and log in to a provider:

```bash
picopi          # or: nix run github:j4ger/picopi --accept-flake-config
```

Inside picopi, run `/login` and pick your provider (OAuth or API key). Built-in
providers (Anthropic, Google, OpenAI, …) work with just a login — no
`models.json` needed. See [pi's provider docs](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/providers.md) for env-var keys and OAuth details.

### Configure

The installer seeds a full `~/.config/picopi/config.json` — **edit it in place**.
It ships with `pro` and `flash` aliases pointing at sensible defaults:

```jsonc
{
  "aliases": {
    "pro":   ["google/gemini-2.5-pro",   "anthropic/claude-opus-4-5"],
    "flash": ["google/gemini-2.5-flash", "anthropic/claude-sonnet-4-5"]
  }
}
```

Point these at models you can actually use (first entry with a working key
wins). Then run `/picopi` to verify every role resolves.

---

## Commands

| Command | Effect |
|---------|--------|
| `/preset [name]` | Switch alias preset (or list presets) |
| `/picopi` | Config status panel |
| `/undo` | Rewind one turn |
| `/checkpoints` | List workspace checkpoints |
| `/todos` | Open todo panel |
| `/review [focus]` | Run auditor on working tree |
| `/research <q>` | Web search synthesis |
| `/tree` | Session tree navigator |
| `/fork` | Fork current session |
| `/compact` | Compact context |

---

## Subagents

Delegate scoped work to specialist agents so the main context stays focused.
The orchestrator runs on a small/cheap model and **coordinates**: it delegates
heavy reasoning to `planner`, splits the plan into small fixer-sized tasks, and
runs independent `fixer`s in parallel. This keeps cost down and avoids handing
the small `fixer` model tasks too big to finish before its timeout.

| Agent | Purpose |
|-------|---------|
| **planner** | Step-by-step implementation plans |
| **explorer** | Fast codebase reconnaissance |
| **fixer** | Targeted code changes |
| **auditor** | Code review and bug hunting |
| **web-searcher** | Research and synthesis |

**Usage:**

```
Use explorer to find all auth code
Run explorer and auditor in parallel on the auth module
Have planner create a plan, then fixer implements it
```

**Config:**

```jsonc
{
  "agents": {
    "explorer": { "model": "flash", "timeout": 90 },
    "planner":  { "model": "pro",   "timeout": 180 }
  }
}
```

Create custom agents in `~/.config/picopi/agents/*.md`:

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

`~/.config/picopi/config.json` (hot-reloaded):

```jsonc
{
  "orchestrator": { "model": "flash", "thinking": "medium" },

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
  "webSearch":  { "provider": "auto" }
}
```

- **Roles** — `orchestrator` and each `agent` map to an alias + `thinking` + `timeout`.
- **Aliases** — ordered fallback chain. First working key wins.
- **Presets** — alias overrides using `alias@preset` naming. Switch at runtime with `/preset`.
- **Thinking** — `off` → `minimal` → `low` → `medium` → `high` → `xhigh`
- **Timeout** — seconds before watchdog kills a stuck agent
- **Compaction** — optional cheaper model for context summarization; falls back to the session model if unset/unavailable.

### Runtime fallback

When the orchestrator's model errors out (timeout, overload, rate limit, 5xx,
auth, …), picopi switches to the next model in the alias chain so pi's own
retry picks up the fallback model. Context-overflow errors are left to pi's
compaction instead. Disable with `PI_FALLBACK_DISABLE=true`.

**Limitation:** fallback only fires while pi is retrying. Non-retryable errors
(auth, content-policy, model-not-found) and `retry.maxRetries: 0` stop the turn
immediately — the model is switched for the *next* turn, but the failed turn is
not re-run automatically. Re-send your prompt to retry on the fallback model.
The chain is also walked at most `retry.maxRetries + 1` models per turn.

### Presets

Define alias overrides with `@preset` names so you can switch the whole fallback chain at runtime without duplicating the rest of the config.

```jsonc
{
  "aliases": {
    "pro":        ["google/gemini-2.5-pro",   "anthropic/claude-opus-4-5"],
    "pro@fast":   ["google/gemini-2.5-flash"],
    "pro@local":  ["ollama/llama3.3:70b"],

    "flash":      ["google/gemini-2.5-flash", "anthropic/claude-sonnet-4-5"],
    "flash@fast": ["google/gemini-2.5-flash"],
    "flash@local":["ollama/llama3.3:70b"]
  }
}
```

- Run `/preset` to see available presets and which one is active.
- Run `/preset fast` to switch — the orchestrator, subagents, compaction, etc. all follow the new chains instantly.
- The last-used preset **persists across restarts and session resumes** (stored in `~/.config/picopi/state.json`).
- If an `@preset` variant is missing for an alias, the base alias is used as a fallback, so partial presets are safe.

### Web search providers

| Provider | Key | Notes |
|----------|-----|-------|
| DuckDuckGo | None | Default |
| Exa | `EXA_API_KEY` | |
| Perplexity | `PERPLEXITY_API_KEY` | |
| Brave | `BRAVE_API_KEY` | |
| `auto` | — | First keyed provider, else DuckDuckGo |

### Custom models / gateways

Built-in providers (Anthropic, Google, OpenAI, …) need only `/login`. Use
`models.json` **only** for custom providers or gateways: declare them in
`~/.config/picopi/models.json`, then reference as `provider/model` in aliases.
See
[pi's models docs](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/models.md).

### Nix flake

```nix
{
  inputs.picopi.url = "github:j4ger/picopi";

  programs.picopi = {
    enable = true;
    config = ./my-config.json;
    extraAgents = [ ./agents/dba.md ];
  };
}
```

---

## Layout

```
src/              # Extension source
agent/            # Seeded defaults (config, settings, agents, themes)
  themes/picopi.json   # Ayu Dark-inspired theme
scripts/          # install.sh
nix/              # Nix builder
flake.nix
```

---

## Troubleshooting

| Problem | Fix |
|---------|-----|
| `Unknown agent` | Check agent name matches a `.md` in `agents/` |
| Subagent timeout | Increase `timeout` or check provider status |
| `No API key` | Run `/login` or set env var |
| Model not found | Run `/picopi` to check resolved aliases |
| Stale config | Hot-reloaded; run `/picopi` to verify |

---

## Updating

**Nix:** `nix profile upgrade picopi` or `nix run --refresh`  
**Non-Nix:** `git pull` (launcher reads from repo)

Config files are seeded once and never overwritten. Merge new defaults manually
if needed.
