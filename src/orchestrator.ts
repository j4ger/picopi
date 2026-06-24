/**
 * Orchestrator role resolution, picopi footer state, and cheap-model
 * compaction.
 *
 * On startup picopi resolves the `orchestrator` role from the central config
 * into a concrete model (walking the alias -> fallback chain) and applies the
 * model + thinking level to the main session. It then feeds the resolved role
 * into the consolidated footer (see footer.ts), which shows the model by name —
 * so the behaviour is never a mystery and the model is only displayed once.
 */

import { completeSimple } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { VERSION as PI_VERSION, convertToLlm, serializeConversation } from "@earendil-works/pi-coding-agent";
import { type ModelRegistryLike, type PicopiConfig, loadConfig, resolveRoleModel, validateAllResolutions } from "./config.ts";
import { clearPicopiFooterNote, setPicopiFooter } from "./footer.ts";

const COMPACT_TIMEOUT_MS = 120_000;

/** Minimum pi version picopi is built against (see package.json peerDependencies). */
const MIN_PI_VERSION = "0.78.0";

/** True if semver `a` < `b` (numeric major.minor.patch; ignores pre-release tags). */
function isOlder(a: string, b: string): boolean {
	const pa = a.split(".").map((n) => parseInt(n, 10) || 0);
	const pb = b.split(".").map((n) => parseInt(n, 10) || 0);
	for (let i = 0; i < 3; i++) {
		if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) < (pb[i] ?? 0);
	}
	return false;
}

function registry(ctx: ExtensionContext): ModelRegistryLike {
	return ctx.modelRegistry as unknown as ModelRegistryLike;
}

export interface ApplyOrchestratorResult {
	ok: boolean;
	/** Resolved provider/id spec when ok, else a short failure reason. */
	detail?: string;
}

export async function applyOrchestrator(pi: ExtensionAPI, ctx: ExtensionContext, cfg: PicopiConfig): Promise<ApplyOrchestratorResult> {
	const role = cfg.orchestrator;
	if (!role) {
		setReadyStatus();
		return { ok: true };
	}

	const resolved = await resolveRoleModel(registry(ctx), cfg, role.model);

	if (!resolved) {
		setPicopiFooter({ role: role.model, note: `no authenticated model for "${role.model}" — run /login, then /picopi`, tone: "warning" });
		return { ok: false, detail: `no working model for "${role.model}"` };
	}

	const ok = await pi.setModel(resolved.model as object);
	if (!ok) {
		setPicopiFooter({ role: role.model, note: `auth failed for ${resolved.spec} — run /login`, tone: "warning" });
		return { ok: false, detail: `auth failed for ${resolved.spec}` };
	}
	if (role.thinking) pi.setThinkingLevel(role.thinking);

	// Footer now owns the model display (by name); we only contribute the role.
	setPicopiFooter({ role: role.model });
	clearPicopiFooterNote();
	return { ok: true, detail: resolved.spec };
}

function setReadyStatus() {
	setPicopiFooter({ role: undefined });
	clearPicopiFooterNote();
}

export function setupOrchestrator(pi: ExtensionAPI) {
	pi.on("session_start", async (event, ctx) => {
		// In print/JSON mode (e.g. spawned subagents) the model is set via --model;
		// don't override it. Only manage the model for interactive sessions.
		if (!ctx.hasUI) return;
		// Warn once if the running pi is older than what picopi is built against.
		if ((event.reason === "startup" || event.reason === "new") && isOlder(PI_VERSION, MIN_PI_VERSION)) {
			ctx.ui.notify(`picopi needs pi ≥ ${MIN_PI_VERSION} (running ${PI_VERSION}) — run 'picopi --update'`, "warning");
		}
		const cfg = loadConfig();
		// Only auto-apply on fresh starts; honour the model restored on resume/fork.
		if (event.reason === "startup" || event.reason === "new") {
			// Best-effort validation of all configured model resolutions
			try {
				const report = await validateAllResolutions(registry(ctx), cfg);
				if (!report.ok) {
					const failures = report.results.filter((r) => !r.ok);
					const lines = failures.map((f) => {
						const details = f.issues.map((i) => `${i.spec || f.alias} → ${i.reason}`).join(", ");
						return `  - ${f.role}: ${details}`;
					});
					console.warn(`picopi: ${failures.length} configured model resolution(s) failed:\n${lines.join("\n")}`);
					if (failures.some((f) => f.role === "orchestrator")) {
						setPicopiFooter({ role: cfg.orchestrator?.model, note: `${failures.length} role(s) unresolved — run /picopi`, tone: "warning" });
					} else {
						ctx.ui.notify(`${failures.length} role model(s) unresolved — run /picopi for details`, "warning");
					}
				}
			} catch {
				/* validation is best-effort */
			}
			await applyOrchestrator(pi, ctx, cfg);
		} else {
			setReadyStatus();
		}
	});

	// Cheap-model compaction (feature #5: compaction.model).
	pi.on("session_before_compact", async (event, ctx) => {
		const cfg = loadConfig();
		const alias = cfg.compaction?.model;
		if (!alias) return; // fall back to default compaction

		const resolved = await resolveRoleModel(registry(ctx), cfg, alias);
		if (!resolved) return;

		const auth = await registry(ctx).getApiKeyAndHeaders(resolved.model);
		if (!auth.ok) return;

		const { preparation, signal } = event;
		const { messagesToSummarize, turnPrefixMessages, tokensBefore, firstKeptEntryId, previousSummary } = preparation;
		const toSummarize = [...turnPrefixMessages, ...messagesToSummarize];
		if (toSummarize.length === 0) return;

		const conversationText = serializeConversation(convertToLlm(toSummarize));
		const prev = previousSummary ? `\n\nPrevious summary:\n${previousSummary}` : "";

		// Bound compaction wall-clock (a hung cheap model shouldn't stall the
		// session); chain the agent's abort signal with a timeout. Set up only once
		// we're committed to the model call, and always torn down in `finally`.
		const compactionTimeoutMs = cfg.compaction?.timeout ? cfg.compaction.timeout * 1000 : COMPACT_TIMEOUT_MS;
		const ctrl = new AbortController();
		const onAbort = () => ctrl.abort();
		signal.addEventListener("abort", onAbort, { once: true });
		const timer = setTimeout(() => ctrl.abort(), compactionTimeoutMs);

		try {
			const response = await completeSimple(
				resolved.model as object,
				{
					messages: [
						{
							role: "user" as const,
							content: [
								{
									type: "text" as const,
									text: `Summarize this engineering conversation for continuation.${prev}

Include: goals; decisions/rationale; code/file changes; current state; blockers; next steps. Structured Markdown; compact but complete.

<conversation>
${conversationText}
</conversation>`,
								},
							],
							timestamp: Date.now(),
						},
					],
				},
				{ apiKey: auth.apiKey, headers: auth.headers, maxTokens: 8192, signal: ctrl.signal, reasoning: cfg.compaction?.thinking },
			);

			const summary = response.content
				.filter((c): c is { type: "text"; text: string } => c.type === "text")
				.map((c) => c.text)
				.join("\n");

			if (!summary.trim()) return;
			return { compaction: { summary, firstKeptEntryId, tokensBefore } };
		} catch (e) {
			console.warn(`picopi: custom compaction failed, using default (${e instanceof Error ? e.message : e})`);
			return; // default compaction
		} finally {
			clearTimeout(timer);
			signal.removeEventListener("abort", onAbort);
		}
	});
}
