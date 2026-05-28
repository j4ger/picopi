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
  pi.on("session_start", (_e, ctx) => {
    try {
      const resolved = resolveModel(getConfig().orchestrator.model);
      const orch = resolved.parse(resolved.chain[0]).modelId;
      ctx.ui.setStatus("picopi", `◆ ${orch}`);
    } catch {
      ctx.ui.setStatus("picopi", "◆ picopi — config error");
    }
  });
}

function update(ctx: ExtensionContext) {
  try {
    const parts: string[] = [];
    const cfg = getConfig();

    // Provider health (count providers with non-empty keys)
    let healthy = 0, total = 0;
    for (const [, p] of Object.entries(cfg.providers)) {
      total++;
      if (p.key && p.key.length > 0 && !p.key.includes("YOUR_")) healthy++;
    }
    parts.push(`●${healthy}/${total}`);

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
