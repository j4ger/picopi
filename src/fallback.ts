/**
 * picopi runtime model fallback — orchestrator.
 *
 * Hooks into before_provider_request to set per-request timeouts. When a
 * request times out (model hung / slow), walks the fallback chain from
 * config.json aliases, calls pi.setModel() with the next model, and pi
 * automatically retries the pending request with the new model.
 *
 * The chain continues walking until success or exhaustion. When all fallbacks
 * are exhausted, the last request completes or fails naturally.
 *
 * Inspired by pi-retry-fallback-model (99degree / GitHub issue #4328).
 *
 * Disable with: PI_FALLBACK_DISABLE=true
 * Override timeout with: PI_FALLBACK_TIMEOUT_MS=<ms>
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadConfig, resolveChain, type PicopiConfig } from "./config.ts";
import { setPicopiFooter } from "./footer.ts";

// Default per-request timeout (ms).
const DEFAULT_TIMEOUT_MS = 60_000;

let abortController: AbortController | null = null;
let timeoutId: ReturnType<typeof setTimeout> | null = null;
let currentModelSpec: string = "";
let currentAlias: string = "";
let enabled = true;

function cleanup() {
	if (timeoutId) {
		clearTimeout(timeoutId);
		timeoutId = null;
	}
	if (abortController) {
		abortController.abort();
		abortController = null;
	}
}

function getTimeoutMs(): number {
	const env = process.env.PI_FALLBACK_TIMEOUT_MS;
	if (env) {
		const ms = parseInt(env, 10);
		if (!isNaN(ms) && ms > 0) return ms;
	}
	return DEFAULT_TIMEOUT_MS;
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

async function tryFallback(pi: ExtensionAPI, ctx: ExtensionContext, cfg: PicopiConfig) {
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
		if (abortController) {
			abortController.abort();
			abortController = null;
		}
		return;
	}

	// Abort the current stuck request so the provider layer stops waiting.
	if (abortController) {
		abortController.abort();
		abortController = null;
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

	pi.sendMessage({
		customType: "picopi-fallback",
		content: `⏱ Model request timed out after ${getTimeoutMs() / 1000}s.\nSwitched to fallback: **${nextSpec}**\nAuto-retrying...`,
		display: true,
	});
	ctx.ui.notify(`⬇ Fallback: ${nextSpec}`, "info");

	setPicopiFooter({ note: `fallback → ${nextSpec}`, tone: "warning" });

	// Set up a fresh timeout for the retry.  The follow-up retry may bypass
	// before_provider_request (agent internal retry path), so we ensure a
	// timeout is always in place so the chain continues walking.
	cleanup();
	abortController = new AbortController();
	const timeoutMs = getTimeoutMs();
	timeoutId = setTimeout(() => tryFallback(pi, ctx, cfg), timeoutMs);

	// pi.setModel() above already causes pi to retry the pending request
	// with the new model automatically — no need for an explicit retry.
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

	// ── Intercept provider requests — set up per-request timeout ──────────
	pi.on("before_provider_request", (event, ctx) => {
		if (!enabled) return;
		if (!currentAlias) return;

		// Capture model spec from context on the very first request (before
		// model_select fires).
		if (!currentModelSpec && ctx.model) {
			currentModelSpec = `${ctx.model.provider}/${ctx.model.id}`;
		}

		const cfg = loadConfig();
		const chain = resolveChain(cfg, currentAlias);
		if (chain.length <= 1) return; // single-model chain → nothing to fallback to

		// Clean up any existing timeout (e.g. from a previous retry that
		// DID re-enter before_provider_request).
		cleanup();

		const timeoutMs = getTimeoutMs();
		abortController = new AbortController();
		timeoutId = setTimeout(() => tryFallback(pi, ctx, cfg), timeoutMs);

		// Best-effort: also hint the HTTP layer about the timeout.
		const payload = event.payload as any;
		if (payload && typeof payload === "object") {
			if (payload.options && typeof payload.options === "object") {
				payload.options.timeout = timeoutMs;
			} else if (payload.timeout === undefined) {
				payload.timeout = timeoutMs;
			}
		}

		return payload;
	});

	// ── Clean up on turn/agent boundaries ─────────────────────────────────
	pi.on("agent_end", () => {
		cleanup();
	});

	pi.on("session_shutdown", () => {
		cleanup();
	});
}