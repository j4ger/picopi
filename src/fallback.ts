/**
 * picopi runtime model fallback — orchestrator.
 *
 * Switches to the next model in the fallback chain when an upstream API error
 * is reported. Any errored assistant response is treated as an explicit
 * upstream failure another provider might handle — except context overflow,
 * which is left to pi's compaction.
 *
 * Failed attempts surface as an errored assistant `message_end` — the same
 * signal pi's own retry loop keys off. We count consecutive errors per model
 * and only switch once pi has used up its retry budget on the current model
 * (threshold = pi's own `retry.maxRetries`, read from its settings). We switch
 * on the *last* retry-eligible error so pi's final retry continuation picks up
 * the fallback model within the same turn, walking the chain on each exhaustion.
 *
 * No timeout-based fallback — pi's own retry mechanism handles transient
 * errors and slow responses. We only act after it gives up.
 * (auto_retry_* are NOT forwarded to extensions, so we count message_end instead.)
 *
 * Inspired by pi-retry-fallback-model (99degree / GitHub issue #4328).
 *
 * Disable with: PI_FALLBACK_DISABLE=true
 */

import { SettingsManager, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isContextOverflow } from "@earendil-works/pi-ai";
import { loadConfig, resolveChain, type PicopiConfig } from "./config.ts";
import { setPicopiFooter } from "./footer.ts";

let currentModelSpec: string = "";
let currentAlias: string = "";
let enabled = true;
let errorsForModel = 0;
// Per-model error budget before falling back, cached from pi's retry.maxRetries
// at session_start (0 = fall back immediately, i.e. retry disabled).
let retryThreshold = 0;

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

	const shortName = nextSpec.includes("/") ? nextSpec.split("/").pop()! : nextSpec;
	ctx.ui.notify(`falling back to ${shortName}`, "warning");

	setPicopiFooter({ fallbackTo: nextSpec });

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
		errorsForModel = 0; // fresh retry budget for the new model
	});

	// ── Load config, track alias, announce the chain ──────────────────────
	pi.on("session_start", async (_event, ctx) => {
		if (!ctx.hasUI) return;

		// Reset all module-level state to avoid leaking across sessions.
		currentModelSpec = "";
		currentAlias = "";
		enabled = true;
		errorsForModel = 0;
		retryThreshold = 0;

		const cfg = loadConfig();
		currentAlias = cfg.orchestrator?.model ?? "";

		if (process.env.PI_FALLBACK_DISABLE === "true") {
			enabled = false;
			return;
		}

		// Cache pi's own retry budget so we don't re-read settings on every error.
		const retry = SettingsManager.create(ctx.cwd).getRetrySettings();
		retryThreshold = retry.enabled ? retry.maxRetries : 0;

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

	// ── Upstream error: switch model so pi's retry uses the fallback ──────
	//    Any errored assistant response is an explicit upstream failure another
	//    provider might handle. Skip context overflow — pi handles that via
	//    compaction. (stopReason "error" already excludes user aborts.)
	pi.on("message_end", async (event, ctx) => {
		if (!enabled || !currentAlias) return;

		const m = event.message as any;
		if (m.role !== "assistant") return;
		if (m.stopReason !== "error") {
			errorsForModel = 0;
			return;
		}
		if (isContextOverflow(m, ctx.model?.contextWindow)) return;

		// Let pi exhaust its own retries on this model first. Switch only on the
		// last retry-eligible error (>= maxRetries) so pi's final retry continuation
		// still uses the fallback model this turn. (retry disabled => threshold 0.)
		if (++errorsForModel < retryThreshold) return;

		await tryFallback(pi, ctx, loadConfig(), "Upstream error");
	});
}