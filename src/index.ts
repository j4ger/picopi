/**
 * picopi — one extension wiring together web search/fetch, opencode-style undo,
 * todos, a slim multi-agent set, and role/fallback model resolution. All driven
 * by a single config (config.json in the agent dir).
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { configPath, loadConfig } from "./config.ts";
import { setupOrchestrator } from "./orchestrator.ts";
import { setupSubagent } from "./subagent.ts";
import { setupTodo } from "./todo.ts";
import { setupUndo } from "./undo.ts";
import { setupWeb } from "./web.ts";

export default function (pi: ExtensionAPI) {
	setupOrchestrator(pi);
	setupUndo(pi);
	setupTodo(pi);
	setupSubagent(pi);
	setupWeb(pi);

	pi.registerCommand("picopi", {
		description: "Show resolved roles, models, and config source",
		handler: async (_args, ctx) => {
			const cfg = loadConfig();
			const th = ctx.ui.theme;
			const row = (name: string, r: { model: string; thinking?: string; timeout?: number }) =>
				"  " + th.fg("text", name.padEnd(13)) + th.fg("accent", r.model) + th.fg("dim", ` ·${r.thinking ?? "off"}`) + (r.timeout ? th.fg("dim", ` ${r.timeout}s`) : "");

			const lines = [th.fg("accent", " ⬡ picopi"), "  " + th.fg("dim", configPath() ?? "(defaults)"), ""];
			if (cfg.orchestrator) lines.push(row("orchestrator", cfg.orchestrator));
			for (const [name, r] of Object.entries(cfg.agents ?? {})) lines.push(row(name, r));
			lines.push("");
			for (const [alias, models] of Object.entries(cfg.aliases ?? {}))
				lines.push("  " + th.fg("muted", `${alias} → `) + th.fg("dim", models.join(" → ")));
			if (cfg.compaction?.model) lines.push("  " + th.fg("muted", "compaction → ") + th.fg("dim", cfg.compaction.model));

			ctx.ui.setWidget("picopi-config", lines);
			ctx.ui.notify("picopi config shown in widget", "info");
		},
	});
}
