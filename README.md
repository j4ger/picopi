# pico-pi

An opinionated [pi](https://github.com/earendil-works/pi) setup with web search, undo, todos, subagent presets, and role-based model routing.

## Features

- **Web search + fetch** — DuckDuckGo by default, optional Exa / Perplexity / Brave
- **Undo** — Rewind conversation and workspace files on double-ESC
- **Todos** — Visual task list with live widget
- **Subagents** — Specialist agents (planner, explorer, fixer, auditor, web-searcher) with live widget, inspection tool and parallel spawning
- **rtk bash** — Bash commands transparently rewritten via [rtk](https://github.com/rtk-ai/rtk) when available, to reduce token usage
- **Model routing** — Role-based aliases with ordered fallback chains

## Quickstart

### Install

Nix:

```bash
nix run github:j4ger/picopi
```

Without Nix (requires [pi](https://github.com/earendil-works/pi) on PATH):

```bash
git clone https://github.com/j4ger/picopi ~/.local/share/picopi && cd ~/.local/share/picopi
./scripts/install.sh

# Optional: from the cloned picopi repo, install turndown for better web HTML-to-text conversion
npm install            # or: bun install / pnpm install

# Optional: install rtk for better token efficiency
curl -fsSL https://raw.githubusercontent.com/rtk-ai/rtk/refs/heads/master/install.sh | sh
```

> **Keep the clone around.** The launcher embeds its absolute path; re-run `./scripts/install.sh` if you move it.

### Authenticate

picopi uses pi's auth. Launch it and log in to a provider:

```bash
picopi
```

Inside picopi, run `/login` and pick your provider (OAuth or API key). See [pi's provider docs](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/providers.md) for details.

### Configure

The installer seeds a full `~/.config/picopi/config.json`.
It ships with five semantic aliases pointing at sensible defaults:

```jsonc
{
  "aliases": {
    "strong":   ["google/gemini-2.5-pro",     "anthropic/claude-opus-4-5",    "openai/gpt-4o"],
    "balanced": ["google/gemini-2.5-flash",   "anthropic/claude-sonnet-4-5",  "openai/gpt-4-turbo"],
    "fast":     ["anthropic/claude-haiku-4-5", "openai/gpt-3.5-turbo",         "qwen/qwen2.5-coder"],
    "cheap":    ["google/gemini-2.5-flash",   "anthropic/claude-haiku-4-5"],
    "orche":    ["google/gemini-2.5-flash",   "anthropic/claude-haiku-4-5"]
  }
}
```

| Alias | Purpose | Example models |
|-------|---------|----------------|
| `strong` | Highest-quality reasoning | Claude Opus, GPT-4, DeepSeek V3 |
| `balanced` | Good coding, reasonable cost | Claude Sonnet, GPT-4-turbo, DeepSeek Coder V2 |
| `fast` | Fast/cheap exploration | Claude Haiku, GPT-3.5-turbo, Qwen-2.5 |
| `cheap` | Cheapest for simple tasks | Claude Haiku, Gemini Flash |
| `orche` | Fast routing for orchestrator | Gemini Flash, Claude Haiku |

You can run `/picopi` to verify every role resolves.

---

## Commands

| Command | Effect |
|---------|--------|
| `/preset [name]` | Switch alias preset (interactive picker, or pass a name) |
| `/picopi` | Config status panel |
| `/undo` | Rewind one turn |
| `/checkpoints` | List workspace checkpoints |
| `/todos` | Open todo panel |
| `/tree` | Session tree navigator |

| `/tree` | Session tree navigator |
| `/subagents` | Live subagent inspector |
| `/bench [prompt] [--models ...] [--concurrency N] [--timeout N] [clear]` | Benchmark all configured models (TTFT, tok/s, alive/dead/timeout) |
| `/fork` | Fork current session |
| `/compact` | Compact context |

---

## Subagents

Delegate scoped work to specialist agents so the main context stays focused.
The orchestrator runs on a small/cheap model and **coordinates**: it delegates heavy reasoning to `planner`, splits the plan into small fixer-sized tasks, and runs independent `fixer`s in parallel. This keeps cost down and avoids handing the small `fixer` model tasks too big to finish before its timeout.

| Agent | Purpose |
|-------|---------|
| **planner** | Step-by-step implementation plans |
| **explorer** | Fast codebase reconnaissance |
| **fixer** | Targeted code changes |
| **auditor** | Code review and bug hunting |
| **web-searcher** | Research and synthesis |

Run `/subagents` to open a live TUI panel that shows running and completed subagents. Navigate with arrow keys, press Enter to expand a subagent's transcript, and press q to quit. Press v to through verbosity levels.

Config:

```jsonc
{
  "agents": {
    "explorer": { "model": "fast",   "timeout": 90 },
    "planner":  { "model": "strong", "timeout": 180 }
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
  "orchestrator": { "model": "orche",    "thinking": "low" },

  "agents": {
    "planner":      { "model": "strong",   "thinking": "high",   "timeout": 600 },
    "auditor":      { "model": "strong",   "thinking": "high",   "timeout": 300 },
    "fixer":        { "model": "balanced", "thinking": "medium", "timeout": 300 },
    "explorer":     { "model": "fast",     "thinking": "low",    "timeout": 300 },
    "web-searcher": { "model": "fast",     "thinking": "low",    "timeout": 300 }
  },

  "aliases": {
    "strong":   ["google/gemini-2.5-pro",     "anthropic/claude-opus-4-5"],
    "balanced": ["google/gemini-2.5-flash",   "anthropic/claude-sonnet-4-5"],
    "fast":     ["anthropic/claude-haiku-4-5", "openai/gpt-3.5-turbo"],
    "cheap":    ["google/gemini-2.5-flash",   "anthropic/claude-haiku-4-5"],
    "orche":    ["google/gemini-2.5-flash",   "anthropic/claude-haiku-4-5"]
  },

  "compaction": { "model": "cheap" },
  "webSearch":  { "provider": "auto" },
  "title-maker": { "model": "cheap", "thinking": "off" }
}
```

- **Roles** — `orchestrator` and each `agent` map to an alias + `thinking` + `timeout`.
- **Aliases** — ordered fallback chain. First working key wins.
- **Presets** — alias overrides using `alias@preset` naming. Switch at runtime with `/preset`.
- **Thinking** — `off` → `minimal` → `low` → `medium` → `high` → `xhigh`
- **Timeout** — seconds before watchdog kills a stuck agent
- **Compaction** — optional cheaper model for context summarization; falls back to the session model if unset/unavailable.
- **title-maker** — model used to generate conversation titles. Defaults to the `cheap` alias if unset.

#### Role-to-alias mapping

| Role | Alias | Thinking | Timeout |
|------|-------|----------|---------|
| `planner` | `strong` | high | 600s |
| `auditor` | `strong` | high | 300s |
| `fixer` | `balanced` | medium | 300s |
| `explorer` | `fast` | low | 300s |
| `web-searcher` | `fast` | low | 300s |
| `compaction` | `cheap` | — | — |
| `title-maker` | `cheap` | off | — |
| `orchestrator` | `orche` | low | — |

#### Migrating from older configs

The previous `pro`/`flash`/`lite` aliases were renamed to be more descriptive:

| Old alias | New alias |
|-----------|-----------|
| `pro` | `strong` |
| `flash` | `balanced` |
| `lite` | `fast` |
| `orche` | `orche` (unchanged) |
| *(new)* | `cheap` |

### Runtime fallback

On persistent upstream errors (timeout, overload, rate limit, 5xx, auth, …), picopi walks the **full alias chain automatically**, re-attempting the failed task on each successive model in turn. In interactive sessions (tui/rpc) it re-triggers the turn by sending a continuation message on the new model; in json/print (subagent) modes it switches to the next working model for subsequent turns within the subagent session (no auto-continuation). Context-overflow errors are still left to pi's compaction. Disable entirely with `PI_FALLBACK_DISABLE=true`.

**New config knobs** (in `config.json`):
- `fallback.maxHops` — hard cap on automatic hops per unresolved failure (default: chain length − 1).
- `fallback.retrigger` — set to `false` to revert to switch-only behavior without the auto-continuation turn.

**Caveats:** each hop appends a short continuation message and the failed assistant reply is shrunk (not removed), so a small amount of context accumulates per hop until upstream pi exposes a replay API. Non-retryable errors (auth/content-policy/model-not-found) are best-effort detected and switch the model without hammering the chain.

### Presets

Define alias overrides with `@preset` names so you can switch the whole fallback chain at runtime without duplicating the rest of the config.

```jsonc
{
  "aliases": {
    "strong":        ["google/gemini-2.5-pro",   "anthropic/claude-opus-4-5"],
    "strong@fast":   ["google/gemini-2.5-flash"],
    "strong@local":  ["ollama/llama3.3:70b"],

    "balanced":      ["google/gemini-2.5-flash", "anthropic/claude-sonnet-4-5"],
    "balanced@fast": ["google/gemini-2.5-flash"],
    "balanced@local":["ollama/llama3.3:70b"]
  }
}
```

- Run `/preset` for an interactive picker (the active preset is marked); or `/preset fast` to switch directly.
- Switching updates the orchestrator, subagents, compaction, etc. to follow the new chains instantly.
- The last-used preset is tracked **per workspace** and **persists across restarts and session resumes** (stored in `~/.config/picopi/state.json`, keyed by directory).
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

Built-in providers (Anthropic, Google, OpenAI, …) need only `/login`. Use `models.json` **only** for custom providers or gateways: declare them in `~/.config/picopi/models.json`, then reference as `provider/model` in aliases.

See [pi's models docs](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/models.md).

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

## Updating

Nix: Update flake input.

Non-Nix: `picopi --update` — pulls the latest picopi, regenerates the launcher, and runs `pi update pi`. Use `picopi --update --no-pi` to update picopi only (if you manage pi yourself).

