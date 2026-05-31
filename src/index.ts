/**
 * picopi — one extension wiring together web search/fetch, opencode-style undo,
 * todos, a slim multi-agent set, and role/fallback model resolution. All driven
 * by a single config (config.json in the agent dir).
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { configPath, loadConfig, validateAllResolutions, type ModelRegistryLike, type RoleConfig } from "./config.ts";
import { setupFooter } from "./footer.ts";
import { setupOrchestrator } from "./orchestrator.ts";
import { setupSubagent } from "./subagent.ts";
import { setupTodo } from "./todo.ts";
import { setupUndo } from "./undo.ts";
import { setupWeb } from "./web.ts";

export default function (pi: ExtensionAPI) {
	setupFooter(pi);
	setupOrchestrator(pi);
	setupUndo(pi);
	setupTodo(pi);
	setupSubagent(pi);
	setupWeb(pi);

	pi.registerCommand("picopi", {
		description: "Show picopi config status (Enter or Esc to close)",
		handler: async (_args, ctx) => {
			const cfg = loadConfig();
			const th = ctx.ui.theme;
			const report = await validateAllResolutions(ctx.modelRegistry as unknown as ModelRegistryLike, cfg);
			const resultMap = new Map(report.results.map((r) => [r.role, r]));

			const row = (name: string, r: { model: string; thinking?: string; timeout?: number }, ok?: boolean, resolved?: string) => {
				const indicator = ok === true ? th.fg("success", "✓ ") : ok === false ? th.fg("error", "✗ ") : "  ";
				const resolvedPart = resolved ? th.fg("dim", ` → ${resolved}`) : "";
				return indicator + th.fg("text", name.padEnd(13)) + th.fg("accent", r.model) + resolvedPart + th.fg("dim", ` ·${r.thinking ?? "off"}`) + (r.timeout ? th.fg("dim", ` ${r.timeout}s`) : "");
			};

			const lines: string[] = [];
			lines.push(th.fg("accent", " ⬡ picopi") + "  " + th.fg("dim", configPath() ?? "(defaults)"));

			if (cfg.orchestrator) {
				const res = resultMap.get("orchestrator");
				lines.push(row("orchestrator", cfg.orchestrator, res?.ok, res?.resolved));
				if (res && !res.ok) {
					for (const issue of res.issues) {
						lines.push("      " + th.fg("error", `${issue.spec || res.alias} → ${issue.reason}`));
					}
				}
			}
			for (const [name, r] of Object.entries(cfg.agents ?? {})) {
				const res = resultMap.get(`agent:${name}`);
				lines.push(row(name, r, res?.ok, res?.resolved));
				if (res && !res.ok) {
					for (const issue of res.issues) {
						lines.push("      " + th.fg("error", `${issue.spec || res.alias} → ${issue.reason}`));
					}
				}
			}
			if (cfg.compaction?.model) {
				const res = resultMap.get("compaction");
				lines.push(row("compaction", { model: cfg.compaction.model } as RoleConfig, res?.ok, res?.resolved));
				if (res && !res.ok) {
					for (const issue of res.issues) {
						lines.push("      " + th.fg("error", `${issue.spec || res.alias} → ${issue.reason}`));
					}
				}
			}

			for (const [alias, models] of Object.entries(cfg.aliases ?? {})) {
				lines.push("  " + th.fg("muted", `${alias} → `) + th.fg("dim", models.join(" → ")));
			}

			await ctx.ui.custom<void>((_tui, _theme, _kb, done) => {
				return {
					render(width: number): string[] {
						const out: string[] = [];
						const border = (s: string) => th.fg("accent", s);
						const innerW = Math.max(0, width - 2);
						const hr = "─".repeat(innerW);
						out.push(border("┌" + hr + "┐"));
						for (const raw of lines) {
							const inner = truncateToWidth(raw, innerW);
							const pad = innerW - visibleWidth(inner);
							out.push(border("│") + inner + " ".repeat(Math.max(0, pad)) + border("│"));
						}
						out.push(border("└" + hr + "┘"));
						return out;
					},
					invalidate(): void {},
					handleInput(data: string): void {
						if (matchesKey(data, "enter") || matchesKey(data, "escape")) {
							done();
						}
					},
				};
			}, { overlay: true });
		},
	});
}
