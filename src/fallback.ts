/**
 * picopi runtime model fallback — orchestrator.
 *
 * Switches to the next model in the fallback chain when the upstream API
 * reports a non-retryable error or when pi's retry mechanism exhausts
 * retries without success.
 *
 * No timeout-based fallback — pi's own retry mechanism handles transient
 * errors and slow responses. We only act on explicit failure signals.
 *
 * Inspired by pi-retry-fallback-model (99degree / GitHub issue #4328).
 *
 * Disable with: PI_FALLBACK_DISABLE=true
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadConfig, resolveChain, type PicopiConfig } from "./config.ts";
import { setPicopiFooter } from "./footer.ts";

let currentModelSpec: string = "";
let currentAlias: string = "";
let enabled = true;

async function tryFallback(pi: ExtensionAPI, ctx: ExtensionContext, cfg: PicopiConfig, reason: string) {
	if (!currentAlias) return;

	const chain = resolveChain(cfg, currentAlias);
	if (chain.length <= 1) return;

	const idx = findInChain(chain, currentModelSpec);

	let nextSpec: string | null = null;
	if (idx === -1) {
		// Current model not in chain — skip it and pick the first entry
		// that isn't the current model.
		for (const spec of chain) {
			if (spec !== currentModelSpec) {
				nextSpec = spec;
				break;
			}
		}
		if (!nextSpec) nextSpec = chain[0];
	} else if (idx < chain.length - 1) {
		nextSpec = chain[idx + 1];
	}

	if (!nextSpec) {
		ctx.ui.notify(`⏱ No more fallback models for "${currentAlias}" — request may fail`, "warning");
		return;
	}

	// Resolve and switch to the fallback model.
	const slash = nextSpec.indexOf("/");
	if (slash <= 0) return;
	const provider = nextSpec.slice(0, slash);
	const modelId = nextSpec.slice(slash + 1);

	const model = ctx.modelRegistry.find(provider, modelId);
	if (!model) {
		ctx.ui.notify(`⏱ Fallback model ${nextSpec} not found in registry`, "error");
		return;
	}

	const success = await pi.setModel(model as any);
	if (!success) {
		ctx.ui.notify(`⏱ Failed to switch to ${nextSpec} (no API key?)`, "error");
		return;
	}

	currentModelSpec = nextSpec;

	ctx.ui.notify(`⬇ ${reason}: ${nextSpec}`, "info");

	setPicopiFooter({ note: `fallback → ${nextSpec}`, tone: "warning" });

	// pi.setModel() causes pi to retry the pending request with the new model.
}

/**
 * Find the index of `target` in the chain, trying various matching strategies
 * (exact match, model-id-only match, suffix match).
 */
function findInChain(chain: string[], target: string): number {
	// 1. Exact match
	const exact = chain.indexOf(target);
	if (exact !== -1) return exact;

	// 2. Match by model id only (ignore provider prefix differences,
	//    e.g. "insta-ds/claude-opus-4-7" vs "insta-anthropic/claude-opus-4-7")
	const slashIdx = target.indexOf("/");
	if (slashIdx > 0) {
		const modelId = target.slice(slashIdx + 1);
		const byModel = chain.findIndex((entry) => entry.endsWith(`/${modelId}`));
		if (byModel !== -1) return byModel;
	}

	// 3. Suffix / substring match
	for (let i = 0; i < chain.length; i++) {
		const entry = chain[i];
		if (target.endsWith(entry) || entry.endsWith(target)) return i;
	}

	return -1;
}



export function setupFallback(pi: ExtensionAPI) {
	// ── Track current model ───────────────────────────────────────────────
	pi.on("model_select", async (event) => {
		currentModelSpec = `${event.model.provider}/${event.model.id}`;
	});

	// ── Load config, track alias, announce the chain ──────────────────────
	pi.on("session_start", async (_event, ctx) => {
		if (!ctx.hasUI) return;

		const cfg = loadConfig();
		currentAlias = cfg.orchestrator?.model ?? "";

		if (process.env.PI_FALLBACK_DISABLE === "true") {
			enabled = false;
			return;
		}

		const chain = resolveChain(cfg, currentAlias);
		if (chain.length > 1) {
			ctx.ui.notify(`picopi fallback: ${chain.length} models → ${chain.join(" → ")}`, "info");
		}
	});

	// ── Capture model spec on first request if model_select hasn't fired ──
	pi.on("before_provider_request", (event, ctx) => {
		if (!currentModelSpec && ctx.model) {
			currentModelSpec = `${ctx.model.provider}/${ctx.model.id}`;
		}
	});

	// ── Hard errors: upstream won't recover from these ────────────────────
	pi.on("after_provider_response", (event, ctx) => {
		if (!enabled) return;
		if (!currentAlias) return;

		// Non-retryable HTTP errors: auth failures, model not found, quota exhausted
		if ([401, 403, 404, 402].includes(event.status)) {
			const cfg = loadConfig();
			tryFallback(pi, ctx, cfg, `Error ${event.status}`);
		}
	});

	// ── Retry exhaustion: pi's retry loop gave up ─────────────────────────
	pi.on("auto_retry_end", (event, ctx) => {
		if (!enabled) return;
		if (!currentAlias) return;

		// Only act if retries were exhausted without success
		if (!event.success) {
			const cfg = loadConfig();
			tryFallback(pi, ctx, cfg, "Retries exhausted");
		}
	});
}