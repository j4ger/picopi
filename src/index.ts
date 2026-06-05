/**
 * picopi — one extension wiring together web search/fetch, opencode-style undo,
 * todos, a slim multi-agent set, and role/fallback model resolution. All driven
 * by a single config (config.json in the agent dir).
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { configPath, getActivePreset, listPresets, loadConfig, setActivePreset, validateAllResolutions, type ModelRegistryLike, type RoleConfig } from "./config.ts";
import { applyOrchestrator, setupOrchestrator } from "./orchestrator.ts";
import { setupFallback } from "./fallback.ts";
import { setupFooter } from "./footer.ts";
import { setupSubagent } from "./subagent.ts";
import { setupTodo } from "./todo.ts";
import { setupUndo } from "./undo.ts";
import { setupWeb } from "./web.ts";

/** Render read-only lines in a bordered overlay box; closes on Enter/Esc. */
function showBoxedOverlay(ctx: ExtensionCommandContext, lines: string[]): Promise<void> {
	return ctx.ui.custom<void>((_tui, theme, _kb, done) => ({
		render(width: number): string[] {
			const border = (s: string) => theme.fg("accent", s);
			const innerW = Math.max(0, width - 2);
			const hr = "─".repeat(innerW);
			const out = [border("┌" + hr + "┐")];
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
			if (matchesKey(data, "enter") || matchesKey(data, "escape")) done();
		},
	}), { overlay: true });
}

export default function (pi: ExtensionAPI) {
	setupFooter(pi);
	setupOrchestrator(pi);
	setupFallback(pi);
	setupUndo(pi);
	setupTodo(pi);
	setupSubagent(pi);
	setupWeb(pi);

	// --- /preset command ----------------------------------------------------------
	pi.registerCommand("preset", {
		description: "Switch alias preset (interactive picker, or pass a name)",
		getArgumentCompletions: (prefix) => {
			const names = ["default", ...listPresets(loadConfig())];
			const p = prefix.trim().toLowerCase();
			return names
				.filter((n) => n.toLowerCase().startsWith(p))
				.map((n) => ({ value: n, label: n }));
		},
		handler: async (args, ctx) => {
			const cfg = loadConfig();
			const sortedPresets = listPresets(cfg);
			const current = getActivePreset();
			const prevThinking = pi.getThinkingLevel();

			let name = args.trim();
			if (!name) {
				// Interactive picker. "default" reverts to the base (no preset).
				if (!sortedPresets.length) {
					ctx.ui.notify("No presets found. Define them as alias@preset in config.json.", "info");
					return;
				}
				const label = (p: string) => (p === (current || "default") ? `${p} (active)` : p);
				const choice = await ctx.ui.select("Switch preset", ["default", ...sortedPresets].map(label));
				if (!choice) return; // cancelled
				name = choice.replace(/ \(active\)$/, "");
			}

			// Switch mode
			const prev = current;
			if (name !== "default" && !sortedPresets.includes(name)) {
				const hint = sortedPresets.length ? ` Available: ${sortedPresets.join(", ")}` : "";
				ctx.ui.notify(`Unknown preset "${name}".${hint}`, "error");
				return;
			}
			const target = name === "default" ? "" : name;
			setActivePreset(target);
			const res = await applyOrchestrator(pi, ctx, cfg);
			if (!res.ok) {
				// Roll back so we don't leave the session pointing at an unresolved chain,
				// and restore the exact thinking level the user had before the switch.
				setActivePreset(prev);
				await applyOrchestrator(pi, ctx, cfg);
				pi.setThinkingLevel(prevThinking);
				ctx.ui.notify(`Preset "${target || "default"}" not applied: ${res.detail ?? "orchestrator unresolved"}`, "error");
				return;
			}
			const label = target || "default";
			ctx.ui.notify(`Switched to preset "${label}"${res.detail ? ` (${res.detail})` : ""}`, "success");
		},
	});

	// --- /picopi command ----------------------------------------------------------
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
			const activePreset = getActivePreset();
			if (activePreset) lines.push("  " + th.fg("dim", "preset: ") + th.fg("accent", activePreset));

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

			await showBoxedOverlay(ctx, lines);
		},
	});
}
