/**
 * Config reader — agents reference LABELS that map to explicit fallback chains.
 *
 * Each fallback chain entry is "provider/modelId" — fully explicit.
 * models.json is Pi's model registry only; picopi does NOT read it.
 */

import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const CFG_PATH = join(homedir(), ".pi", "agent", "config.json");

export interface AgentConfig { model: string; thinking?: string; timeout?: number; }
export interface Config {
  orchestrator: { model: string; thinking?: string };
  agents: Record<string, AgentConfig>;
  fallbacks: Record<string, string[]>;
}

let _config: Config | null = null;

/** Strip C-style and // comments (not inside strings), then parse JSON. */
function parseJsonWithComments(raw: string, path: string): any {
  let cleaned = "";
  let inString = false;
  let escape = false;

  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    const next = raw[i + 1];

    if (escape) {
      cleaned += ch;
      escape = false;
      continue;
    }
    if (ch === "\\") {
      cleaned += ch;
      escape = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      cleaned += ch;
      continue;
    }
    if (inString) {
      cleaned += ch;
      continue;
    }
    // Not in string — check for comments
    if (ch === "/" && next === "/") {
      // Skip to end of line
      while (i < raw.length && raw[i] !== "\n") i++;
      cleaned += "\n";
      continue;
    }
    if (ch === "/" && next === "*") {
      // Skip to */
      i += 2;
      while (i < raw.length && !(raw[i] === "*" && raw[i + 1] === "/")) i++;
      i += 1; // skip past /
      continue;
    }
    cleaned += ch;
  }

  // Remove trailing commas before } or ]
  cleaned = cleaned.replace(/,(\s*[}\]])/g, "$1");

  try {
    return JSON.parse(cleaned);
  } catch (err: any) {
    const match = err.message.match(/position (\d+)/);
    if (match) {
      const pos = parseInt(match[1]);
      const lines = raw.slice(0, pos).split("\n");
      const lineNum = lines.length;
      const snippet = raw.split("\n")[lineNum - 1]?.trim();
      throw new Error(
        `JSON syntax error in ${path} at line ${lineNum}\n` +
        `  → ${snippet}\n` +
        `Common causes: trailing comma, missing quote, unclosed bracket.`
      );
    }
    throw new Error(`JSON syntax error in ${path}: ${err.message}`);
  }
}

function loadConfig(): Config {
  if (!existsSync(CFG_PATH)) throw new Error(`config.json not found at ${CFG_PATH}`);
  const raw = readFileSync(CFG_PATH, "utf-8");
  _config = parseJsonWithComments(raw, CFG_PATH);
  return _config;
}

export function getConfig(): Config { return _config || loadConfig(); }
export function reload(): void { _config = null; }

export function getAgent(name: string): AgentConfig | null {
  return getConfig().agents[name] || null;
}

/**
 * Resolve a model label to a fallback chain of explicit provider/modelId entries.
 *
 * Supports two formats:
 *   - "quick"            → label, looks up fallbacks["quick"]
 *   - "deepseek/quick"   → label with preferred provider hint
 *
 * Each chain entry is "provider/modelId" — split to get provider and API model ID.
 */
export function resolveModel(ref: string) {
  const c = getConfig();

  let preferredProvider = "";
  let label = ref;

  if (ref.includes("/")) {
    [preferredProvider, label] = ref.split("/");
  }

  const chain = c.fallbacks[label];
  if (!chain || !chain.length) {
    throw new Error(`No fallback chain for '${label}'. Add fallbacks["${label}"] to config.json.`);
  }

  for (const entry of chain) {
    if (!entry.includes("/")) {
      throw new Error(`Invalid fallback entry '${entry}' — must be "provider/modelId".`);
    }
  }

  const primaryProvider = preferredProvider || chain[0].split("/")[0];

  return {
    label,
    preferredProvider,
    chain,
    parse(entry: string): { provider: string; modelId: string } {
      const [p, m] = entry.split("/");
      return { provider: p, modelId: m };
    },
  };
}
