/**
 * picopi — opinionated pi setup: web search/fetch, opencode-style undo,
 * todos, a slim multi-agent set, and role/fallback model resolution. All driven
 * by a single config (config.json in the agent dir).
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { configPath, getActivePreset, listPresets, loadConfig, resolveChain, setActivePreset, validateAllResolutions, type ModelRegistryLike, type RoleConfig } from "./config.ts";
import { applyOrchestrator, setupOrchestrator } from "./orchestrator.ts";
import { setCurrentModel, getCurrentAlias, getCurrentModelSpec, findInChain, setupFallback } from "./fallback.ts";
import { clearPicopiFooterNote, setupFooter } from "./footer.ts";
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

	// --- /fallback command ------------------------------------------------------
	pi.registerCommand("fallback", {
		description: "Select a model in the fallback chain (interactive picker, or 'reset' to go back to the top)",
		handler: async (args, ctx) => {
			const currentAlias = getCurrentAlias();
			if (!currentAlias) {
				ctx.ui.notify("No fallback chain active — set orchestrator.model in config.json", "warning");
				return;
			}

			const cfg = loadConfig();
			const chain = resolveChain(cfg, currentAlias);
			if (chain.length <= 1) {
				ctx.ui.notify(`Fallback chain for "${currentAlias}" has only one model`, "info");
				return;
			}

			const currentSpec = getCurrentModelSpec();
			const currentIdx = findInChain(chain, currentSpec);

			let targetIdx: number;

			const raw = args.trim().toLowerCase();
			if (raw === "reset") {
				targetIdx = 0;
			} else if (raw) {
				// Try matching by model spec substring
				const matchIdx = findInChain(chain, args.trim());
				if (matchIdx >= 0) {
					targetIdx = matchIdx;
				} else {
					ctx.ui.notify(`"${args.trim()}" not in fallback chain: ${chain.join(", ")}`, "error");
					return;
				}
			} else {
				// Interactive picker
				const labels = chain.map((spec, i) => {
					const marker = i === currentIdx ? " (current)" : "";
					return `${i + 1}. ${spec}${marker}`;
				});
				const choice = await ctx.ui.select("Select fallback model (Esc to cancel)", labels);
				if (choice === undefined) return;
				targetIdx = labels.indexOf(choice);
			}

			const targetSpec = chain[targetIdx];
			if (targetSpec === currentSpec) {
				ctx.ui.notify(`Already using ${targetSpec}`, "info");
				return;
			}

			// Resolve and switch
			const slash = targetSpec.indexOf("/");
			if (slash <= 0) {
				ctx.ui.notify(`Malformed model spec: ${targetSpec}`, "error");
				return;
			}
			const provider = targetSpec.slice(0, slash);
			const modelId = targetSpec.slice(slash + 1);

			const model = ctx.modelRegistry.find(provider, modelId);
			if (!model) {
				ctx.ui.notify(`Model ${targetSpec} not found in registry — run /login`, "error");
				return;
			}

			const success = await pi.setModel(model as any);
			if (!success) {
				ctx.ui.notify(`Failed to switch to ${targetSpec} (no API key?)`, "error");
				return;
			}

			setCurrentModel(targetSpec);
			clearPicopiFooterNote();
			ctx.ui.notify(`Switched to ${targetSpec} (${targetIdx + 1}/${chain.length} in chain)`, "success");
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
