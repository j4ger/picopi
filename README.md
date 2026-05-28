# picopi

Multi-tier agent for Pi. Auto-delegates to specialist subagents via a native `subagent` tool.

## Install

```bash
git clone <repo> && cd picopi
./install.sh           # full install (backs up existing config)
./install.sh --skip-config  # update extension only (preserves config)
```

`./install.sh` will:
1. Detect and **back up** any existing `config.json` or `models.json` (with a `.bak.<timestamp>` suffix)
2. Copy new template files into `~/.pi/agent/`
3. Copy the extension into `~/.pi/agent/extensions/`

Use `--skip-config` when updating picopi to a new version — it skips copying `config.json` and `models.json` so your existing keys and fallback chains are preserved.

After installation, **edit `~/.pi/agent/config.json`** to add your API keys and configure fallback chains.

> **⚠️ settings.json:** Ensure `~/.pi/agent/settings.json` has `defaultModel` + `defaultProvider` set to a model that actually exists in your `models.json`. Otherwise Pi may show a harmless-but-annoying "No models match pattern" warning. Example:
>
> ```json
> { "defaultProvider": "insta", "defaultModel": "claude-sonnet-4-6" }
> ```

Then launch Pi:

```bash
pi
/reload
```

Or install manually:

```bash
mkdir -p ~/.pi/agent/{agents,extensions}
cp -r extensions/picopi ~/.pi/agent/extensions/
cp config.json models.json AGENTS.md ~/.pi/agent/
cp agents/*.md ~/.pi/agent/agents/
# Edit ~/.pi/agent/config.json — add your providers and keys
pi
/reload
```

## How It Works

```
You: "Add auth to our API"
  → Orchestrator calls subagent(agent="explorer")
  → explorer investigates, returns findings
  → Orchestrator calls subagent(agent="planner")
  → planner designs architecture
  → Orchestrator implements
  → Orchestrator calls subagent(agent="auditor")
  → auditor reviews, issues fixed
  → "Done."
```

## Configuration

Two config systems live side by side. Don't mix them up:

| File | Who reads it | What to put there |
|------|-------------|-------------------|
| **`~/.pi/agent/config.json`** | **picopi** | Agent models, thinking levels, fallback chains. **This is the one you edit most.** |
| **`~/.pi/agent/models.json`** | **Pi** | Model registry — tells Pi what models exist for the `/model` picker. picopi does NOT read this. |
| **`~/.pi/agent/settings.json`** | **Pi** | Pi's runtime settings (default model, compaction, etc.). Set `defaultModel` + `defaultProvider` to match a model in `models.json` to avoid startup warnings. |
| **`~/.pi/agent/AGENTS.md`** | **Pi** | Orchestrator system prompt — loaded automatically on every turn. |

**NEVER commit or share `config.json`.** It contains your API keys.

`config.json` supports `//` line comments and trailing commas for convenience — they're stripped before parsing.

### Mental model: labels + explicit fallback chains

Agents reference **labels** (quick, pro, lite) that map to explicit `provider/modelname` fallback chains:

| Label | Meaning | Typical use |
|-------|---------|-------------|
| **`quick`** | Fast, cheap, no reasoning | Exploration, fixes, simple tasks |
| **`pro`** | Strong reasoning, highest quality | Architecture, planning, audits |
| **`lite`** | Ultra-cheap, lightweight, often vision-capable | Grep-heavy exploration, file listing |

Each label's fallback chain in `config.json` lists exact `provider/modelname` entries in priority order:

```json
"fallbacks": {
  "quick": ["deepseek/deepseek-v4-flash", "sensenova/deepseek-v4-flash"]
}
```

This means: for `quick`, try DeepSeek's `deepseek-v4-flash` first, then SenseNova's `deepseek-v4-flash` if DeepSeek fails. Fully explicit — no hidden lookups.

### Quick rule

- Adding a **new provider or API key** → edit `models.json`
- Changing which model an agent uses → edit the fallback chain in `config.json`
- Changing **agent behavior or prompts** → edit `agents/*.md`

### Setting up providers

Edit `~/.pi/agent/config.json` to set your agent models and fallback chains:

```json
{
  "orchestrator": {
    "model": "quick",
    "thinking": "high"
  },
  "agents": {
    "planner":  { "model": "pro",   "thinking": "xhigh", "timeout": 600 },
    "explorer": { "model": "lite",  "thinking": "off",   "timeout": 300 },
    "fixer":    { "model": "quick", "thinking": "off",   "timeout": 180 },
    "auditor":  { "model": "pro",   "thinking": "high",  "timeout": 300 }
  },
  "fallbacks": {
    "quick": ["deepseek/deepseek-v4-flash",           "sensenova/deepseek-v4-flash"],
    "pro":   ["deepseek/deepseek-v4-pro",             "sensenova/deepseek-v4-pro"],
    "lite":  ["sensenova/sensenova-6.7-flash-lite",   "deepseek/deepseek-v4-flash"]
  }
}
```

Also add provider entries to `~/.pi/agent/models.json` so Pi knows about them:

```json
{
  "providers": {
    "deepseek": {
      "baseUrl": "https://api.deepseek.com",
      "api": "openai-completions",
      "apiKey": "sk-...",
      "authHeader": true,
      "models": [
        { "id": "deepseek-v4-flash", "name": "ds-flash", "input": ["text"], "contextWindow": 128000, "maxTokens": 16384, "reasoning": true },
        { "id": "deepseek-v4-pro",   "name": "ds-pro",   "input": ["text"], "contextWindow": 128000, "maxTokens": 16384, "reasoning": true }
      ]
    },
    "sensenova": {
      "baseUrl": "https://token.sensenova.cn/v1",
      "api": "openai-completions",
      "apiKey": "sk-...",
      "authHeader": true,
      "models": [
        { "id": "sensenova-6.7-flash-lite", "name": "sense-lite", "input": ["text","image"], "contextWindow": 256000, "maxTokens": 64000, "reasoning": false },
        { "id": "deepseek-v4-pro",         "name": "ds-pro",     "input": ["text"], "contextWindow": 128000, "maxTokens": 16384, "reasoning": true }
      ]
    }
  }
}
```

### Using a cheap model for compaction

Pi's native compaction uses your session's current model. If that's an expensive model, compaction gets costly. picopi can route compaction summaries through a cheaper model.

```json
{
  "compaction": {
    "model": "lite"
  }
}
```

If `compaction.model` is set, all `/compact` and auto-compaction summaries go through that model. If not set, Pi uses the session's current model.

Pi's auto-compaction triggers when `contextTokens > contextWindow - 16384` (reserving 16K tokens for the response). This is Pi's built-in default and works well — no configuration needed.

### Customizing agents

Agent prompts are markdown files in `~/.pi/agent/agents/`:

| File | Role |
|------|------|
| `planner.md` | Architecture and design |
| `explorer.md` | Code investigation |
| `fixer.md` | Bug fixes |
| `auditor.md` | Code review and security |

Edit these files to customize behavior. The frontmatter (`--- name/thinking/tools/timeout ---`) controls which model and tools the agent uses.

## Commands

| Command | Action |
|---------|--------|
| `/checkpoint [label]` | Save a named workspace snapshot |
| `/undo` | Undo last turn — restores workspace and puts your message back in the input box |
| `/redo` | Re-apply what was undone |
| `/todos` | Show todo list |
| `/picopi` | Show status |
| `/reload-config` | Reload config.json |

### Checkpoints work like opencode

Before Pi processes any of your messages, a snapshot of **both workspace AND conversation** is saved automatically.

```
You: "refactor auth"          ← checkpoint saved (files + conversation tree entry)
  → Pi works, edits files...
  → Something goes wrong
You: /undo                    ← workspace restored to pre-"refactor auth" state
                                conversation rolled back to that point
                                your message "refactor auth" appears in the input box
                                edit and retry
```

This is **turn-based** — one snapshot per message. It uses Pi's session tree API (`ctx.navigateTree`) for true conversation rollback plus git shadow repos for file rollback.

## Files

```
config.json          # agent models, fallback chains, thinking levels
models.json          # Pi's model registry (providers, API keys, model defs)
AGENTS.md            # orchestrator instructions
agents/*.md          # subagent system prompts
extensions/picopi/   # the extension (8 TypeScript modules + package.json)
install.sh           # copies files, points you to config.json
```

## Security

- `config.json` has `chmod 600` — only the owner can read it
- `~/.pi/agent/` has `chmod 700` — only the owner can access it
- **NEVER commit `config.json`** — it contains API keys
- **NEVER share `config.json`**

## Limitations

Honest constraints you may hit:

**Checkpoints**
- Keyed to your directory path at module load — rename the project folder and history becomes unreachable.
- Old checkpoint repos in `~/.pi/agent/checkpoints/` are never auto-cleaned.
- 30s rsync timeout — very large projects may skip checkpointing silently.
- `cp` fallback (when rsync unavailable) copies files but doesn't remove deleted ones — undo may leave stale files.
- `.last-input` stores only the most recent message — `/undo` twice and the second-to-last message is lost.
- After history compression (50+ turns), conversation rollback can't go past the compressed boundary.
- Session tree APIs are reverse-engineered, not documented by Pi. May break in future versions. Graceful fallback to file-only rollback.

**Subagents**
- Spawns child `pi` processes — no built-in subagent API in Pi. `PI_OFFLINE=1` mitigates startup latency.
- Child reads `~/.pi/agent/config.json` for auth — assumes all agents use the same config file.
- `MAX_DEPTH = 3` — hard limit on nested subagent calls.
- JSONL output parsing is fragile — malformed lines from the child are silently skipped.

**Provider fallback**
- Only HTTP 500+ and 429 trigger failover. Timeouts, DNS failures, and connection errors do not.
- If all providers fail, the extension gives up silently — Pi retries with the original failing provider.
- Fixed 60s cooldown — no exponential backoff.

**Config**
- `config.json` — edit `~/.pi/agent/config.json`, run `/reload-config`.
- `settings.json` — ensure `defaultModel` + `defaultProvider` match a model in `models.json`, otherwise Pi shows "No models match pattern" on startup. This is cosmetic (the extension overrides the model anyway), but keeps logs clean.

**State files**
- Concurrent writes from multiple Pi processes on the same project could corrupt todo or checkpoint metadata (rare — typically one session per project).
- Old per-project todo files in `~/.pi/agent/todos/` are never auto-cleaned.

## License

MIT
