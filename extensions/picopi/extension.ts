/**
 * picopi — Multi-tier agent extension for Pi
 *
 * Auto-delegates tasks to specialist subagents with streaming,
 * transparent provider fallback, auto-checkpoints, and a dashboard widget.
 *
 * All config (agents, providers, keys) lives in ~/.pi/agent/config.json
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getConfig, reload } from "./config";
import { registerSubagentTool } from "./subagent";
import { registerCheckpoint } from "./checkpoint";
import { registerTodoTool } from "./todo";
import { registerDashboard } from "./dashboard";
import { registerCompactionHook } from "./compaction";
import { registerFallback } from "./fallback";

let _configErr: string | null = null;

export default function (pi: ExtensionAPI) {
  // Attempt initial load — capture error for later display
  try {
    reload();
    _configErr = null;
  } catch (err: any) {
    _configErr = err.message || String(err);
    pi.on("session_start", async (_e, ctx) => {
      ctx.ui.notify(`picopi config error: ${_configErr}. Run ./install.sh`, "warning");
    });
  }

  registerSubagentTool(pi);
  registerCheckpoint(pi);
  registerTodoTool(pi);
  registerDashboard(pi);
  registerFallback(pi);
  registerCompactionHook(pi);

  pi.registerCommand("picopi", {
    description: "Show picopi status",
    handler: async (_args, ctx) => {
      if (_configErr) { ctx.ui.notify(`Config error: ${_configErr}`, "warning"); return; }
      try {
        const cfg = getConfig();
        ctx.ui.notify(`Agents: ${Object.keys(cfg.agents).join(", ")}`, "info");
      } catch (err: any) {
        ctx.ui.notify(`Error: ${err.message}`, "error");
      }
    },
  });

  pi.registerCommand("reload-config", {
    description: "Reload config.json",
    handler: async (_args, ctx) => {
      try { reload(); _configErr = null; ctx.ui.notify("Config reloaded", "success"); }
      catch (err: any) { _configErr = err.message; ctx.ui.notify(`Reload failed: ${err.message}`, "error"); }
    },
  });
}
