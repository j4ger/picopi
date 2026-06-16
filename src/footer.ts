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
import type { ExtensionAPI, ThemeColor } from "@earendil-works/pi-coding-agent";
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
	/** Original model name before fallback switch — shown in the footer. */
	originalModel?: string;
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
			const myRender = () => tui.requestRender();
			requestRender = myRender;
			const unsub = footerData.onBranchChange(() => tui.requestRender());

			return {
				dispose: () => {
					unsub();
					if (requestRender === myRender) requestRender = undefined;
				},
				invalidate() {},
				render(width: number): string[] {
					const ELLIPSIS = "...";
					const SEP = " • ";
					const fg = (key: string, fallback: ThemeColor, text: string): string => {
						try { return theme.fg(key as ThemeColor, text); } catch { return theme.fg(fallback, text); }
					};
					const contextSeverity = (pct: number): ThemeColor => {
						if (pct > 90) return "error";
						if (pct > 70) return "warning";
						return "footerStats" as ThemeColor;
					};
					const fitColumns = (left: string, right: string, w: number): string => {
						const lw = visibleWidth(left);
						const rw = visibleWidth(right);
						if (lw + 2 + rw <= w) return left + " ".repeat(w - lw - rw) + right;
						const room = w - lw - 2;
						if (room > 0) {
							const cut = truncateToWidth(right, room, "");
							return left + " ".repeat(Math.max(0, w - lw - visibleWidth(cut))) + cut;
						}
						return left;
					};

					// ---- pwd line -------------------------------------------------
					let pwdPath = formatCwd(ctx.sessionManager.getCwd(), process.env.HOME || process.env.USERPROFILE);
					const branch = footerData.getGitBranch();
					if (branch) pwdPath = `${pwdPath} ${theme.fg("accent", `(${branch})`)}`;
					const sessionName = ctx.sessionManager.getSessionName();
					if (sessionName) pwdPath = `${pwdPath} ${theme.fg("muted", `${SEP}${sessionName}`)}`;
					const pwdLine = truncateToWidth(fg("footerPath", "dim", pwdPath), width, fg("footerPath", "dim", ELLIPSIS));

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
					const severity = contextSeverity(percentValue);
					const ctxStr = severity === "footerStats"
						? fg("footerStats", "dim", ctxText)
						: theme.fg(severity, ctxText);

					// ---- left side: picopi glyph + role + stats ------------------
					const glyph = state.role
						? theme.fg("accent", "⬡ ") + fg("footerStats", "dim", state.role)
						: theme.fg("accent", "⬡");
					const parts: string[] = [];
					if (input) parts.push(`↑${formatTokens(input)}`);
					if (output) parts.push(`↓${formatTokens(output)}`);
					if (cacheRead) parts.push(`R${formatTokens(cacheRead)}`);
					if (cacheWrite) parts.push(`W${formatTokens(cacheWrite)}`);
					const usingSub = ctx.model ? ctx.modelRegistry.isUsingOAuth(ctx.model) : false;
					if (cost || usingSub) parts.push(`$${cost.toFixed(3)}${usingSub ? " (sub)" : ""}`);
					const statsStr = parts.length ? fg("footerStats", "dim", parts.join(" ")) : "";
					const left = statsStr ? `${glyph}  ${statsStr} ${ctxStr}` : `${glyph}  ${ctxStr}`;

					// ---- right side: model NAME + thinking ----------------------
					const modelName = ctx.model?.name || ctx.model?.id || "no-model";
					let rightPlain = modelName;
					let rightColor: ThemeColor = "footerModel" as ThemeColor;
					if (state.fallbackTo) {
						const fb = state.fallbackTo;
						const slashIdx = fb.lastIndexOf("/");
						const fbProvider = slashIdx > 0 ? fb.slice(0, slashIdx) : "";
						const fbId = slashIdx > 0 ? fb.slice(slashIdx + 1) : fb;
						const orig = state.originalModel || modelName;
						// Show original (pre-fallback) model + fallback target, compact.
						rightPlain = fbProvider ? `${orig} ⤵ ${fbProvider}/${fbId}` : `${orig} ⤵ ${fbId}`;
						rightColor = "warning";
						// Truncate from middle if fallback spec is too long
						const maxRw = Math.floor(width * 0.5);
						const ellipsisW = visibleWidth(ELLIPSIS);
						if (visibleWidth(rightPlain) > maxRw) {
							const sideW = Math.max(1, Math.floor((maxRw - ellipsisW) / 2));
							const start = truncateToWidth(rightPlain, sideW, "");
							let endChars = "";
							let ew = 0;
							for (let i = rightPlain.length - 1; i >= 0; i--) {
								const cw = visibleWidth(rightPlain[i]);
								if (ew + cw > sideW) break;
								endChars = rightPlain[i] + endChars;
								ew += cw;
							}
							rightPlain = start + ELLIPSIS + endChars;
						}
					}
					if (!state.fallbackTo && ctx.model?.reasoning) {
						const level = pi.getThinkingLevel() || "off";
						rightPlain = level === "off" ? `${modelName} • thinking off` : `${modelName} • ${level}`;
					}
					if (footerData.getAvailableProviderCount() > 1 && ctx.model) {
						const withProvider = `(${ctx.model.provider}) ${rightPlain}`;
						rightPlain = withProvider;
					}
					const right = rightColor === "footerModel"
						? fg("footerModel", "dim", rightPlain)
						: theme.fg(rightColor, rightPlain);

					// ---- compose stats line -------------------------------------
					const statsLine = fitColumns(left, right, width);

					const lines = [pwdLine, statsLine];

					// ---- optional warning/note line -----------------------------
					if (state.note) {
						const tone = state.tone ?? "warning";
						const prefix = state.tone === "error" ? "✗" : "⚠";
						lines.push(truncateToWidth(theme.fg(tone, `${prefix} ${state.note}`), width, theme.fg(tone, "...")));
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
