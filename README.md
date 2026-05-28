# picopi

Multi-tier agent extension for Pi — auto-delegates to specialist subagents (planner, explorer, fixer, auditor).

## Install

```bash
git clone <repo> && cd picopi
./install.sh                # full install
./install.sh --skip-config  # update extension only (preserves your config)
```

After install, edit the two config files:

| File | Purpose |
|------|---------|
| `~/.pi/agent/models.json` | Providers, API keys, model definitions |
| `~/.pi/agent/config.json` | Agent labels, fallback chains, thinking levels |

Then launch Pi and reload:

```bash
pi
/reload
```

> Ensure `~/.pi/agent/settings.json` has `defaultModel` + `defaultProvider` matching a model from `models.json`, or Pi will show a harmless startup warning.

## How it works

```
You: "Add auth to our API"
  → subagent(explorer)   — investigates codebase
  → subagent(planner)    — designs architecture
  → orchestrator implements
  → subagent(auditor)    — reviews
  → "Done."
```

## Configuration

### config.json — agent labels + fallback chains

```json
{
  "orchestrator": { "model": "quick", "thinking": "high" },
  "agents": {
    "planner":  { "model": "pro",   "thinking": "xhigh", "timeout": 600 },
    "explorer": { "model": "lite",  "thinking": "off",   "timeout": 300 },
    "fixer":    { "model": "quick", "thinking": "off",   "timeout": 180 },
    "auditor":  { "model": "pro",   "thinking": "high",  "timeout": 300 }
  },
  "fallbacks": {
    "quick": ["deepseek/deepseek-v4-flash",         "sensenova/deepseek-v4-flash"],
    "pro":   ["deepseek/deepseek-v4-pro",           "sensenova/deepseek-v4-pro"],
    "lite":  ["sensenova/sensenova-6.7-flash-lite", "deepseek/deepseek-v4-flash"]
  },
  "compaction": { "model": "lite" }
}
```

Agent labels (`quick`, `pro`, `lite`) map to explicit `provider/modelId` fallback chains. The first working provider wins.

`compaction.model` routes context summarization through a cheaper model instead of your session model.

### models.json — Pi's model registry

```json
{
  "providers": {
    "deepseek": {
      "baseUrl": "https://api.deepseek.com",
      "api": "openai-completions",
      "apiKey": "sk-...",
      "authHeader": true,
      "models": [
        { "id": "deepseek-v4-flash", "name": "ds-flash", "contextWindow": 128000, "maxTokens": 16384, "reasoning": true },
        { "id": "deepseek-v4-pro",   "name": "ds-pro",   "contextWindow": 128000, "maxTokens": 16384, "reasoning": true }
      ]
    }
  }
}
```

This is Pi's native config — picopi does not read it. Pi uses it to resolve credentials when subagents are spawned via `--model provider/modelId`.

### Agent prompts

Edit `~/.pi/agent/agents/*.md` to customize behavior. Frontmatter controls model, thinking, tools, and timeout per agent.

## Commands

| Command | Action |
|---------|--------|
| `/checkpoint [label]` | Save workspace snapshot |
| `/undo` | Undo last turn — restores files + conversation |
| `/redo` | Re-apply undone turn |
| `/todos` | Show project todo list |
| `/picopi` | Show extension status |
| `/reload-config` | Reload config.json |

## Limitations

| Area | Constraints |
|------|-------------|
| **Subagents** | Spawns child `pi` processes. Max depth 3. Output parsing is best-effort. |
| **Checkpoints** | Uses git shadow repos. 30s rsync timeout. Keyed to project path — renaming the folder orphans history. After 50+ turns, old history compresses into one commit. |
| **Provider fallback** | Only HTTP 500+ and 429 trigger failover. Fixed 60s cooldown. |
| **Config** | `/reload-config` required after manual edits. `settings.json` must reference models that exist in `models.json`. |
| **State** | Concurrent Pi sessions on the same project may corrupt todo/checkpoint metadata. Old files in `~/.pi/agent/todos/` and `checkpoints/` are never auto-cleaned. |

## Files

```
config.json          agent labels, fallback chains
models.json          Pi's model registry (providers, keys)
AGENTS.md            orchestrator system prompt
agents/*.md          subagent prompts
extensions/picopi/   the extension
install.sh           installer
```

## License

MIT