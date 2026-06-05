/**
 * picopi consolidated footer.
 *
 * Replaces pi's built-in footer (via ctx.ui.setFooter) AND picopi's separate
 * status line so the model is shown exactly once — by friendly NAME, not the
 * raw provider id. Layout is two compact lines:
 *
 *   ~/path (branch) • session
 *   ⬡ role  ↑in ↓out R… W… $cost  42%/200k (auto)        Model Name • thinking
 *
 * The picopi glyph + role live on the far left of the stats line, the model
 * name + thinking level on the right. A third line is shown only when there's
 * a warning (e.g. auth failure) so the happy path stays at two lines.
 */

import { isAbsolute, relative, resolve, sep } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { type Component, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

/** picopi-specific footer bits, updated by the orchestrator. */
export interface PicopiFooterState {
	/** Resolved role/alias, e.g. "orchestrator". */
	role?: string;
	/** Warning/error note shown on its own line (rare). */
	note?: string;
	/** Tone for the note line. */
	tone?: "warning" | "error";
	/** Active fallback model spec — shown inline next to model name. */
	fallbackTo?: string;
}

const state: PicopiFooterState = {};
let requestRender: (() => void) | undefined;

/** Update picopi footer state and trigger a re-render. */
export function setPicopiFooter(next: Partial<PicopiFooterState>): void {
	Object.assign(state, next);
	requestRender?.();
}

/** Clear the warning/note line and fallback indicator (back to the happy path). */
export function clearPicopiFooterNote(): void {
	state.note = undefined;
	state.tone = undefined;
	state.fallbackTo = undefined;
	requestRender?.();
}

function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
	return `${Math.round(count / 1000000)}M`;
}

function formatCwd(cwd: string, home: string | undefined): string {
	if (!home) return cwd;
	const rel = relative(resolve(home), resolve(cwd));
	const inside = rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
	if (!inside) return cwd;
	return rel === "" ? "~" : `~${sep}${rel}`;
}

/**
 * Register the picopi footer. Safe to call on every session_start; it simply
 * re-binds the latest context. Pass autoCompact so the context indicator can
 * mirror pi's "(auto)" hint.
 */
export function setupFooter(pi: ExtensionAPI): void {
	pi.on("session_start", (_event, ctx) => {
		if (!ctx.hasUI) return;

		ctx.ui.setFooter((tui, theme, footerData) => {
			requestRender = () => tui.requestRender();
			const unsub = footerData.onBranchChange(() => tui.requestRender());

			return {
				dispose: () => {
					unsub();
					if (requestRender) requestRender = undefined;
				},
				invalidate() {},
				render(width: number): string[] {
					// ---- pwd line -------------------------------------------------
					let pwd = formatCwd(ctx.sessionManager.getCwd(), process.env.HOME || process.env.USERPROFILE);
					const branch = footerData.getGitBranch();
					if (branch) pwd = `${pwd} (${branch})`;
					const sessionName = ctx.sessionManager.getSessionName();
					if (sessionName) pwd = `${pwd} • ${sessionName}`;
					const pwdLine = truncateToWidth(theme.fg("dim", pwd), width, theme.fg("dim", "..."));

					// ---- token totals --------------------------------------------
					let input = 0;
					let output = 0;
					let cacheRead = 0;
					let cacheWrite = 0;
					let cost = 0;
					for (const e of ctx.sessionManager.getEntries()) {
						if (e.type === "message" && e.message.role === "assistant") {
							const m = e.message as AssistantMessage;
							input += m.usage.input;
							output += m.usage.output;
							cacheRead += m.usage.cacheRead;
							cacheWrite += m.usage.cacheWrite;
							cost += m.usage.cost.total;
						}
					}

					// ---- context usage -------------------------------------------
					const usage = ctx.getContextUsage();
					const contextWindow = usage?.contextWindow ?? ctx.model?.contextWindow ?? 0;
					const percentValue = usage?.percent ?? 0;
					const percent = usage?.percent != null ? percentValue.toFixed(1) : "?";
					const ctxText =
						percent === "?"
							? `?/${formatTokens(contextWindow)}`
							: `${percent}%/${formatTokens(contextWindow)}`;
					let ctxStr: string;
					if (percentValue > 90) ctxStr = theme.fg("error", ctxText);
					else if (percentValue > 70) ctxStr = theme.fg("warning", ctxText);
					else ctxStr = theme.fg("dim", ctxText);

					// ---- left side: picopi glyph + role + stats ------------------
					const glyph = state.role
						? theme.fg("accent", "⬡ ") + theme.fg("dim", state.role)
						: theme.fg("accent", "⬡");
					const parts: string[] = [];
					if (input) parts.push(`↑${formatTokens(input)}`);
					if (output) parts.push(`↓${formatTokens(output)}`);
					if (cacheRead) parts.push(`R${formatTokens(cacheRead)}`);
					if (cacheWrite) parts.push(`W${formatTokens(cacheWrite)}`);
					const usingSub = ctx.model ? ctx.modelRegistry.isUsingOAuth(ctx.model) : false;
					if (cost || usingSub) parts.push(`$${cost.toFixed(3)}${usingSub ? " (sub)" : ""}`);
					const statsStr = parts.length ? theme.fg("dim", parts.join(" ")) : "";
					let left = statsStr ? `${glyph}  ${statsStr} ${ctxStr}` : `${glyph}  ${ctxStr}`;
					let leftWidth = visibleWidth(left);
					if (leftWidth > width) {
						left = truncateToWidth(left, width, theme.fg("dim", "..."));
						leftWidth = visibleWidth(left);
					}

					// ---- right side: model NAME + thinking ----------------------
					const modelName = ctx.model?.name || ctx.model?.id || "no-model";
					let rightPlain = modelName;
					let rightColor: "dim" | "warning" = "dim";
					if (state.fallbackTo) {
						const fb = state.fallbackTo;
						const fbProvider = fb.includes("/") ? fb.split("/")[0] : "";
						const fbId = fb.includes("/") ? fb.split("/").pop()! : fb;
						// Show original model + fallback provider/model, compact.
						rightPlain = fbProvider ? `${modelName} ⤵ ${fbProvider}/${fbId}` : `${modelName} ⤵ ${fbId}`;
						rightColor = "warning";
					}
					if (!state.fallbackTo && ctx.model?.reasoning) {
						const level = pi.getThinkingLevel() || "off";
						rightPlain = level === "off" ? `${modelName} • thinking off` : `${modelName} • ${level}`;
					}
					if (footerData.getAvailableProviderCount() > 1 && ctx.model) {
						const withProvider = `(${ctx.model.provider}) ${rightPlain}`;
						if (leftWidth + 2 + visibleWidth(withProvider) <= width) rightPlain = withProvider;
					}
					const right = theme.fg(rightColor, rightPlain);
					const rightWidth = visibleWidth(right);

					// ---- compose stats line -------------------------------------
					let statsLine: string;
					if (leftWidth + 2 + rightWidth <= width) {
						statsLine = left + " ".repeat(width - leftWidth - rightWidth) + right;
					} else {
						const room = width - leftWidth - 2;
						if (room > 0) {
							const cut = truncateToWidth(right, room, "");
							statsLine = left + " ".repeat(Math.max(0, width - leftWidth - visibleWidth(cut))) + cut;
						} else {
							statsLine = left;
						}
					}

					const lines = [pwdLine, statsLine];

					// ---- optional warning/note line -----------------------------
					if (state.note) {
						const tone = state.tone ?? "warning";
						lines.push(truncateToWidth(theme.fg(tone, `⬡ ${state.note}`), width, theme.fg(tone, "...")));
					}

					// ---- other extensions' statuses (picopi no longer uses one) --
					const statuses = footerData.getExtensionStatuses();
					if (statuses.size > 0) {
						const line = Array.from(statuses.entries())
							.sort(([a], [b]) => a.localeCompare(b))
							.map(([, t]) => t.replace(/[\r\n\t]/g, " ").replace(/ +/g, " ").trim())
							.join(" ");
						lines.push(truncateToWidth(line, width, theme.fg("dim", "...")));
					}

					return lines;
				},
			};
		});
	});
}
