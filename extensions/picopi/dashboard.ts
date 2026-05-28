/**
 * Dashboard widget — status bar in Pi's footer
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { getConfig, resolveModel } from "./config";

const TODO_DIR = join(homedir(), ".pi", "agent", "todos");
const PROJECT_KEY = createHash("sha256").update(process.cwd()).digest("hex").slice(0, 16);

function todoFile(): string {
  return join(TODO_DIR, `${PROJECT_KEY}.json`);
}

export function registerDashboard(pi: ExtensionAPI) {
  for (const ev of ["turn_start", "tool_execution_end", "model_select"] as const) {
    pi.on(ev, (_e, ctx) => update(ctx));
  }
  pi.on("session_start", async (_e, ctx) => {
    try {
      const resolved = resolveModel(getConfig().orchestrator.model);
      const { provider, modelId } = resolved.parse(resolved.chain[0]);

      // Status bar
      ctx.ui.setStatus("picopi", `◆ ${modelId}`);

      // Sync Pi's TUI footer model display to match the orchestrator
      const model = ctx.modelRegistry?.find(provider, modelId);
      if (model) await pi.setModel(model);
    } catch {
      ctx.ui.setStatus("picopi", "◆ picopi — config error");
    }
  });
}

function update(ctx: ExtensionContext) {
  try {
    const parts: string[] = [];

    // Context usage
    const usage = ctx.getContextUsage?.();
    if (usage) {
      const pct = Math.round(usage.percent || 0);
      const bar = "█".repeat(Math.round(pct / 12.5)) + "░".repeat(8 - Math.round(pct / 12.5));
      parts.push(`${bar} ${pct}%`);
    }

    // Todos (per-project)
    const tf = todoFile();
    if (existsSync(tf)) {
      try {
        const pending = JSON.parse(readFileSync(tf, "utf-8")).filter((t: any) => t.status !== "done").length;
        if (pending > 0) parts.push(`☰${pending}`);
      } catch { /* ignore */ }
    }

    ctx.ui.setStatus("picopi", parts.join(" | "));
  } catch { /* best-effort */ }
}
