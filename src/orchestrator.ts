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

import { complete } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { convertToLlm, serializeConversation } from "@earendil-works/pi-coding-agent";
import { type ModelRegistryLike, type PicopiConfig, loadConfig, resolveRoleModel } from "./config.ts";
import { clearPicopiFooterNote, setPicopiFooter } from "./footer.ts";

const COMPACT_TIMEOUT_MS = 120_000;

function registry(ctx: ExtensionContext): ModelRegistryLike {
	return ctx.modelRegistry as unknown as ModelRegistryLike;
}

async function applyOrchestrator(pi: ExtensionAPI, ctx: ExtensionContext, cfg: PicopiConfig) {
	const role = cfg.orchestrator;
	if (!role) {
		setReadyStatus(ctx);
		return;
	}

	const resolved = await resolveRoleModel(registry(ctx), cfg, role.model);

	if (!resolved) {
		setPicopiFooter({ role: role.model, note: `no model for "${role.model}" — using session default`, tone: "warning" });
		return;
	}

	const ok = await pi.setModel(resolved.model as any);
	if (!ok) {
		setPicopiFooter({ role: role.model, note: `auth failed for ${resolved.spec}`, tone: "warning" });
		return;
	}
	if (role.thinking) pi.setThinkingLevel(role.thinking);

	// Footer now owns the model display (by name); we only contribute the role.
	setPicopiFooter({ role: role.model });
	clearPicopiFooterNote();
}

function setReadyStatus(_ctx: ExtensionContext) {
	setPicopiFooter({ role: undefined });
	clearPicopiFooterNote();
}

export function setupOrchestrator(pi: ExtensionAPI) {
	pi.on("session_start", async (event, ctx) => {
		// In print/JSON mode (e.g. spawned subagents) the model is set via --model;
		// don't override it. Only manage the model for interactive sessions.
		if (!ctx.hasUI) return;
		const cfg = loadConfig();
		// Only auto-apply on fresh starts; honour the model restored on resume/fork.
		if (event.reason === "startup" || event.reason === "new") {
			await applyOrchestrator(pi, ctx, cfg);
		} else {
			setReadyStatus(ctx);
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
		const prev = previousSummary ? `\n\nPrevious summary for context:\n${previousSummary}` : "";

		// Bound compaction wall-clock (a hung cheap model shouldn't stall the
		// session); chain the agent's abort signal with a timeout. Set up only once
		// we're committed to the model call, and always torn down in `finally`.
		const ctrl = new AbortController();
		const onAbort = () => ctrl.abort();
		signal.addEventListener("abort", onAbort, { once: true });
		const timer = setTimeout(() => ctrl.abort(), COMPACT_TIMEOUT_MS);

		try {
			const response = await complete(
				resolved.model as any,
				{
					messages: [
						{
							role: "user" as const,
							content: [
								{
									type: "text" as const,
									text: `Summarize this engineering conversation so work can continue without the raw history.${prev}

Capture: goals, key decisions + rationale, code/file changes, current state, blockers, and planned next steps. Be thorough but compact. Output structured markdown.

<conversation>
${conversationText}
</conversation>`,
								},
							],
							timestamp: Date.now(),
						},
					],
				},
				{ apiKey: auth.apiKey, headers: auth.headers, maxTokens: 8192, signal: ctrl.signal },
			);

			const summary = response.content
				.filter((c): c is { type: "text"; text: string } => c.type === "text")
				.map((c) => c.text)
				.join("\n");

			if (!summary.trim()) return;
			return { compaction: { summary, firstKeptEntryId, tokensBefore } };
		} catch {
			return; // default compaction
		} finally {
			clearTimeout(timer);
			signal.removeEventListener("abort", onAbort);
		}
	});
}
