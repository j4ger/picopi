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
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { loadConfig, resolveChain, hopCap, type PicopiConfig } from "./config.ts";
import { setPicopiFooter, clearPicopiFooterNote } from "./footer.ts";

let currentModelSpec: string = "";
let currentAlias: string = "";
let enabled = true;
let errorsForModel = 0;
// Per-model error budget before falling back, cached from pi's retry.maxRetries
// at session_start (0 = fall back immediately, i.e. retry disabled).
let retryThreshold = 0;

// Task 1: self-driven full-chain fallback state
let lastUserPrompt = "";   // captured in before_agent_start for diagnostics
let hopCount = 0;           // chain hops taken for the current unresolved failure
let reentryGuard = false;   // true between scheduling a self-nudge and observing its turn's outcome
let nonRetryableStop = false; // set when the last error looked non-retryable (auth/policy/not-found)

/** Task 8: Synthetic nudge sent to continue the task on the new model. */
const CONTINUATION_PROMPT =
	"The previous attempt failed due to an upstream provider error and has been "
	+ "retried on a different model. Continue the task from where it left off."

/** Accessors for the fallback chain position (used by /fallback command). */
export function getCurrentAlias(): string { return currentAlias; }
export function getCurrentModelSpec(): string { return currentModelSpec; }

/**
 * Manually set the current model in the fallback chain (used by /fallback
 * picker / reset). Resets the error counter so a deliberate switch doesn't
 * immediately trigger a fallback on the first error.
 */
export function setCurrentModel(spec: string): void {
	currentModelSpec = spec;
	errorsForModel = 0;
}

/**
 * Task 6 (sub-task): tryFallback now returns boolean — true when pi.setModel
 * succeeded and the chain advanced, false otherwise.
 */
async function tryFallback(pi: ExtensionAPI, ctx: ExtensionContext, cfg: PicopiConfig, reason: string): Promise<boolean> {
	// Task 4 (W2): local helper so json/print mode never calls UI-only APIs.
	const notify = (msg: string, lvl: "info" | "warning" | "error") => {
		if (ctx.hasUI) ctx.ui.notify(msg, lvl);
	};

	if (!currentAlias) return false;

	const chain = resolveChain(cfg, currentAlias);
	if (chain.length <= 1) return false;

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
		notify(`No more fallback models for "${currentAlias}" — request may fail`, "warning");
		return false;
	}

	// Resolve and switch to the fallback model.
	const slash = nextSpec.indexOf("/");
	if (slash <= 0) {
		notify(`Fallback: model spec "${nextSpec}" is malformed (expected provider/model) — skipping`, "warning");
		return false;
	}
	const provider = nextSpec.slice(0, slash);
	const modelId = nextSpec.slice(slash + 1);

	const model = ctx.modelRegistry.find(provider, modelId);
	if (!model) {
		notify(`Fallback model ${nextSpec} not found in registry`, "error");
		return false;
	}

	// Save the original model BEFORE setModel — pi.setModel triggers
	// model_select which overwrites currentModelSpec with the new model.
	const originalSpec = currentModelSpec;

	const success = await pi.setModel(model as unknown as import("@earendil-works/pi-ai").Model<any>);
	if (!success) {
		notify(`Failed to switch to ${nextSpec} (no API key?)`, "error");
		return false;
	}

	// Keep the original retry threshold so the fallback model gets the same
	// number of attempts before the chain walks. pi's internal retry counter
	// is not reset by setModel, so the current turn ends after the switch;
	// the next user message or steer gets a full retry budget on the new model.

	notify(`Falling back to ${nextSpec} after model error`, "warning");

	// Task 4 (W2): guard footer (UI-only) from json/print mode.
	if (ctx.hasUI) setPicopiFooter({ fallbackTo: nextSpec, originalModel: originalSpec });

	// pi.setModel() causes pi to retry the pending request with the new model.
	return true;
}

/**
 * Task 4: Classify errors that are unlikely to succeed on a retry/different model
 * call. This is BEST-EFFORT — error text is provider-dependent and not reliably
 * structured. The hop cap (hopCap) bounds runaway retries even when this misses;
 * an unclassified auth failure walks at most the chain length and stops.
 */
function classifyNonRetryable(m: AssistantMessage): boolean {
	const haystack = [
		m.errorMessage ?? "",
		...(m.diagnostics?.map((d: any) => String(d.error ?? "")) ?? []),
	].join(" ").toLowerCase();
	const patterns = [
		"auth", "unauthorized", "401", "403", "api key",
		"content policy", "content_policy", "safety",
		"model_not_found", "model not found", "404", "not found", "invalid model",
	];
	return patterns.some((p) => haystack.includes(p));
}

/**
 * Task 5: Shrink an errored assistant message for context efficiency.
 * Keeps role, stopReason ("error" — preserves pi's retry accounting), api,
 * provider, model, usage, timestamp. Strips content → single short TextContent,
 * drops errorMessage and diagnostics.
 */
function shrinkErroredMessage(m: AssistantMessage, note: string): AssistantMessage {
	return {
		...m,
		content: [{ type: "text", text: note }],
		errorMessage: undefined,
		diagnostics: undefined,
	};
}

/**
 * Find the index of `target` in the chain, trying various matching strategies
 * (exact match, model-id-only match, suffix match).
 */
export function findInChain(chain: string[], target: string): number {
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
		clearPicopiFooterNote();
	});

	// ── Load config, track alias, announce the chain ──────────────────────
	// Task 3 (W2): removed leading `if (!ctx.hasUI) return;` — state resets,
	// currentAlias, PI_FALLBACK_DISABLE check, and retryThreshold must all run
	// unconditionally so json/print subagents get a working fallback state.
	// Only the chain-announce notify is gated on hasUI.
	pi.on("session_start", async (_event, ctx) => {
		// Reset all module-level state to avoid leaking across sessions.
		currentModelSpec = "";
		currentAlias = "";
		enabled = true;
		errorsForModel = 0;
		retryThreshold = 0;
		lastUserPrompt = "";
		hopCount = 0;
		reentryGuard = false;
		nonRetryableStop = false;

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
		// Gate UI announce on hasUI only — state setup above is unconditional.
		if (ctx.hasUI && chain.length > 1) {
			ctx.ui.notify(`Fallback chain: ${chain.length} models`, "info");
		}
	});

	// ── Task 3: Capture prompt + reset hop budget for user-initiated turns ─
	//    before_agent_start fires for BOTH user turns and our injected nudge
	//    turns. When reentryGuard is true, this is our injected continuation
	//    turn — do NOT reset hopCount/lastUserPrompt (that erases the failure
	//    budget). Only reset on genuine user-initiated turns.
	pi.on("before_agent_start", (event, _ctx) => {
		if (!reentryGuard) {
			lastUserPrompt = event.prompt ?? "";
			hopCount = 0;
			nonRetryableStop = false;
			// Clear any stale per-model error count carried over from a prior
			// failure whose hop didn't switch (e.g. no next model / no auth), so
			// this fresh turn lets pi exhaust its own retries before we hop.
			errorsForModel = 0;
		}
	});

	// ── Capture model spec on first request if model_select hasn't fired ──
	pi.on("before_provider_request", (event, ctx) => {
		if (!currentModelSpec && ctx.model) {
			currentModelSpec = `${ctx.model.provider}/${ctx.model.id}`;
		}
	});

	// ── Task 6: Upstream error decision logic ─────────────────────────────
	//    Any errored assistant response is an explicit upstream failure another
	//    provider might handle. Skip context overflow — pi handles that via
	//    compaction. (stopReason "error" already excludes user aborts.)
	pi.on("message_end", async (event, ctx) => {
		// Step 1: Guards
		if (!enabled || !currentAlias) return;

		const m = event.message as unknown as AssistantMessage;
		if (m.role !== "assistant") return;

		// Step 2: Success path — reset all counters and guards.
		if (m.stopReason !== "error") {
			errorsForModel = 0;
			hopCount = 0;
			reentryGuard = false;
			nonRetryableStop = false;
			return;
		}

		// Step 3 (W1): Clear reentryGuard at the TOP of the error path, before any
		// early-return. This ensures an injected turn that ends in context-overflow
		// cannot leak the guard into the next genuine user turn's before_agent_start
		// (which would incorrectly skip resetting hopCount/lastUserPrompt). (W1 fix)
		reentryGuard = false;

		// Step 4: Context overflow — leave to pi compaction.
		if (isContextOverflow(m, ctx.model?.contextWindow)) return;

		// Step 5: Let pi exhaust its own retries on this model first.
		// We hop only once pi has FULLY exhausted its own retries (the
		// maxRetries+1-th error), so pi does NOT continue and our injected followUp
		// is the sole post-hop driver — prevents double execution on the new model.
		// `<=` ties to pi's retry invariant: _prepareRetry caps at maxRetries+1
		// errors then returns false (stops pi's continuation); our hop fires exactly
		// at that terminal error.
		if (++errorsForModel <= retryThreshold) return;

		// Step 6: Classify the error.
		nonRetryableStop = classifyNonRetryable(m);

		const cfg = loadConfig();
		const chain = resolveChain(cfg, currentAlias);

		// Step 7: Build the shrink note BEFORE calling tryFallback (which
		// mutates currentModelSpec via model_select).
		const note = `[picopi] Upstream error on ${m.provider}/${m.model}; retried on a different model.`;

		// Step 8: Compute re-trigger eligibility BEFORE the switch.
		const canRetrigger = (ctx.mode === "tui" || ctx.mode === "rpc")
			&& !nonRetryableStop
			&& hopCount < hopCap(chain.length, cfg)
			&& (cfg.fallback?.retrigger !== false);

		// Step 9: Perform the model switch.
		const switched = await tryFallback(pi, ctx, cfg, "Upstream error");

		// Step 10: Schedule self-driven re-trigger if eligible and switch happened.
		if (canRetrigger && switched) {
			reentryGuard = true;
			hopCount++;
			pi.sendUserMessage(CONTINUATION_PROMPT, { deliverAs: "followUp" });
		}

		// Step 11: Always return shrunk message once we've decided to hop.
		return { message: shrinkErroredMessage(m, note) };
	});
}