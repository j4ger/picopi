/**
 * picopi /bench — benchmark all configured models with a unified prompt.
 *
 * Measures TTFT (time-to-first-token), tokens/sec, and alive/dead/timeout
 * status for every model in every alias chain.  Runs in parallel up to the
 * configured concurrency limit.  Renders a live widget (retained after completion)
 * and a summary notification.
 */

import { spawn } from "node:child_process";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { getActivePreset, loadConfig, resolveChain } from "./config.ts";
import { sanitizeEnv, piInvocation } from "./subagent.ts";

// ── constants ─────────────────────────────────────────────────────────────────

const DEFAULT_PROMPT = "In one sentence, what is the capital of France?";
const DEFAULT_TIMEOUT = 30; // seconds
const DEFAULT_CONCURRENCY = 3;

const BENCH_WIDGET_ID = "picopi-bench";

// ── types ─────────────────────────────────────────────────────────────────────

type BenchStatus = "pending" | "running" | "alive" | "dead" | "timeout";

interface BenchResult {
	model: string;           // provider/id
	status: BenchStatus;
	ttftMs?: number;         // time to first text token
	tokensPerSec?: number;
	outputTokens?: number;
	genMs?: number;          // generation time (first token → done)
	error?: string;
}

// ── helpers ───────────────────────────────────────────────────────────────────

const fmt = (ms: number) => ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;

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
 * preset-scoped aliases (e.g. `alias@preset`).  Each entry carries a provenance
 * label listing every alias key that resolves to it.
 */
function collectAllModels(
	cfg: ReturnType<typeof loadConfig>,
	registry?: ExtensionCommandContext["modelRegistry"],
): { spec: string; label: string }[] {
	const provenance = new Map<string, Set<string>>();
	const addSpec = (spec: string, key: string) => {
		if (!spec.includes("/")) return;
		if (!provenance.has(spec)) provenance.set(spec, new Set());
		provenance.get(spec)!.add(key);
	};
	// Walk every alias entry (base + preset-scoped)
	for (const [key, chain] of Object.entries(cfg.aliases ?? {})) {
		for (const spec of chain) addSpec(spec, key);
	}
	// Role references (literal provider/model or alias names)
	const roleEntries: [string, string][] = [
		...(cfg.orchestrator?.model ? [["orchestrator", cfg.orchestrator.model]] as [string,string][] : []),
		...(cfg["title-maker"]?.model ? [["title-maker", cfg["title-maker"].model]] as [string,string][] : []),
		...(cfg.compaction?.model ? [["compaction", cfg.compaction.model]] as [string,string][] : []),
		...Object.entries(cfg.agents ?? {}).map(([n, r]) => [n, r.model] as [string, string]),
	];
	for (const [role, alias] of roleEntries) {
		for (const spec of resolveChain(cfg, alias)) addSpec(spec, role);
	}
	// Merge registry models
	if (registry) {
		for (const m of registry.getAvailable()) {
			const spec = `${m.provider}/${m.id}`;
			if (!spec.includes("/")) continue;
			if (!provenance.has(spec)) provenance.set(spec, new Set(["registry"]));
			else provenance.get(spec)!.add("registry");
		}
	}
	return Array.from(provenance.entries()).map(([spec, keys]) => ({
		spec,
		label: Array.from(keys).join(","),
	}));
}

/** Spawn a single pi child, measure TTFT and token/sec, resolve BenchResult. */
function benchModel(
	model: string,
	prompt: string,
	timeoutSec: number,
	signal: AbortSignal,
): Promise<BenchResult> {
	return new Promise<BenchResult>((resolve) => {
		const result: BenchResult = { model, status: "running" };
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
					result.ttftMs = firstTokenMs - startMs;
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
				result.status = "timeout";
				resolve(result);
				return;
			}
			if (signal.aborted) {
				result.status = "dead";
				result.error = "aborted";
				resolve(result);
				return;
			}
			if (code !== 0 || !ttftResolved) {
				result.status = "dead";
				resolve(result);
				return;
			}
			const doneMs = Date.now();
			result.status = "alive";
			result.outputTokens = lastOutputTokens || undefined;
			result.genMs = doneMs - firstTokenMs;
			if (lastOutputTokens > 0 && result.genMs > 0) {
				result.tokensPerSec = Math.round((lastOutputTokens / result.genMs) * 1000);
			}
			resolve(result);
		});
		proc.on("error", () => {
			if (finished) return;
			finished = true;
			clearTimeout(timeoutId);
			signal.removeEventListener("abort", onAbort);
			result.status = "dead";
			result.error = "spawn failed";
			resolve(result);
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

// ── widget renderer ───────────────────────────────────────────────────────────

/** Pad/truncate a string to an exact visible width. */
function col(s: string, w: number, right = false): string {
	const vw = visibleWidth(s);
	if (vw > w) return truncateToWidth(s, w, "…");
	const pad = " ".repeat(w - vw);
	return right ? pad + s : s + pad;
}

function makeWidgetRenderer(results: (BenchResult & { label: string })[], title: string) {
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
			const headerLeft = safeFg(theme, "accent", "⬡ bench") + "  " + safeFg(theme, "dim", truncateToWidth(title, 30, "…"));
			const headerRight = `total:${total}  running:${running}  done:${done}  ` +
				safeFg(theme, "success", `${alive}✓`) + " " +
				safeFg(theme, "error", `${dead}✗`) + " " +
				safeFg(theme, "warning", `${timedout}⚠`);
			const gap = Math.max(1, width - visibleWidth(headerLeft) - visibleWidth(headerRight));
			lines.push(bg(clip(pad(headerLeft + " ".repeat(gap) + headerRight))));

			// Fixed column widths
			const W_ST = 1, W_TTFT = 9, W_TOKS = 7, W_TOKPS = 8, W_DUR = 8, W_ERR = 16;
			const fixedW = W_ST + 1 + W_TTFT + 1 + W_TOKPS + 1 + W_TOKS + 1 + W_DUR + 1 + W_ERR;
			const remaining = Math.max(12, width - fixedW - 2);
			const W_MODEL = Math.max(8, Math.floor(remaining * 0.65));
			const W_LABEL = Math.max(4, remaining - W_MODEL - 1);

			// Column header row
			const hRow = [
				col("S", W_ST), col("model", W_MODEL), col("alias", W_LABEL),
				col("TTFT", W_TTFT, true), col("tok/s", W_TOKPS, true),
				col("toks", W_TOKS, true), col("dur", W_DUR, true), col("error", W_ERR),
			].join(" ");
			lines.push(bg(pad(safeFg(theme, "dim", clip(hRow)))));

			for (const r of results) {
				const color = STATUS_COLOR[r.status];
				const st = safeFg(theme, color, col(STATUS_GLYPH[r.status], W_ST));
				const modelC = safeFg(theme, r.status === "alive" ? "text" : "dim", col(r.model, W_MODEL));
				const labelC = safeFg(theme, "dim", col(r.label, W_LABEL));

				const ttftStr = r.ttftMs != null ? fmt(r.ttftMs) : (r.status === "running" ? "…" : "-");
				const ttftC = safeFg(theme, r.ttftMs != null ? "text" : "dim", col(ttftStr, W_TTFT, true));

				// Compute tok/s whenever output tokens and genMs are available
				let tps = r.tokensPerSec;
				if (tps == null && r.outputTokens != null && r.genMs != null && r.genMs > 0)
					tps = Math.round((r.outputTokens / r.genMs) * 1000);
				const tpsC = safeFg(theme, tps != null ? "text" : "dim", col(tps != null ? String(tps) : "-", W_TOKPS, true));

				const toksC = safeFg(theme, r.outputTokens != null ? "text" : "dim",
					col(r.outputTokens != null ? String(r.outputTokens) : "-", W_TOKS, true));

				const totalMs = (r.ttftMs ?? 0) + (r.genMs ?? 0);
				const durStr = totalMs > 0 ? fmt(totalMs) : (r.status === "running" ? "…" : "-");
				const durC = safeFg(theme, totalMs > 0 ? "text" : "dim", col(durStr, W_DUR, true));

				let errStr = "";
				if (r.status === "dead") errStr = r.error ?? "failed";
				else if (r.status === "timeout") errStr = "timeout";
				const errC = safeFg(theme, errStr ? "error" : "dim", col(errStr, W_ERR));

				lines.push(bg(pad(clip([st, modelC, labelC, ttftC, tpsC, toksC, durC, errC].join(" ")))));
			}
			return lines;
		},
	});
}

// ── command registration ──────────────────────────────────────────────────────

export function setupBench(pi: ExtensionAPI) {
	pi.registerCommand("bench", {
		description: "Benchmark all configured models (TTFT, tok/s, alive/dead/timeout)",
		handler: async (args, ctx) => {
			const cfg = loadConfig();

			// parse args: [prompt] [--models m1,m2] [--concurrency N] [--timeout N] [--all-presets] [clear]
			let promptText = DEFAULT_PROMPT;
			let modelFilter: string[] | null = null;
			let concurrency = cfg.concurrency ?? DEFAULT_CONCURRENCY;
			let timeoutSec = DEFAULT_TIMEOUT;

			const parts = args.trim().split(/\s+/);
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
				} else if (p === "--all-presets" || p === "clear") {
					// clear: remove widget; --all-presets: noted (already covered via collectAllModels)
					if (p === "clear") {
						ctx.ui.setWidget(BENCH_WIDGET_ID, undefined);
						ctx.ui.notify("Bench widget cleared", "info");
						return;
					}
				} else if (p && !p.startsWith("--")) {
					promptParts.push(p);
				}
			}
			if (promptParts.length) promptText = promptParts.join(" ");

			let allModels = collectAllModels(cfg, ctx.modelRegistry);
			if (modelFilter) allModels = allModels.filter(({ spec }) => modelFilter!.some(f => spec.includes(f)));
			if (allModels.length === 0) {
				ctx.ui.notify("No models found in config. Check aliases/agents in config.json.", "warning");
				return;
			}

			const ac = new AbortController();
			const results: (BenchResult & { label: string })[] = allModels.map(({ spec, label }) => ({
				model: spec, label, status: "pending" as BenchStatus,
			}));

			const refresh = () => {
				ctx.ui.setWidget(BENCH_WIDGET_ID, makeWidgetRenderer(results, promptText) as any);
			};
			refresh();

			ctx.ui.notify(`Benchmarking ${allModels.length} model(s) (concurrency ${concurrency}, timeout ${timeoutSec}s)…`, "info");

			await mapLimit(results, concurrency, async (r, i) => {
				results[i] = { model: r.model, label: r.label, status: "running" };
				refresh();
				const res = await benchModel(r.model, promptText, timeoutSec, ac.signal);
				results[i] = { ...res, label: r.label };
				refresh();
			});

			// Final retained widget
			refresh();

			const alive = results.filter(r => r.status === "alive").length;
			const dead = results.filter(r => r.status === "dead").length;
			const timeout = results.filter(r => r.status === "timeout").length;
			ctx.ui.notify(
				`Bench done: ${alive} alive, ${dead} dead, ${timeout} timeout (${allModels.length} total)`,
				dead > 0 || timeout > 0 ? "warning" : "info"
			);
		},
	});
}
