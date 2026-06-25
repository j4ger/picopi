/**
 * picopi /bench — benchmark all configured models with a unified prompt.
 *
 * Measures TTFT (time-to-first-token), tokens/sec, and alive/dead/timeout
 * status for every model in every alias chain.  Runs in parallel up to the
 * configured concurrency limit.  Renders a live widget (retained after completion)
 * and a summary notification.
 */

import { spawn } from "node:child_process";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { getActivePreset, loadConfig, resolveChain } from "./config.ts";
import { sanitizeEnv, piInvocation } from "./subagent.ts";

// ── constants ─────────────────────────────────────────────────────────────────

const DEFAULT_PROMPT = "In one sentence, what is the capital of France?";
const DEFAULT_TIMEOUT = 30; // seconds
const DEFAULT_CONCURRENCY = 3;

const BENCH_WIDGET_ID = "picopi-bench";
let activeBench: AbortController | null = null;

// ── types ─────────────────────────────────────────────────────────────────────

type BenchStatus = "pending" | "running" | "alive" | "dead" | "timeout";

// One measured run of one model.
interface BenchSample {
	status: "alive" | "dead" | "timeout";
	ttftMs?: number;
	tokensPerSec?: number;
	outputTokens?: number;
	genMs?: number;
	error?: string;
}

// Aggregated result for a model across N rounds.
interface BenchResult {
	model: string;          // provider/id
	status: BenchStatus;    // overall, see aggregation rule
	roundsPlanned: number;
	aliveCount: number;     // rounds with status "alive"
	samples: BenchSample[];
	// Aggregates over ALIVE rounds only:
	ttftMs?: number;        // mean
	tokensPerSec?: number;  // mean
	error?: string;         // representative error when overall status is dead/timeout
}

// ── helpers ───────────────────────────────────────────────────────────────────

const fmt = (ms: number) => ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;

const tokPerSec = (tokens?: number, genMs?: number) =>
	tokens != null && genMs != null && genMs > 0 ? Math.round((tokens / genMs) * 1000) : undefined;

function mean(nums: number[]): number | undefined {
	if (!nums.length) return undefined;
	return Math.round(nums.reduce((a, b) => a + b, 0) / nums.length);
}

const STATUS_GLYPH: Record<BenchStatus, string> = {
	pending: "…",
	running: "◌",
	alive:   "✓",
	dead:    "✗",
	timeout: "⚠",
};

const STATUS_COLOR: Record<BenchStatus, string> = {
	pending: "dim",
	running: "accent",
	alive:   "success",
	dead:    "error",
	timeout: "warning",
};

function safeFg(theme: any, color: string, text: string): string {
	try { return theme.fg(color, text); } catch { return text; }
}

/**
 * Collect every unique provider/model leaf across all alias chains, including
 * preset-scoped aliases (e.g. `alias@preset`).
 */
function collectAllModels(
	cfg: ReturnType<typeof loadConfig>,
	registry?: ExtensionCommandContext["modelRegistry"],
): { spec: string }[] {
	const specs = new Set<string>();
	const addSpec = (spec: string) => {
		if (spec.includes("/")) specs.add(spec);
	};
	// Walk every alias entry (base + preset-scoped)
	for (const chain of Object.values(cfg.aliases ?? {})) {
		for (const spec of chain) addSpec(spec);
	}
	// Role references (literal provider/model or alias names)
	const roleEntries: [string, string][] = [
		...(cfg.orchestrator?.model ? [["orchestrator", cfg.orchestrator.model]] as [string,string][] : []),
		...(cfg["title-maker"]?.model ? [["title-maker", cfg["title-maker"].model]] as [string,string][] : []),
		...(cfg.compaction?.model ? [["compaction", cfg.compaction.model]] as [string,string][] : []),
		...Object.entries(cfg.agents ?? {}).map(([n, r]) => [n, r.model] as [string, string]),
	];
	for (const [, alias] of roleEntries) {
		for (const spec of resolveChain(cfg, alias)) addSpec(spec);
	}
	// Merge registry models
	if (registry) {
		for (const m of registry.getAvailable()) {
			const spec = `${m.provider}/${m.id}`;
			if (spec.includes("/")) specs.add(spec);
		}
	}
	return Array.from(specs)
		.map(spec => ({ spec }))
		.sort((a, b) => {
			const pa = a.spec.split("/")[0];
			const pb = b.spec.split("/")[0];
			const c = pa.localeCompare(pb);
			if (c !== 0) return c;
			return a.spec.localeCompare(b.spec);
		});
}

/** Spawn a single pi child, measure TTFT and token/sec, resolve BenchSample. */
function benchModel(
	model: string,
	prompt: string,
	timeoutSec: number,
	signal: AbortSignal,
): Promise<BenchSample> {
	return new Promise<BenchSample>((resolve) => {
		let result: BenchSample;
		const inv = piInvocation(["--mode", "json", "-p", "--no-session", "--thinking", "off",
			"--model", model, prompt]);
		const startMs = Date.now();
		let ttftResolved = false;
		let firstTokenMs = 0;
		let buf = "";
		let lastOutputTokens = 0;
		let finished = false;
		let timedOut = false;

		const proc = spawn(inv.command, inv.args, {
			shell: false,
			detached: true,
			stdio: ["ignore", "pipe", "pipe"],
			env: { ...sanitizeEnv(), PICOPI_ACTIVE_PRESET: getActivePreset() },
		});

		const killTree = (sig: NodeJS.Signals) => {
			if (proc.pid != null) try { process.kill(-proc.pid, sig); } catch {}
		};

		const timeoutId = setTimeout(() => {
			timedOut = true;
			killTree("SIGTERM");
			setTimeout(() => killTree("SIGKILL"), 3000);
		}, timeoutSec * 1000);

		const onAbort = () => {
			clearTimeout(timeoutId);
			killTree("SIGTERM");
			setTimeout(() => killTree("SIGKILL"), 3000);
		};
		signal.addEventListener("abort", onAbort, { once: true });

		const onLine = (line: string) => {
			if (!line.trim()) return;
			let ev: any;
			try { ev = JSON.parse(line); } catch { return; }

			if (ev.type === "message_update" && ev.message?.role === "assistant") {
				const text = (ev.message.content ?? [])
					.filter((p: any) => p.type === "text")
					.map((p: any) => p.text as string)
					.join("");
				if (text && !ttftResolved) {
					ttftResolved = true;
					firstTokenMs = Date.now();
					result = { status: "alive", ttftMs: firstTokenMs - startMs };
				}
			}

			if ((ev.type === "message_end" || ev.type === "tool_result_end") && ev.message?.role === "assistant") {
				const usage = ev.message.usage;
				if (usage?.output != null) lastOutputTokens = usage.output;
				else if ((usage as any)?.outputTokens != null) lastOutputTokens = (usage as any).outputTokens;
				else if ((usage as any)?.completion_tokens != null) lastOutputTokens = (usage as any).completion_tokens;
			}
		};

		proc.stdout.on("data", (d: Buffer) => {
			buf += d.toString();
			const lines = buf.split("\n");
			buf = lines.pop() ?? "";
			for (const l of lines) onLine(l);
		});
		proc.stderr.on("data", () => {}); // discard

		proc.on("close", (code) => {
			if (finished) return;
			finished = true;
			clearTimeout(timeoutId);
			signal.removeEventListener("abort", onAbort);
			if (buf.trim()) onLine(buf);

			if (timedOut) {
				resolve({ status: "timeout" });
				return;
			}
			if (signal.aborted) {
				resolve({ status: "dead", error: "aborted" });
				return;
			}
			if (code !== 0 || !ttftResolved) {
				resolve({ status: "dead" });
				return;
			}
			const doneMs = Date.now();
			result = { ...result, status: "alive", outputTokens: lastOutputTokens || undefined, genMs: doneMs - firstTokenMs };
			result.tokensPerSec = tokPerSec(lastOutputTokens || undefined, result.genMs);
			resolve(result);
		});
		proc.on("error", () => {
			if (finished) return;
			finished = true;
			clearTimeout(timeoutId);
			signal.removeEventListener("abort", onAbort);
			resolve({ status: "dead", error: "spawn failed" });
		});
	});
}

async function mapLimit<I, O>(items: I[], limit: number, fn: (i: I, idx: number) => Promise<O>): Promise<O[]> {
	const out: O[] = new Array(items.length);
	let next = 0;
	const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
		while (true) {
			const i = next++;
			if (i >= items.length) return;
			out[i] = await fn(items[i], i);
		}
	});
	await Promise.all(workers);
	return out;
}

function aggregate(model: string, samples: BenchSample[], planned: number): BenchResult {
	const aliveSamples = samples.filter(s => s.status === "alive");
	const aliveCount = aliveSamples.length;

	// Overall status:
	// - alive if at least one sample is alive (a model that answered at least once is alive).
	// - else timeout if any sample timed out.
	// - else dead.
	let status: BenchStatus = "dead";
	if (aliveCount > 0) {
		status = "alive";
	} else if (samples.some(s => s.status === "timeout")) {
		status = "timeout";
	}

	const ttfts = aliveSamples.map(s => s.ttftMs).filter((v): v is number => v != null);
	const tps = aliveSamples.map(s => s.tokensPerSec).filter((v): v is number => v != null);

	const ttftMs = mean(ttfts);
	const tokensPerSec = mean(tps);

	let error: string | undefined;
	if (status === "alive") {
		error = undefined;
	} else {
		const nonAlive = samples.filter(s => s.status !== "alive");
		error = nonAlive.find(s => s.error && s.error.trim())?.error?.trim();
		if (!error) error = status === "timeout" ? "timeout" : "failed";
	}

	return {
		model,
		status,
		roundsPlanned: planned,
		aliveCount,
		samples,
		ttftMs,
		tokensPerSec,
		error,
	};
}

// ── widget renderer ───────────────────────────────────────────────────────────

/** Pad/truncate a string to an exact visible width. */
function col(s: string, w: number, right = false): string {
	const vw = visibleWidth(s);
	if (vw > w) return truncateToWidth(s, w, "…");
	const pad = " ".repeat(w - vw);
	return right ? pad + s : s + pad;
}

function makeWidgetRenderer(results: BenchResult[], title: string) {
	return (_tui: any, theme: any) => ({
		invalidate() {},
		render(width: number): string[] {
			const lines: string[] = [];
			const bg = (s: string) => { try { return theme.bg("customMessageBg", s); } catch { return s; } };
			const pad = (s: string) => s + " ".repeat(Math.max(0, width - visibleWidth(s)));
			const clip = (s: string) => truncateToWidth(s, Math.max(1, width));

			// Summary header
			const total = results.length;
			const running = results.filter(r => r.status === "running").length;
			const done = results.filter(r => r.status === "alive" || r.status === "dead" || r.status === "timeout").length;
			const alive = results.filter(r => r.status === "alive").length;
			const dead = results.filter(r => r.status === "dead").length;
			const timedout = results.filter(r => r.status === "timeout").length;
			const rounds = results[0]?.roundsPlanned ?? 1;
			const headerLeft = safeFg(theme, "accent", "⬡ bench") + "  " + safeFg(theme, "dim", truncateToWidth(title, 30, "…")) + `  r:${rounds}`;
			const headerRight = `total:${total}  running:${running}  done:${done}  ` +
				safeFg(theme, "success", `${alive}✓`) + " " +
				safeFg(theme, "error", `${dead}✗`) + " " +
				safeFg(theme, "warning", `${timedout}⚠`);
			const gap = Math.max(1, width - visibleWidth(headerLeft) - visibleWidth(headerRight));
			lines.push(bg(clip(pad(headerLeft + " ".repeat(gap) + headerRight))));

			// Fixed column widths
			const W_ST = 1, W_TTFT = 8, W_TOKPS = 7, W_INFO = 12;
			// 4 gaps between the 5 columns
			const gaps = 4;
			const fixedW = W_ST + W_TTFT + W_TOKPS + W_INFO;
			const W_MODEL = Math.max(10, width - fixedW - gaps);

			// Column header row
			const hRow = [
				col("S", W_ST),
				col("model", W_MODEL),
				col("TTFT", W_TTFT, true),
				col("tok/s", W_TOKPS, true),
				col("rounds", W_INFO),
			].join(" ");
			lines.push(bg(pad(safeFg(theme, "dim", clip(hRow)))));

			for (const r of results) {
				const color = STATUS_COLOR[r.status];
				const st = safeFg(theme, color, col(STATUS_GLYPH[r.status], W_ST));
				const modelC = safeFg(theme, r.status === "alive" ? "text" : "dim", col(r.model, W_MODEL));

				const ttftStr = r.ttftMs != null ? fmt(r.ttftMs) : (r.status === "running" ? "…" : "-");
				const ttftC = safeFg(theme, r.ttftMs != null ? "text" : "dim", col(ttftStr, W_TTFT, true));

				const tpsStr = r.tokensPerSec != null ? String(r.tokensPerSec) : "-";
				const tpsC = safeFg(theme, r.tokensPerSec != null ? "text" : "dim", col(tpsStr, W_TOKPS, true));

				let infoStr = "";
				if (r.status === "dead" || r.status === "timeout") {
					infoStr = r.error ?? (r.status === "timeout" ? "timeout" : "failed");
				} else {
					infoStr = `${r.aliveCount}/${r.roundsPlanned}`;
				}
				const infoColor = (r.status === "dead" || r.status === "timeout") ? "error" : "dim";
				const infoC = safeFg(theme, infoColor, col(infoStr, W_INFO));

				lines.push(bg(pad(clip([st, modelC, ttftC, tpsC, infoC].join(" ")))));
			}
			return lines;
		},
	});
}

// ── command / flag registration ───────────────────────────────────────────────

export function setupBench(pi: ExtensionAPI) {
	pi.registerFlag("bench", { description: "Run model benchmark on startup", type: "boolean", default: false });
	pi.registerFlag("bench-prompt", { description: "Prompt for --bench", type: "string" });
	pi.registerFlag("bench-rounds", { description: "Rounds to average for --bench (default 3)", type: "string" });

	pi.on("session_start", async (event, ctx) => {
		if (event.reason !== "startup") return;
		if (!pi.getFlag("bench")) return;
		const prompt = (pi.getFlag("bench-prompt") as string | undefined)?.trim() || DEFAULT_PROMPT;
		const roundsRaw = parseInt((pi.getFlag("bench-rounds") as string | undefined) ?? "", 10);
		const rounds = Number.isFinite(roundsRaw) && roundsRaw > 0 ? roundsRaw : 3;
		const cfg = loadConfig();
		await runBench(ctx, {
			prompt,
			models: null,
			concurrency: cfg.concurrency ?? DEFAULT_CONCURRENCY,
			timeoutSec: DEFAULT_TIMEOUT,
			rounds,
		});
	});

	pi.registerCommand("bench", {
		description: "Benchmark all configured models (TTFT, tok/s, status; --rounds N to average)",
		handler: async (args, ctx) => {
			const cfg = loadConfig();

			// parse args: [prompt] [--models m1,m2] [--concurrency N] [--timeout N] [--rounds N] [clear]
			let promptText = DEFAULT_PROMPT;
			let modelFilter: string[] | null = null;
			let concurrency = cfg.concurrency ?? DEFAULT_CONCURRENCY;
			let timeoutSec = DEFAULT_TIMEOUT;
			let rounds = 3;

			const parts = args.trim() ? args.trim().split(/\s+/) : [];
			const promptParts: string[] = [];
			for (let i = 0; i < parts.length; i++) {
				const p = parts[i];
				if (p === "--models" && parts[i + 1]) {
					modelFilter = parts[++i].split(",").map(s => s.trim()).filter(Boolean);
				} else if (p === "--concurrency" && parts[i + 1]) {
					const n = parseInt(parts[++i], 10);
					if (!isNaN(n) && n > 0) concurrency = n;
				} else if (p === "--timeout" && parts[i + 1]) {
					const n = parseInt(parts[++i], 10);
					if (!isNaN(n) && n > 0) timeoutSec = n;
				} else if (p === "--rounds" && parts[i + 1]) {
					const n = parseInt(parts[++i], 10);
					if (!isNaN(n) && n > 0) rounds = n;
				} else if (p === "clear") {
					if (activeBench) {
						activeBench.abort();
						activeBench = null;
					}
					ctx.ui.setWidget(BENCH_WIDGET_ID, undefined);
					ctx.ui.notify("Bench widget cleared", "info");
					return;
				} else if (p && !p.startsWith("--")) {
					promptParts.push(p);
				}
			}
			if (promptParts.length) promptText = promptParts.join(" ");

			await runBench(ctx, {
				prompt: promptText,
				models: modelFilter,
				concurrency,
				timeoutSec,
				rounds,
			});
		},
	});
}

// ── core runner ───────────────────────────────────────────────────────────────

interface BenchOptions {
	prompt: string;
	models: string[] | null;
	concurrency: number;
	timeoutSec: number;
	rounds: number;
}

async function runBench(ctx: ExtensionContext, opts: BenchOptions): Promise<void> {
	const cfg = loadConfig();
	const all = collectAllModels(cfg, ctx.modelRegistry);
	const filtered = opts.models
		? all.filter(({ spec }) => opts.models!.some(f => spec.includes(f)))
		: all;

	if (filtered.length === 0) {
		ctx.ui.notify("No models found in config. Check aliases/agents in config.json.", "warning");
		return;
	}

	const results: BenchResult[] = filtered.map(({ spec }) => ({
		model: spec,
		status: "pending",
		roundsPlanned: opts.rounds,
		aliveCount: 0,
		samples: [],
	}));

	const refresh = () => {
		ctx.ui.setWidget(BENCH_WIDGET_ID, makeWidgetRenderer(results, opts.prompt));
	};
	refresh();

	ctx.ui.notify(
		`Benchmarking ${filtered.length} model(s) × ${opts.rounds} round(s) (concurrency ${opts.concurrency}, timeout ${opts.timeoutSec}s)…`,
		"info",
	);

	if (activeBench) activeBench.abort();
	const ac = new AbortController();
	activeBench = ac;
	try {
		await mapLimit(results, opts.concurrency, async (r, i) => {
			const samples: BenchSample[] = [];
			for (let round = 0; round < opts.rounds; round++) {
				results[i] = { ...results[i], status: "running" };
				refresh();
				const sample = await benchModel(r.model, opts.prompt, opts.timeoutSec, ac.signal);
				samples.push(sample);
				// keep "running" until the last round so the progress is visible
				results[i] = aggregate(r.model, samples, opts.rounds);
				if (round < opts.rounds - 1) results[i] = { ...results[i], status: "running" };
				refresh();
			}
		});

		refresh();

		const alive = results.filter(r => r.status === "alive").length;
		const dead = results.filter(r => r.status === "dead").length;
		const timeout = results.filter(r => r.status === "timeout").length;
		ctx.ui.notify(
			`Bench done: ${alive} alive, ${dead} dead, ${timeout} timeout (${results.length} total)`,
			dead > 0 || timeout > 0 ? "warning" : "info",
		);
	} finally {
		if (activeBench === ac) activeBench = null;
	}
}
