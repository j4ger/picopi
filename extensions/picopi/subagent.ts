/**
 * Subagent tool — spawn isolated Pi processes with provider fallback
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { spawn } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { getConfig, getAgent, resolveModel, getProvider } from "./config";

const AGENTS_DIR = join(homedir(), ".pi", "agent", "agents");
const MAX_DEPTH = 3;
let currentDepth = 0;

const schema = Type.Object({
  agent: Type.String({ description: "planner, explorer, fixer, or auditor" }),
  task: Type.String({ description: "Full task description with all context" }),
});

export function registerSubagentTool(pi: ExtensionAPI) {
  pi.registerTool({
    name: "subagent",
    label: "Subagent",
    description: "Spawn an isolated specialist agent. Use: planner (architecture), explorer (investigation), fixer (bugs), auditor (review).",
    parameters: schema,
    async execute(_id, params, signal, onUpdate) {
      return runSubagent(params, onUpdate, signal);
    },
  });
}

async function runSubagent(
  params: { agent: string; task: string },
  onUpdate: (u: { content: Array<{ type: "text"; text: string }> }) => void,
  signal: AbortSignal
) {
  const cfg = getConfig();

  // Depth guard — global counter, decremented in finally to prevent leaks on throw
  currentDepth++;
  if (currentDepth > MAX_DEPTH) {
    currentDepth--;
    return { content: [{ type: "text", text: `[subagent] Max depth (${MAX_DEPTH}) reached.` }] };
  }

  try {
    const agent = getAgent(params.agent);
    if (!agent) {
      return { content: [{ type: "text", text: `[subagent] Unknown agent '${params.agent}'. Available: ${Object.keys(cfg.agents).join(", ")}` }] };
    }

    const agentFile = join(AGENTS_DIR, `${params.agent}.md`);
    let systemPrompt = "";
    if (existsSync(agentFile)) {
      const content = readFileSync(agentFile, "utf-8");
      const match = content.match(/^---\n[\s\S]*?\n---\n([\s\S]*)$/);
      systemPrompt = (match ? match[1] : content).trim();
    }

    const fullPrompt = [systemPrompt, "=== YOUR TASK ===", params.task].filter(Boolean).join("\n\n");
    const resolver = resolveModel(agent.model);

    for (const entry of resolver.chain) {
      const { provider, modelId } = resolver.parse(entry);
      const p = getProvider(provider);
      if (!p || !p.key) {
        onUpdate({ content: [{ type: "text", text: `[subagent] ${provider}: no key in config.json` }] });
        continue;
      }

      onUpdate({ content: [{ type: "text", text: `[subagent] ${params.agent} (${resolver.label}) via ${provider}...` }] });

      try {
        const result = await spawnPi(p.baseUrl, modelId, agent.thinking, p.api, fullPrompt, agent.timeout || 300, signal);
        return { content: [{ type: "text", text: result }] };
      } catch (err: any) {
        onUpdate({ content: [{ type: "text", text: `[subagent] ${provider} failed: ${err.message}` }] });
        continue;
      }
    }

    return { content: [{ type: "text", text: `[subagent] All providers failed for '${params.agent}'.` }] };
  } finally {
    currentDepth--;
  }
}

function spawnPi(
  baseUrl: string, modelId: string, thinking: string | undefined,
  api: string, prompt: string, timeoutSec: number, signal: AbortSignal
): Promise<string> {
  return new Promise((resolve, reject) => {
    const args = ["--mode", "json", "-p", "--no-session", "--provider-url", baseUrl, "--api", api, "--model", modelId];
    if (thinking) args.push("--thinking", thinking);

    // PI_OFFLINE=1 speeds up subagent spawn by skipping startup network ops
    const child = spawn("pi", args, {
      env: { ...process.env, PI_OFFLINE: "1" },
      stdio: ["pipe", "pipe", "pipe"],
      timeout: timeoutSec * 1000,
    });

    let stdout = "";
    let stderr = "";

    child.stdin.write(prompt);
    child.stdin.end();
    child.stdout.on("data", d => { stdout += d.toString(); });
    child.stderr.on("data", d => { stderr += d.toString(); });

    const onAbort = () => { child.kill("SIGTERM"); reject(new Error("Aborted")); };
    signal.addEventListener("abort", onAbort);

    child.on("close", code => {
      signal.removeEventListener("abort", onAbort);
      if (code !== 0) { reject(new Error(stderr.slice(0, 200))); return; }
      // Extract final assistant message from JSONL
      try {
        let text = "";
        for (const line of stdout.trim().split("\n")) {
          const ev = JSON.parse(line);
          if (ev.type === "assistant_message" && ev.data?.text) text = ev.data.text;
        }
        resolve(text || stdout);
      } catch { resolve(stdout); }
    });
    child.on("error", err => { signal.removeEventListener("abort", onAbort); reject(err); });
  });
}
