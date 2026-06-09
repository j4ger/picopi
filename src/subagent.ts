/**
 * picopi subagents — specialist agents with status panel overlay.
 *
 * Agents: planner, explorer, fixer, auditor, web-searcher (markdown files).
 * Models/thinking from central config.json `agents` map.
 * Spawns isolated `pi` processes (JSON mode, no session).
 *
 * Modes: single {agent, task, reason}, parallel {tasks: [{agent, task, reason}]}
 * Features: status panel overlay, reason metadata, watchdog timer for stuck detection.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Message } from "@earendil-works/pi-ai";
import { type ExtensionAPI, getAgentDir, getMarkdownTheme, parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { Container, Markdown, matchesKey, Spacer, Text, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { getActivePreset, loadConfig, resolveChain, resolveModelChainForSpawn, resolveModelForSpawn } from "./config.ts";

// Constants

const MAX_PARALLEL = 6;
const DEFAULT_CONCURRENCY = 3;
const PER_CHILD_OUTPUT_CAP = 50 * 1024;
const MAX_DEPTH = 2;
const DEPTH_ENV = "PICOPI_SUBAGENT_DEPTH";
const DEFAULT_TIMEOUT = 120; // seconds
const WATCHDOG_INTERVAL = 5000; // ms
const LONG_RUNNING_TOOL_TIMEOUT_MULTIPLIER = 2;
const LONG_RUNNING_TOOLS = new Set(["bash", "subagent", "web_search"]);

// Allowlist of env var prefixes to pass through to child processes.
// Everything else is stripped to avoid leaking secrets (DB creds, cloud keys, etc.).
const SAFE_ENV_PREFIXES = [
	"PATH", "HOME", "USER", "SHELL", "TERM", "LANG", "LC_",
	"XDG_", "TMPDIR", "TEMP", "TMP",
	// Provider API keys — child pi needs these to authenticate
	"OPENAI_", "ANTHROPIC_", "GOOGLE_", "MISTRAL_", "COHERE_",
	"GROQ_", "TOGETHER_", "FIREWORKS_", "DEEPSEEK_", "XAI_",
	"AZURE_", "AWS_",
	"OLLAMA_", "LMSTUDIO_",
	// picopi / pi
	"PI_", "PICOPI_", "NODE_", "BUN_",
];
const SAFE_ENV_EXACT = new Set(["HOME", "PATH", "USER", "SHELL", "TERM"]);

let cachedSanitizedEnv: NodeJS.ProcessEnv | null = null;
function sanitizeEnv(): NodeJS.ProcessEnv {
	if (cachedSanitizedEnv) return cachedSanitizedEnv;
	const env: Record<string, string> = {};
	for (const [k, v] of Object.entries(process.env)) {
		if (v === undefined) continue;
		const upper = k.toUpperCase();
		if (SAFE_ENV_EXACT.has(upper) || SAFE_ENV_PREFIXES.some((p) => upper.startsWith(p))) {
			env[k] = v;
		}
	}
	cachedSanitizedEnv = env;
	return env;
}

// Tool defaults per agent role (config.json > markdown > these)
const BUILT_IN_DEFAULTS: Record<string, string[]> = {
	planner: ["read", "grep", "find", "ls"],
	explorer: ["read", "grep", "find", "ls", "bash"],
	fixer: ["read", "write", "edit", "bash"],
	auditor: ["read", "grep", "find", "ls", "bash"],
	"web-searcher": ["web_search", "fetch_content", "read"],
};

// Types

interface AgentDef {
	name: string;
	description: string;
	tools?: string[];
	systemPrompt: string;
}

interface RunResult {
	agent: string;
	task: string;
	reason?: string;
	exitCode: number;
	messages: Message[];
	stderr: string;
	model?: string;
	stopReason?: string;
	errorMessage?: string;
	step?: number;
	stuck?: boolean;
}

interface TranscriptEntry {
	kind: "assistant" | "tool-call" | "tool-done";
	text: string;
	toolName?: string;
	args?: any;
	result?: any;
	isError?: boolean;
}

interface SubagentStatus {
	id: string;
	agent: string;
	task: string;
	reason?: string;
	status: "running" | "done" | "failed" | "stuck";
	progress?: string;
	currentTool?: string;
	startTime: number;
	endTime?: number;
	lastActivity?: number;
	timeout?: number;
	transcript?: TranscriptEntry[];
	streamingText?: string;
	isStreaming?: boolean;
}

interface SubagentCompleteDetails {
	agent: string;
	task: string;
	reason?: string;
	ok: boolean;
	model?: string;
	durationMs: number;
	preview: string;
}

interface SubagentResultEntry {
	id?: string;
	transcript?: TranscriptEntry[];
	agent: string;
	task: string;
	reason?: string;
	ok: boolean;
	model?: string;
	durationMs: number;
	output: string;
	errorMessage?: string;
	stuck?: boolean;
	timestamp: number;
}

const RESULT_OUTPUT_CAP = 4096;
const TRANSCRIPT_MAX_ENTRIES = 200;
const TRANSCRIPT_PERSIST_ENTRIES = 80;
const TRANSCRIPT_TEXT_CAP = 2000;
// Bound the durable transcript so the session file can't balloon across many runs.
const TRANSCRIPT_PERSIST_BYTES = 16384;

/** Keep the most recent transcript entries within a byte budget for persistence. */
function trimTranscriptForPersist(t: TranscriptEntry[] | undefined): TranscriptEntry[] {
	if (!t || !t.length) return [];
	const tail = t.slice(-TRANSCRIPT_PERSIST_ENTRIES);
	let budget = TRANSCRIPT_PERSIST_BYTES;
	const out: TranscriptEntry[] = [];
	for (let i = tail.length - 1; i >= 0; i--) {
		budget -= Buffer.byteLength(tail[i].text, "utf8");
		if (budget < 0 && out.length) break;
		out.unshift(tail[i]);
	}
	return out;
}

// Global state

const activeSubagents = new Map<string, SubagentStatus>();
const cleanupTimers = new Map<string, NodeJS.Timeout>();
let extensionCtx: any = null;
const resultHistory: SubagentResultEntry[] = [];

function rebuildResults(ctx: any) {
	resultHistory.length = 0;
	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type === "custom" && entry.customType === "subagent-result") {
			const d = entry.data as SubagentResultEntry | undefined;
			if (d && typeof d.agent === "string" && typeof d.task === "string") resultHistory.push(d);
		}
	}
}

function capForPersist(text: string): string {
	if (text.length <= RESULT_OUTPUT_CAP) return text;
	return text.slice(0, RESULT_OUTPUT_CAP) + "\n\n[truncated for session storage]";
}

function persistResult(pi: ExtensionAPI, r: RunResult, durationMs: number, id: string) {
	pi.appendEntry("subagent-result", {
		id,
		transcript: trimTranscriptForPersist(activeSubagents.get(id)?.transcript),
		agent: r.agent,
		task: r.task,
		reason: r.reason,
		ok: !failed(r),
		model: r.model,
		durationMs,
		output: capForPersist(output(r)),
		errorMessage: r.errorMessage || undefined,
		stuck: r.stuck,
		timestamp: Date.now(),
	} satisfies SubagentResultEntry);
}

// Helpers

const formatDuration = (ms: number): string => {
	if (ms < 1000) return `${ms}ms`;
	if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
	const m = Math.floor(ms / 60_000);
	const s = Math.round((ms % 60_000) / 1000);
	return `${m}m${s}s`;
};

const outputPreview = (text: string, maxLen = 120): string => {
	const first = text.split("\n")[0].trim();
	return first.length > maxLen ? first.slice(0, maxLen) + "..." : first;
};

function finalOutput(messages: Message[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i];
		if (m.role === "assistant") for (const p of m.content) if (p.type === "text") return p.text;
	}
	return "";
}

function capOutput(text: string): string {
	if (Buffer.byteLength(text, "utf8") <= PER_CHILD_OUTPUT_CAP) return text;
	let t = text.slice(0, PER_CHILD_OUTPUT_CAP);
	while (Buffer.byteLength(t, "utf8") > PER_CHILD_OUTPUT_CAP) t = t.slice(0, -1);
	return `${t}\n\n[output truncated]`;
}

function failed(r: RunResult): boolean {
	return r.exitCode !== 0 || r.stopReason === "error" || r.stopReason === "aborted" || r.stuck === true;
}

function output(r: RunResult): string {
	if (r.stuck) return "Provider stopped responding (timeout)";
	if (!failed(r)) return finalOutput(r.messages) || "(no output)";
	const parts: string[] = [];
	if (r.errorMessage) parts.push(r.errorMessage);
	if (r.stderr?.trim()) parts.push(r.stderr.trim());
	if (!parts.length) parts.push(finalOutput(r.messages) || "(no output)");
	return parts.join("\n");
}

/** True if the failure looks like a model/API issue (retryable), as opposed to
 *  a task-level error (bad code, missing file, etc.). */
function isModelError(r: RunResult): boolean {
	// Watchdog timeout → definitely a model/network issue.
	if (r.stuck) return true;
	// User cancelled.
	if (r.stopReason === "aborted") return false;
	// API error patterns in the error message.
	if (r.errorMessage) {
		const msg = r.errorMessage.toLowerCase();
		if (/overloaded|rate.?limit|too many requests|server error|internal error|503|502|500|timeout|unavailable|capacity/i.test(msg)) return true;
	}
	// Connection / network errors in stderr.
	if (r.stderr) {
		const err = r.stderr.toLowerCase();
		if (/econnrefused|econnreset|etimedout|enotfound|socket hang up|eaddrinuse/i.test(err)) return true;
	}
	// stopReason "error" with zero exit code but no other details → tentatively a model error.
	if (r.stopReason === "error" && !r.exitCode) return true;
	return false;
}

// Status Panel

// Status symbols: running=◌ done=✓ stuck=⚠ failed=✗
const STATUS_ICON: Record<string, string> = { running: "◌", done: "✓", stuck: "⚠", failed: "✗" };
let inspectorOpen = false;
let subagentsFolded = true;

function updateStatusPanel(context?: any) {
	if (context) extensionCtx = context;
	if (!extensionCtx) return;

	if (inspectorOpen || activeSubagents.size === 0) {
		extensionCtx.ui.setWidget("picopi-subagents", undefined);
		return;
	}

	// Snapshot state for the render callback — must not read extensionCtx.ui.theme outside render
	const all = [...activeSubagents.values()];
	const isFolded = subagentsFolded;

	extensionCtx.ui.setWidget("picopi-subagents", (_tui: any, theme: any) => ({
		invalidate() {},
		render(width: number): string[] {
			const clip = (line: string) => truncateToWidth(line, Math.max(1, width), "…");
			const counts = {
				running: all.filter(s => s.status === "running").length,
				stuck: all.filter(s => s.status === "stuck").length,
				failed: all.filter(s => s.status === "failed").length,
				done: all.filter(s => s.status === "done").length,
			};

			if (isFolded) {
				// Folded: one-line overview
				const parts: string[] = [];
				if (counts.running) parts.push(theme.fg("warning", `◌${counts.running}`));
				if (counts.stuck) parts.push(theme.fg("warning", `⚠${counts.stuck}`));
				if (counts.failed) parts.push(theme.fg("error", `✗${counts.failed}`));
				if (counts.done) parts.push(theme.fg("success", `✓${counts.done}`));

				let line = theme.fg("muted", "▸ subagents") + "  " + parts.join(" ");

				// Top running agent with elapsed and progress
				const running = all.filter(s => s.status === "running");
				if (running.length > 0) {
					const top = running.reduce((a, b) => a.startTime < b.startTime ? a : b);
					const elapsed = formatDuration(Date.now() - top.startTime);
					line += theme.fg("dim", "  ·  ") + theme.fg("warning", truncateToWidth(top.agent, 12, "")) + theme.fg("dim", ` ${elapsed}`);
					if (top.progress || top.currentTool) {
						line += theme.fg("dim", ` (${truncateToWidth(top.progress || top.currentTool!, 16, "…")})`);
					}
				}

				line += theme.fg("dim", "  ·  ") + theme.fg("dim", "[alt+s]");
				return [clip(line)];
			}

			// Expanded: compact list of active subagents, capped to ~12 lines
			const lines: string[] = [];
			lines.push(theme.fg("accent", "▾ Subagents") + "  " + theme.fg("dim", "[alt+s] fold · [/subagents]"));

			const sorted = [
				...all.filter(s => s.status === "stuck"),
				...all.filter(s => s.status === "failed"),
				...all.filter(s => s.status === "running"),
				...all.filter(s => s.status === "done"),
			];

			const maxDisplay = 10;
			const shown = sorted.slice(0, maxDisplay);
			const remaining = sorted.length - shown.length;

			for (const sub of shown) {
				const icon = STATUS_ICON[sub.status] ?? "◌";
				const color = sub.status === "running" ? "warning" : sub.status === "done" ? "success" : sub.status === "stuck" ? "warning" : "error";
				const elapsed = formatDuration((sub.endTime ?? Date.now()) - sub.startTime);

				if (sub.status === "stuck") {
					lines.push(theme.fg("dim", "  ") + theme.fg(color, `${icon} ${truncateToWidth(sub.agent, 12, "")}  ${elapsed}`) + theme.fg("warning", " timeout"));
				} else if (sub.status === "failed") {
					lines.push(theme.fg("dim", "  ") + theme.fg(color, `${icon} ${truncateToWidth(sub.agent, 12, "")}  ${elapsed}`) + theme.fg("error", " failed"));
				} else if (sub.status === "running") {
					const progress = truncateToWidth(sub.progress || sub.currentTool || "thinking…", 20, "…");
					lines.push(theme.fg("dim", "  ") + theme.fg(color, `${icon} ${truncateToWidth(sub.agent, 12, "")}  ${elapsed}`) + theme.fg("dim", `  ${progress}`));
				} else {
					lines.push(theme.fg("dim", "  ") + theme.fg(color, `${icon} ${truncateToWidth(sub.agent, 12, "")}  ${elapsed}`));
				}
			}

			if (remaining > 0) {
				lines.push(theme.fg("dim", "  +" + remaining + " more"));
			}

			return lines.map(clip);
		},
	}));
}

const pushTranscript = (id: string, kind: TranscriptEntry["kind"], text: string, opts?: { toolName?: string; args?: any; result?: any; isError?: boolean }) => {
	const sub = activeSubagents.get(id);
	if (!sub || !text) return;
	const t = sub.transcript ?? (sub.transcript = []);
	const entry: TranscriptEntry = {
		kind,
		text: text.length > TRANSCRIPT_TEXT_CAP ? text.slice(0, TRANSCRIPT_TEXT_CAP) + "…" : text,
		...opts
	};
	t.push(entry);
	if (t.length > TRANSCRIPT_MAX_ENTRIES) t.splice(0, t.length - TRANSCRIPT_MAX_ENTRIES);
};

const primaryArg = (tool?: string, args?: any): string => {
	if (!args || typeof args !== "object") return "";
	switch (tool) {
		case "read": case "edit": case "write": return args.path ?? "";
		case "bash": return args.command ?? "";
		case "web_search": return args.query ?? "";
		case "subagent": return args.agent ? `${args.agent} "${(args.task ?? "").slice(0, 50)}"` : "";
		case "todo": return args.action ?? "";
		default: {
			const first = Object.values(args).find(v => typeof v === "string");
			return first ? String(first).slice(0, 60) : "";
		}
	}
};

const summarizeResult = (tool?: string, result?: any): string => {
	if (result == null) return "ok";
	if (typeof result === "string") return result.length > 60 ? result.slice(0, 60) + "…" : result;
	if (typeof result === "object") {
		if (result.exitCode != null) return `exit ${result.exitCode}`;
		if (result.lineCount != null) return `${result.lineCount} lines`;
		if (result.error) return String(result.error).slice(0, 60);
	}
	return String(result).slice(0, 60);
};

const clearCleanupTimer = (id: string) => {
	const timer = cleanupTimers.get(id);
	if (timer) clearTimeout(timer);
	cleanupTimers.delete(id);
};

const scheduleCleanup = (id: string, status: SubagentStatus["status"], delay: number) => {
	clearCleanupTimer(id);
	const timer = setTimeout(() => {
		const current = activeSubagents.get(id);
		if (current?.status === status) activeSubagents.delete(id);
		cleanupTimers.delete(id);
		updateStatusPanel();
	}, delay);
	cleanupTimers.set(id, timer);
};

const trackAgent = (id: string, agent: string, task: string, timeout?: number, reason?: string) => {
	clearCleanupTimer(id);
	const now = Date.now();
	const sub: SubagentStatus = { id, agent, task, reason, status: "running", startTime: now, lastActivity: now, timeout, transcript: [] };
	activeSubagents.set(id, sub);
	updateStatusPanel();
};

const trackProgress = (id: string, progress?: string, tool?: string) => {
	const sub = activeSubagents.get(id);
	if (!sub) return;
	clearCleanupTimer(id);
	if (sub.status !== "running") {
		sub.status = "running";
		sub.endTime = undefined;
	}
	if (progress) sub.progress = progress;
	if (tool) sub.currentTool = tool;
	sub.lastActivity = Date.now();
	updateStatusPanel();
};

const trackComplete = (id: string, success: boolean) => {
	const sub = activeSubagents.get(id);
	if (!sub) return;
	sub.status = success ? "done" : "failed";
	sub.endTime = Date.now();
	updateStatusPanel();
	scheduleCleanup(id, sub.status, success ? 3000 : 5000);
};

const trackStuck = (id: string) => {
	const sub = activeSubagents.get(id);
	if (!sub) return;
	sub.status = "stuck";
	sub.endTime = Date.now();
	updateStatusPanel();
	scheduleCleanup(id, "stuck", 8000);
};

// Agent Discovery

function discoverAgents(): AgentDef[] {
	const here = import.meta.dirname;
	const dirs = [
		path.join(getAgentDir(), "agents"),
		path.resolve(here, "..", "agents"),
		path.resolve(here, "..", "agent", "agents"),
	];
	const seen = new Map<string, AgentDef>();
	for (const dir of dirs) {
		let entries: fs.Dirent[];
		try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
		for (const e of entries) {
			if (!e.name.endsWith(".md")) continue;
			let content: string;
			try { content = fs.readFileSync(path.join(dir, e.name), "utf-8"); } catch { continue; }
			const { frontmatter, body } = parseFrontmatter<Record<string, string>>(content);
			if (!frontmatter.name || !frontmatter.description) continue;
			if (seen.has(frontmatter.name)) continue;
			const tools = frontmatter.tools?.split(",").map((t) => t.trim()).filter(Boolean);
			seen.set(frontmatter.name, {
				name: frontmatter.name,
				description: frontmatter.description,
				tools: tools && tools.length ? tools : undefined,
				systemPrompt: body,
			});
		}
	}
	return Array.from(seen.values());
}

// Runner

function piInvocation(args: string[]): { command: string; args: string[] } {
	const script = process.argv[1];
	const isBunVirtual = script?.startsWith("/$bunfs/root/");
	if (script && !isBunVirtual && fs.existsSync(script)) return { command: process.execPath, args: [script, ...args] };
	const exe = path.basename(process.execPath).toLowerCase();
	if (!/^(node|bun)(\.exe)?$/.test(exe)) return { command: process.execPath, args };
	return { command: "pi", args };
}

function resolveTools(agent: AgentDef, role?: { tools?: string[] }): string[] {
	if (role?.tools?.length) return role.tools;
	if (agent.tools?.length) return agent.tools;
	return BUILT_IN_DEFAULTS[agent.name] ?? ["read", "write", "edit", "bash"];
}

async function runAgent(
	defaultCwd: string,
	agents: AgentDef[],
	name: string,
	task: string,
	signal: AbortSignal | undefined,
	statusId: string,
	timeout?: number,
	reason?: string,
): Promise<RunResult> {
	const agent = agents.find((a) => a.name === name);
	if (!agent) {
		trackComplete(statusId, false);
		return { agent: name, task, reason, exitCode: 1, messages: [], stderr: `Unknown agent "${name}". Available: ${agents.map((a) => `"${a.name}"`).join(", ") || "none"}.` };
	}

	const cfg = loadConfig();
	const role = cfg.agents?.[name];
	const tools = resolveTools(agent, role);
	const effectiveTimeout = timeout || role?.timeout || DEFAULT_TIMEOUT;

	// ── Resolve the full model chain for retry-with-fallback ─────────────
	let modelSpecs: string[];
	if (role) {
		modelSpecs = resolveModelChainForSpawn(cfg, role.model);
		if (modelSpecs.length === 0) {
			// No model in the chain matched models.json with an API key.
			// Pass the first raw chain entry so pi gives a meaningful
			// "model not found" error.
			const rawChain = resolveChain(cfg, role.model);
			modelSpecs = rawChain.length > 0 ? [rawChain[0]] : [];
		}
	} else {
		modelSpecs = [];
	}
	if (modelSpecs.length === 0) modelSpecs = [name];

	// ── Build shared args (everything except --model / --thinking) ───────
	const sharedArgs = ["--mode", "json", "-p", "--no-session"];
	sharedArgs.push("--tools", tools.join(","));
	sharedArgs.push("--extension", import.meta.dirname);

	let promptDir: string | null = null;
	let promptPath: string | null = null;

	try {
		if (agent.systemPrompt.trim()) {
			promptDir = fs.mkdtempSync(path.join(os.tmpdir(), "picopi-agent-"));
			promptPath = path.join(promptDir, `${name.replace(/[^\w.-]+/g, "_")}.md`);
			fs.writeFileSync(promptPath, agent.systemPrompt, { encoding: "utf-8", mode: 0o600 });
			sharedArgs.push("--append-system-prompt", promptPath);
		}
		sharedArgs.push(`Task: ${task}`);

		// ── Try each model in the chain ──────────────────────────────────
		let lastResult: RunResult | null = null;
		for (let attempt = 0; attempt < modelSpecs.length; attempt++) {
			const spec = modelSpecs[attempt];
			const args = [...sharedArgs, "--model", spec];
			if (role?.thinking) args.push("--thinking", role.thinking);

			if (attempt > 0) {
				trackProgress(statusId, `retrying with ${spec}`);
			}

			const base: RunResult = { agent: name, task, reason, exitCode: 0, messages: [], stderr: "" };
			let aborted = false;
			let stuck = false;
			let lastEventTime = Date.now();
			let currentToolName: string | undefined;
			let watchdogId: NodeJS.Timeout | null = null;

			const code = await new Promise<number>((resolve) => {
				const inv = piInvocation(args);
				const childDepth = Number(process.env[DEPTH_ENV] ?? "0") + 1;
				const proc = spawn(inv.command, inv.args, {
					cwd: defaultCwd,
					shell: false,
					detached: true,
					stdio: ["ignore", "pipe", "pipe"],
					env: { ...sanitizeEnv(), [DEPTH_ENV]: String(childDepth), PICOPI_ACTIVE_PRESET: getActivePreset() },
				});
				const killTree = (sig: NodeJS.Signals) => {
					if (proc.pid != null) {
						try { process.kill(-proc.pid, sig); } catch {}
					}
				};
				const sigkillTimers: NodeJS.Timeout[] = [];
				let buf = "";

				// Register abort handler after spawn (proc is always valid here).
				const killOnAbort = () => { aborted = true; killTree("SIGTERM"); sigkillTimers.push(setTimeout(() => killTree("SIGKILL"), 4000)); };
				if (signal) {
					signal.aborted ? killOnAbort() : signal.addEventListener("abort", killOnAbort, { once: true });
				}

				// Per-process watchdog — only mark as stuck on the first
				// attempt; retries show "retrying" via trackProgress above.
				watchdogId = setInterval(() => {
					const multiplier = currentToolName && LONG_RUNNING_TOOLS.has(currentToolName)
						? LONG_RUNNING_TOOL_TIMEOUT_MULTIPLIER
						: 1;
					if (Date.now() - lastEventTime > effectiveTimeout * 1000 * multiplier) {
						stuck = true;
						if (attempt === 0) trackStuck(statusId);
						killTree("SIGTERM");
						sigkillTimers.push(setTimeout(() => killTree("SIGKILL"), 4000));
					}
				}, WATCHDOG_INTERVAL);

				const onLine = (line: string) => {
					if (!line.trim()) return;
					let ev: any;
					try { ev = JSON.parse(line); } catch { return; }

					// Any event means process is alive
					lastEventTime = Date.now();

					if (ev.type === "tool_execution_start") {
						currentToolName = ev.toolName;
						lastEventTime = Date.now();
						trackProgress(statusId, undefined, ev.toolName);
						pushTranscript(statusId, "tool-call", ev.toolName, { toolName: ev.toolName, args: ev.args });
					}

					if (ev.type === "tool_execution_end") {
						currentToolName = undefined;
						lastEventTime = Date.now();
						pushTranscript(statusId, "tool-done", ev.toolName ?? "done", { toolName: ev.toolName, result: ev.result, isError: ev.isError });
					}

					if (ev.type === "message_update" && ev.message) {
						const sub = activeSubagents.get(statusId);
						if (sub) {
							const msg = ev.message;
							if (msg.role === "assistant" && Array.isArray(msg.content)) {
								const text = msg.content
									.filter((p: any) => p.type === "text")
									.map((p: any) => p.text)
									.join("");
								sub.streamingText = text || undefined;
								sub.isStreaming = true;
								updateStatusPanel();
							}
						}
					}

					if ((ev.type === "message_end" || ev.type === "tool_result_end") && ev.message) {
						const msg = ev.message as Message;
						base.messages.push(msg);
						if (msg.role === "assistant") {
							if (!base.model && msg.model) base.model = msg.model;
							if (msg.stopReason) base.stopReason = msg.stopReason;
							if (msg.errorMessage) base.errorMessage = msg.errorMessage;
							const text = msg.content.filter((p: any) => p.type === "text").map((p: any) => p.text).join("");
							if (text) pushTranscript(statusId, "assistant", text);
						}
						// Clear streaming state — text is now in transcript
						const sub = activeSubagents.get(statusId);
						if (sub) { sub.streamingText = undefined; sub.isStreaming = false; }
						const turns = base.messages.filter(m => m.role === "assistant").length;
						const label = attempt > 0
							? `${turns} turns (attempt ${attempt + 1}/${modelSpecs.length})`
							: `${turns} turns`;
						trackProgress(statusId, label);
					}
				};

				proc.stdout.on("data", (d) => {
					lastEventTime = Date.now(); // any output means alive
					buf += d.toString();
					const lines = buf.split("\n");
					buf = lines.pop() || "";
					for (const l of lines) onLine(l);
				});
				proc.stderr.on("data", (d) => { base.stderr += d.toString(); });
				// Safety: resolve if the child remains silent well beyond the watchdog
				// window. This is idle-based, so healthy output/events keep it alive.
				let resolved = false;
				const safeResolve = (code: number) => { if (!resolved) { resolved = true; resolve(code); } };
				const hangTimer = setInterval(() => {
					if (Date.now() - lastEventTime <= effectiveTimeout * LONG_RUNNING_TOOL_TIMEOUT_MULTIPLIER * 2 * 1000) return;
					stuck = true;
					if (attempt === 0) trackStuck(statusId);
					killTree("SIGTERM");
					sigkillTimers.push(setTimeout(() => killTree("SIGKILL"), 4000));
					safeResolve(1);
				}, WATCHDOG_INTERVAL);

				const cleanup = () => {
					clearInterval(hangTimer);
					if (watchdogId) { clearInterval(watchdogId); watchdogId = null; }
					for (const t of sigkillTimers) clearTimeout(t);
					sigkillTimers.length = 0;
					if (signal) signal.removeEventListener("abort", killOnAbort);
				};
				proc.on("close", (c) => {
					cleanup();
					if (buf.trim()) onLine(buf);
					safeResolve(c ?? 0);
				});
				proc.on("error", () => {
					cleanup();
					safeResolve(1);
				});

			});

			if (watchdogId) clearInterval(watchdogId);
			base.exitCode = code;
			base.stuck = stuck;
			if (aborted) base.stopReason = "aborted";

			// Success?
			if (!failed(base)) {
				trackComplete(statusId, true);
				return base;
			}

			lastResult = base;

			// Retryable model error and more models in the chain?
			if (attempt < modelSpecs.length - 1 && isModelError(base)) {
				continue;
			}

			// Non-retryable error, or last model in chain — stop.
			break;
		}

		trackComplete(statusId, false);
		return lastResult ?? { agent: name, task, reason, exitCode: 1, messages: [], stderr: "No models available for this agent." };
	} catch (e) {
		trackComplete(statusId, false);
		throw e;
	} finally {
		try { if (promptDir) fs.rmSync(promptDir, { recursive: true, force: true }); } catch {}
		cachedSanitizedEnv = null; // allow GC
	}
}

async function mapLimit<I, O>(items: I[], limit: number, fn: (i: I, idx: number) => Promise<O>): Promise<O[]> {
	const out: O[] = new Array(items.length);
	let next = 0;
	const workers = new Array(Math.max(1, Math.min(limit, items.length))).fill(0).map(async () => {
		while (true) {
			const i = next++;
			if (i >= items.length) return;
			out[i] = await fn(items[i], i);
		}
	});
	await Promise.all(workers);
	return out;
}

// Schema

const TaskItem = Type.Object({
	agent: Type.String({ description: "Agent name" }),
	task: Type.String({ description: "Task for the agent" }),
	reason: Type.Optional(Type.String({ description: "Rationale for delegating this task" })),
});
const Params = Type.Object({
	agent: Type.Optional(Type.String({ description: "Agent name (single mode)" })),
	task: Type.Optional(Type.String({ description: "Task (single mode)" })),
	tasks: Type.Optional(Type.Array(TaskItem, { description: "Parallel: array of {agent, task, reason}" })),
	reason: Type.Optional(Type.String({ description: "Rationale for delegation; used directly in single mode and as fallback for parallel tasks" })),
	timeout: Type.Optional(Type.Number({ description: `Watchdog timeout in seconds (default: ${DEFAULT_TIMEOUT})` })),
});

// Extension

export function setupSubagent(pi: ExtensionAPI) {
	// Lightweight elapsed-time updater while subagents are live
	const _liveTimer = setInterval(() => {
		if (!extensionCtx || activeSubagents.size === 0 || inspectorOpen) return;
		const hasLive = [...activeSubagents.values()].some(s => s.status === "running" || s.status === "stuck");
		if (hasLive) updateStatusPanel(extensionCtx);
	}, 2000);

	pi.on("session_start", (_e, ctx) => { extensionCtx = ctx; subagentsFolded = true; rebuildResults(ctx); updateStatusPanel(ctx); });
	pi.on("session_tree", (_e, ctx) => rebuildResults(ctx));
	pi.on("session_shutdown", () => {
		activeSubagents.clear();
		for (const timer of cleanupTimers.values()) clearTimeout(timer);
		cleanupTimers.clear();
		clearInterval(_liveTimer);
		if (extensionCtx) extensionCtx.ui.setWidget("picopi-subagents", undefined);
	});

	pi.registerMessageRenderer("subagent-complete", (message, _opts, theme) => {
		const d = message.details as SubagentCompleteDetails | undefined;
		if (!d) return new Text(String(message.content), 0, 0);
		const icon = d.ok ? theme.fg("success", "✓") : theme.fg("error", "✗");
		const agent = theme.bold(theme.fg("accent", d.agent));
		const dur = theme.fg("dim", formatDuration(d.durationMs));
		const model = d.model ? theme.fg("dim", ` ${d.model}`) : "";
		let text = `${icon} ${agent}${model} ${dur}`;
		if (d.preview) {
			const previewLine = d.ok
				? theme.fg("dim", d.preview)
				: theme.fg("error", `✗ ${d.preview}`);
			text += `\n${previewLine}`;
		}
		if (d.reason) text += `\n${theme.fg("dim", `reason: ${outputPreview(d.reason, 100)}`)}`;
		return new Text(text, 1, 0);
	});

	pi.registerTool({
		name: "subagent",
		label: "Subagent",
		description: [
			"Delegate to a specialist subagent with an isolated context window.",
			"Agents: planner, explorer, fixer, auditor, web-searcher (see agents/ dir).",
			"Models/thinking from central config.json. Modes: single {agent,task}, parallel {tasks}.",
			"Includes optional reason metadata and watchdog timeout detection for stuck providers.",
		].join(" "),
		parameters: Params,
		promptSnippet: "Delegate scoped work to specialist subagents (planner/explorer/fixer/auditor/web-searcher)",
		promptGuidelines: [
			"Delegate by default: send heavy reasoning to planner, recon to explorer, implementation to fixer, review to auditor, research to web-searcher — keep the main context focused.",
			"Include a brief reason when delegating so /subagents can show why the agent was called.",
			"Give each fixer ONE small, concrete task (~1-3 files, a single concern). Oversized tasks stall the fixer; split them or run planner first.",
			"Run independent tasks in parallel via { tasks: [...] }.",
		],

		async execute(_id, params, signal, onUpdate, ctx) {
			extensionCtx = ctx;
			const depth = Number(process.env[DEPTH_ENV] ?? "0");
			if (depth >= MAX_DEPTH) {
				return {
					content: [{ type: "text", text: `Subagent nesting limit reached (depth ${depth}); refusing to spawn.` }],
					details: { results: [] }, isError: true,
				};
			}

			const agents = discoverAgents();
			const hasSingle = Boolean(params.agent && params.task);
			const hasTasks = (params.tasks?.length ?? 0) > 0;
			if (Number(hasSingle) + Number(hasTasks) !== 1) {
				const avail = agents.map((a) => `${a.name}: ${a.description}`).join("\n");
				return { content: [{ type: "text", text: `Provide exactly one mode.\nAvailable agents:\n${avail}` }], details: { results: [] } };
			}

			const timeout = params.timeout;

			// Parallel mode
			if (hasTasks) {
				if (params.tasks!.length > MAX_PARALLEL) {
					return { content: [{ type: "text", text: `Too many tasks (max ${MAX_PARALLEL})` }], details: { results: [] } };
				}

				const totalPanes = params.tasks!.length;
				const sids = params.tasks!.map((t, i) => {
					const sid = `par-${i}-${Date.now()}`;
					trackAgent(sid, t.agent, t.task, timeout, t.reason ?? params.reason);
					return sid;
				});

				let completed = 0;
				let okTally = 0;
				let stuckTally = 0;
				const startMs = Date.now();

				const cfg = loadConfig();
				const concurrency = cfg.concurrency ?? DEFAULT_CONCURRENCY;
				const results = await mapLimit(params.tasks!, concurrency, async (t, i) => {
					const result = await runAgent(ctx.cwd, agents, t.agent, t.task, signal, sids[i], timeout, t.reason ?? params.reason);
					completed++;
					if (!failed(result)) okTally++;
					if (result.stuck) stuckTally++;

					onUpdate?.({
						content: [{ type: "text", text: `${completed}/${totalPanes} done - ${t.agent} ${failed(result) ? "failed" : "ok"}` }],
						details: { completed, total: totalPanes },
					});

					// The last task to finish also carries the batch summary, so we don't
					// emit a separate (redundant) aggregate completion message/turn.
					const isLast = completed === totalPanes;
					const label = `${t.agent} ${failed(result) ? "failed" : "done"}`;
					const batchSummary = stuckTally > 0 ? `${okTally} ok, ${stuckTally} timeout` : `${okTally}/${totalPanes} ok`;
					const details: SubagentCompleteDetails = isLast
						? {
							agent: params.tasks!.map((x) => x.agent).join(", "),
							task: `${totalPanes} parallel tasks`,
							reason: params.reason,
							ok: okTally === totalPanes,
							durationMs: Date.now() - startMs,
							preview: okTally === totalPanes ? `All ${totalPanes} tasks completed` : `${totalPanes - okTally} failed`,
						}
						: {
							agent: t.agent, task: t.task, reason: t.reason ?? params.reason, ok: !failed(result),
							model: result.model, durationMs: Date.now() - startMs,
							preview: outputPreview(output(result)),
						};
					pi.sendMessage({
						customType: "subagent-complete",
						content: isLast ? `${label} · batch ${batchSummary}` : label,
						display: true,
						details,
					}, { deliverAs: "steer" });

					persistResult(pi, result, Date.now() - startMs, sids[i]);
					return result;
				});

				const ok = results.filter((r) => !failed(r)).length;
				const stuckCount = results.filter(r => r.stuck).length;
				const summary = stuckCount > 0 ? `${ok} ok, ${stuckCount} timeout` : `${ok}/${results.length} ok`;

				const text = results.map((r) => `### [${r.agent}] ${r.stuck ? "timeout" : failed(r) ? "failed" : "ok"}\n\n${capOutput(output(r))}`).join("\n\n---\n\n");
				return { content: [{ type: "text", text: `Parallel: ${summary}\n\n${text}` }], details: { results } };
			}

			// Single mode
			const sid = `single-${Date.now()}`;
			trackAgent(sid, params.agent!, params.task!, timeout, params.reason);
			const startMs = Date.now();

			try {
				const r = await runAgent(ctx.cwd, agents, params.agent!, params.task!, signal, sid, timeout, params.reason);
				const isError = failed(r);

				pi.sendMessage({
					customType: "subagent-complete",
					content: `${params.agent} ${r.stuck ? "timeout" : isError ? "failed" : "done"}`,
					display: true,
					details: {
						agent: params.agent!, task: params.task!, reason: params.reason, ok: !isError,
						model: r.model, durationMs: Date.now() - startMs,
						preview: outputPreview(output(r)),
					} satisfies SubagentCompleteDetails,
				});

				persistResult(pi, r, Date.now() - startMs, sid);

				if (isError) {
					const reason = r.stuck ? "timeout: provider stopped responding" : `${r.stopReason || "failed"}: ${capOutput(output(r))}`;
					return { content: [{ type: "text", text: reason }], details: { results: [r] }, isError: true };
				}
				return { content: [{ type: "text", text: capOutput(finalOutput(r.messages) || "(no output)") }], details: { results: [r] } };
			} catch (e) {
				pi.sendMessage({
					customType: "subagent-complete",
					content: `${params.agent} crashed`,
					display: true,
					details: {
						agent: params.agent!, task: params.task!, reason: params.reason, ok: false,
						durationMs: Date.now() - startMs,
						preview: e instanceof Error ? e.message : String(e),
					} satisfies SubagentCompleteDetails,
				});
				pi.appendEntry("subagent-result", {
					id: sid,
					transcript: trimTranscriptForPersist(activeSubagents.get(sid)?.transcript),
					agent: params.agent!,
					task: params.task!,
					reason: params.reason,
					ok: false,
					durationMs: Date.now() - startMs,
					output: e instanceof Error ? e.message : String(e),
					timestamp: Date.now(),
				} satisfies SubagentResultEntry);
				throw e;
			}
		},

		renderCall(args, theme) {
			if (args.tasks?.length) return new Text(theme.fg("toolTitle", theme.bold("subagent ")) + theme.fg("accent", `parallel (${args.tasks.length})`), 0, 0);
			const preview = args.task ? (args.task.length > 60 ? args.task.slice(0, 60) + "..." : args.task) : "...";
			return new Text(theme.fg("toolTitle", theme.bold("subagent ")) + theme.fg("accent", args.agent || "...") + `\n  ${theme.fg("dim", preview)}`, 0, 0);
		},

		renderResult(result, { expanded }, theme) {
			const details = result.details as { results: RunResult[] } | undefined;
			if (!details?.results.length) {
				const t = result.content[0];
				return new Text(t?.type === "text" ? t.text : "(no output)", 0, 0);
			}
			const md = getMarkdownTheme();
			const c = new Container();
			for (const r of details.results) {
				const icon = r.stuck ? theme.fg("warning", "⚠") : failed(r) ? theme.fg("error", "✗") : theme.fg("success", "✓");
				const head = `${icon} ${theme.fg("toolTitle", theme.bold(r.agent))}${r.model ? theme.fg("dim", ` ${r.model}`) : ""}`;
				if (expanded) {
					c.addChild(new Text(head, 0, 0));
					if (r.stuck) c.addChild(new Text(theme.fg("warning", "Provider stopped responding (timeout)"), 0, 0));
					c.addChild(new Text(theme.fg("muted", "Task: ") + theme.fg("dim", r.task), 0, 0));
					const out = finalOutput(r.messages) || output(r);
					if (out) { c.addChild(new Spacer(1)); c.addChild(new Markdown(out.trim(), 0, 0, md)); }
					c.addChild(new Spacer(1));
				} else {
					// Compact: one row per agent, no preview (completion message has details)
					c.addChild(new Text(head, 0, 0));
				}
			}
			if (!expanded) c.addChild(new Text(theme.fg("muted", "(Ctrl+O to expand)"), 0, 0));
			return c;
		},
	});

	// --- /subagents command -------------------------------------------------------
	pi.registerCommand("subagents", {
		description: "Inspect subagent results for the current branch",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify("/subagents needs interactive mode", "error");
				return;
			}
			rebuildResults(ctx);
			inspectorOpen = true;
			if (extensionCtx) extensionCtx.ui.setWidget("picopi-subagents", undefined);
			// Continue into the inspector even when empty — it shows guidance
			// Combined live + history inspector. Selection is keyed by a stable `key`
			// (the subagent id) so an agent finishing mid-view doesn't shift the
			// cursor when it migrates from activeSubagents to the persisted history.
			interface InspectItem {
				key: string;
				agent: string;
				subLabel: string;
				reason?: string;
				running: boolean;
				ok: boolean;
				stuck: boolean;
				model?: string;
				durationMs: number;
				transcript?: TranscriptEntry[];
				output?: string;
				errorMessage?: string;
				streamingText?: string;
				isStreaming?: boolean;
			}
			const buildItems = (): InspectItem[] => {
				const live = [...activeSubagents.values()];
				const running = live
					.filter((s) => s.status === "running" || s.status === "stuck")
					.sort((a, b) => a.startTime - b.startTime);
				const completedActive = live
					.filter((s) => s.status === "done" || s.status === "failed")
					.sort((a, b) => (a.endTime ?? 0) - (b.endTime ?? 0));
				const activeIds = new Set(live.map((s) => s.id));
				const histCompleted = resultHistory.filter((r) => !r.id || !activeIds.has(r.id));
				const fromStatus = (s: SubagentStatus): InspectItem => ({
					key: s.id,
					agent: s.agent,
					subLabel: (s.status === "running" || s.status === "stuck") ? (s.progress || s.currentTool || s.task) : s.task,
					reason: s.reason,
					running: s.status === "running" || s.status === "stuck",
					ok: s.status === "done",
					stuck: s.status === "stuck",
					durationMs: (s.endTime ?? Date.now()) - s.startTime,
					transcript: s.transcript,
					streamingText: s.streamingText,
					isStreaming: s.isStreaming,
				});
				const fromHist = (r: SubagentResultEntry): InspectItem => ({
					key: r.id ?? `${r.timestamp}-${r.agent}`,
					agent: r.agent,
					subLabel: r.task,
					reason: r.reason,
					running: false,
					ok: r.ok,
					stuck: r.stuck ?? false,
					model: r.model,
					durationMs: r.durationMs,
					transcript: r.transcript,
					output: r.output,
					errorMessage: r.errorMessage,
				});
				return [...running.map(fromStatus), ...completedActive.map(fromStatus), ...histCompleted.map(fromHist)];
			};

			try {
				await ctx.ui.custom<void>((tui, theme, _kb, done) => {
				let selectedKey: string | null = null;
				let lastIndex = 0;
				let initialized = false;
				let expanded = false;
				let scrollOffset = 0;
				let atBottom = true;
				// Captured during render so the (width-less) handleInput can clamp scrolling.
				let lastMaxOffset = 0;
				let lastViewportH = 10;
				let verbosity = 1; // 0=minimal, 1=normal, 2=verbose

				const glyph = (it: InspectItem): string =>
					it.stuck ? theme.fg("warning", "⚠")
						: it.running ? theme.fg("warning", "◌")
							: it.ok ? theme.fg("success", "✓")
								: theme.fg("error", "✗");

				const transcriptLines = (it: InspectItem, innerW: number): string[] => {
					const lines: string[] = [];
					const truncate = (s: string, maxW: number) => truncateToWidth(s, Math.max(1, maxW), "…");
					const wrap = (s: string, indent: string) => {
						for (const w of wrapTextWithAnsi(s, Math.max(1, innerW - indent.length))) lines.push(indent + w);
					};
					if (it.transcript && it.transcript.length) {
						for (const e of it.transcript) {
							if (e.kind === "assistant") {
								if (verbosity >= 2) {
									wrap(theme.fg("text", e.text), "  ");
								} else if (verbosity === 1) {
									const previewLines = e.text.split("\n").filter(l => l.trim());
									const preview = previewLines.slice(0, 4).join("\n");
									wrap(theme.fg("dim", truncate(preview, innerW * 4)), "  ");
								}
								// verbosity 0: skip assistant text entirely
							} else if (e.kind === "tool-call") {
								const arg = primaryArg(e.toolName, e.args);
								const summary = arg ? `${e.toolName ?? e.text} ${arg}` : (e.toolName ?? e.text);
								lines.push(theme.fg("accent", `→ ${truncate(summary, innerW - 2)}`));
							} else if (e.kind === "tool-done") {
								const arg = primaryArg(e.toolName, e.args);
								const status = summarizeResult(e.toolName, e.result);
								const summary = arg ? `${e.toolName ?? e.text} ${arg} — ${status}` : `${e.toolName ?? e.text} — ${status}`;
								if (e.isError) {
									lines.push(theme.fg("error", `✗ ${truncate(summary, innerW - 2)}`));
									if (e.result != null) {
										const preview = typeof e.result === "string" ? e.result : JSON.stringify(e.result);
										for (const line of preview.split("\n").slice(0, 6)) {
											lines.push(theme.fg("error", `  ${truncate(line, innerW - 4)}`));
										}
									}
								} else {
									lines.push(theme.fg("success", `• ${truncate(summary, innerW - 2)}`));
								}
							}
						}
						if (lines.length === 0) {
							lines.push(theme.fg("dim", "  (assistant output hidden — press v)"));
						}
					} else if (it.output) {
						if (verbosity >= 1) wrap(theme.fg("text", it.output), "  ");
						else lines.push(theme.fg("dim", "  (output available, press v to show)"));
					} else {
						lines.push(theme.fg("dim", "  (no transcript recorded)"));
					}
					// Show streaming text for running agents
					if (it.streamingText && it.isStreaming) {
						lines.push("");
						lines.push(theme.fg("accent", "  streaming:"));
						const streamLines = it.streamingText.split("\n");
						const lastLines = streamLines.slice(-5);
						for (let i = 0; i < lastLines.length; i++) {
							const cursor = i === lastLines.length - 1 ? "▌" : "";
							lines.push(theme.fg("text", `  ${truncate(lastLines[i], innerW - 4)}${cursor}`));
						}
					}
					if (it.errorMessage) {
						lines.push("");
						wrap(theme.fg("error", `Error: ${it.errorMessage}`), "  ");
					}
					return lines;
				};

				// Self-refresh so running transcripts and elapsed times update live; a
				// completion that lands while open is picked up via rebuildResults within 1s.
				const interval = setInterval(() => { if (activeSubagents.size > 0) { rebuildResults(ctx); tui.requestRender(); } }, 1000);

				return {
					render(width: number): string[] {
						const border = (s: string) => theme.fg("accent", s);
						const innerW = Math.max(0, width - 2);
						const hr = "─".repeat(innerW);
						const rows = tui.terminal?.rows ?? 24;
						const viewportH = Math.max(4, Math.floor(rows * 0.55));
						lastViewportH = viewportH;
						const row = (content: string): string => {
							const clipped = truncateToWidth(content, innerW);
							return border("│") + clipped + " ".repeat(Math.max(0, innerW - visibleWidth(clipped))) + border("│");
						};
						const out: string[] = [border("┌" + hr + "┐")];

						const items = buildItems();
						if (items.length === 0) {
							expanded = false;
							out.push(row(theme.fg("accent", " Subagent Inspector ")));
							out.push(border("├" + hr + "┤"));
							out.push(row(theme.fg("dim", "  No subagents yet")));
							out.push(row(theme.fg("dim", "  Delegated subagent runs will appear here")));
							out.push(row(theme.fg("dim", "  when you use the subagent tool.")));
							out.push(row(theme.fg("dim", "  Results are scoped to the current branch.")));
							for (let i = 0; i < viewportH; i++) out.push(row(""));
							out.push(border("└" + hr + "┘"));
							out.push(truncateToWidth(theme.fg("dim", "  q quit"), width));
							return out;
						}

						if (!initialized) {
							initialized = true;
							const firstRunning = items.findIndex((i) => i.running);
							const startIdx = firstRunning !== -1 ? firstRunning : items.length - 1;
							selectedKey = items[startIdx].key;
							lastIndex = startIdx;
						}
						let idx = items.findIndex((i) => i.key === selectedKey);
						if (idx === -1) idx = Math.min(Math.max(lastIndex, 0), items.length - 1);
						selectedKey = items[idx].key;
						lastIndex = idx;
						const cur = items[idx];

						if (expanded) {
							const model = cur.model ? theme.fg("dim", ` ${cur.model}`) : "";
							const status = cur.running ? theme.fg("warning", cur.stuck ? " · stuck" : " · running") : cur.ok ? theme.fg("dim", " · done") : theme.fg("error", " · failed");
							out.push(row(`${glyph(cur)} ${theme.fg("accent", cur.agent)}${model}${theme.fg("dim", ` ${formatDuration(cur.durationMs)}`)}${status}`));
							const detailRows = [
								...wrapTextWithAnsi(`  ${cur.subLabel}`, Math.max(1, innerW)).slice(0, 2),
								...(cur.reason ? wrapTextWithAnsi(`  Reason: ${cur.reason}`, Math.max(1, innerW)).slice(0, 2) : []),
							];
							for (const detail of detailRows.slice(0, 4)) out.push(row(theme.fg("dim", detail)));
							while (out.length < 6) out.push(row(""));
							out.push(border("├" + hr + "┤"));
							const lines = transcriptLines(cur, innerW);
							const maxOffset = Math.max(0, lines.length - viewportH);
							lastMaxOffset = maxOffset;
							if (atBottom) scrollOffset = maxOffset;
							scrollOffset = Math.min(Math.max(scrollOffset, 0), maxOffset);
							const slice = lines.slice(scrollOffset, scrollOffset + viewportH);
							for (const l of slice) out.push(row(l));
							for (let i = slice.length; i < viewportH; i++) out.push(row(""));
							for (let i = out.length; i < 7 + viewportH; i++) out.push(row(""));
							out.push(border("└" + hr + "┘"));
							const more: string[] = [];
							if (scrollOffset > 0) more.push("↑ more");
							if (scrollOffset < maxOffset) more.push("↓ more");
							const tail = more.length ? `   ${more.join("  ")}` : "";
							out.push(truncateToWidth(theme.fg("dim", `  ↑↓ scroll  Home/End  ←→ switch  Enter collapse  v ${verbosity === 0 ? 'minimal' : verbosity === 1 ? 'normal' : 'verbose'}  Esc back  q quit${tail}`), width));
							return out;
						}

						// Collapsed: two sections (running, completed), windowed to the viewport.
						out.push(row(theme.fg("accent", " Subagent Inspector ")));
						out.push(border("├" + hr + "┤"));
						const runningCount = items.filter((i) => i.running).length;
						const listRows: { line: string; itemIdx: number | null }[] = [];
						let runHdr = false;
						let doneHdr = false;
						for (let i = 0; i < items.length; i++) {
							const it = items[i];
							if (it.running && !runHdr) {
								listRows.push({ line: theme.fg("muted", ` Running (${runningCount})`), itemIdx: null });
								runHdr = true;
							}
							if (!it.running && !doneHdr) {
								if (runHdr) listRows.push({ line: "", itemIdx: null });
								listRows.push({ line: theme.fg("muted", ` Completed (${items.length - runningCount})`), itemIdx: null });
								doneHdr = true;
							}
							const sel = i === idx;
							const model = it.model ? theme.fg("dim", ` ${it.model}`) : "";
							const prefix = sel ? theme.fg("accent", "▸ ") : "  ";
							listRows.push({ line: `${prefix}${glyph(it)} ${theme.fg(sel ? "accent" : "muted", it.agent)}${model}${theme.fg("dim", ` ${formatDuration(it.durationMs)}`)}`, itemIdx: i });
							const subLabel = sel && it.reason ? `${it.subLabel} · reason: ${outputPreview(it.reason, 80)}` : it.subLabel;
							listRows.push({ line: theme.fg("dim", `    ${subLabel}`), itemIdx: i });
						}
						let winStart = 0;
						if (listRows.length > viewportH) {
							const selRow = listRows.findIndex((r) => r.itemIdx === idx);
							winStart = Math.max(0, Math.min(selRow - Math.floor(viewportH / 2), listRows.length - viewportH));
						}
						// Adjust to item block boundaries: don't start on a sub-row or end mid-pair
						while (winStart > 0 && listRows[winStart].itemIdx !== null && listRows[winStart - 1].itemIdx === listRows[winStart].itemIdx) {
							winStart--;
						}
						let winEnd = Math.min(winStart + viewportH, listRows.length);
						while (winEnd > winStart && winEnd < listRows.length && listRows[winEnd - 1].itemIdx !== null && listRows[winEnd].itemIdx === listRows[winEnd - 1].itemIdx) {
							winEnd--;
						}
						const visibleRows = listRows.slice(winStart, winEnd).slice(0, viewportH);
						for (const r of visibleRows) out.push(row(r.line));
						for (let i = visibleRows.length; i < viewportH; i++) out.push(row(""));
						for (let i = out.length; i < 7 + viewportH; i++) out.push(row(""));
						out.push(border("└" + hr + "┘"));
						const listMore: string[] = [];
						if (winStart > 0) listMore.push("↑ more");
						if (winEnd < listRows.length) listMore.push("↓ more");
						const listTail = listMore.length ? `   ${listMore.join("  ")}` : "";
						out.push(truncateToWidth(theme.fg("dim", `  ↑↓ select  ←→ switch  Enter open  v ${verbosity === 0 ? 'minimal' : verbosity === 1 ? 'normal' : 'verbose'}  q quit${listTail}`), width));
						return out;
					},
					invalidate() {},
					handleInput(data: string) {
						if (matchesKey(data, "ctrl+c")) { done(); return; }
						const items = buildItems();
						if (items.length === 0) {
							if (matchesKey(data, "q") || matchesKey(data, "Q")) done();
							return;
						}
						let idx = items.findIndex((i) => i.key === selectedKey);
						if (idx === -1) idx = Math.min(Math.max(lastIndex, 0), items.length - 1);
						const select = (n: number) => {
							idx = Math.min(Math.max(0, n), items.length - 1);
							selectedKey = items[idx].key;
							lastIndex = idx;
						};

						if (expanded) {
							if (matchesKey(data, "up")) { scrollOffset = Math.max(0, scrollOffset - 1); atBottom = scrollOffset >= lastMaxOffset; }
							else if (matchesKey(data, "down")) { scrollOffset = Math.min(lastMaxOffset, scrollOffset + 1); atBottom = scrollOffset >= lastMaxOffset; }
							else if (matchesKey(data, "pageUp")) { scrollOffset = Math.max(0, scrollOffset - lastViewportH); atBottom = scrollOffset >= lastMaxOffset; }
							else if (matchesKey(data, "pageDown")) { scrollOffset = Math.min(lastMaxOffset, scrollOffset + lastViewportH); atBottom = scrollOffset >= lastMaxOffset; }
							else if (matchesKey(data, "home")) { scrollOffset = 0; atBottom = false; }
							else if (matchesKey(data, "end")) { scrollOffset = lastMaxOffset; atBottom = true; }
							else if (matchesKey(data, "left")) { select(idx - 1); atBottom = true; }
							else if (matchesKey(data, "right")) { select(idx + 1); atBottom = true; }
							else if (matchesKey(data, "enter") || matchesKey(data, "space")) { expanded = false; }
							else if (matchesKey(data, "v")) { verbosity = (verbosity + 1) % 3; }
							else if (matchesKey(data, "escape")) {
								expanded = false;
							}
							else if (matchesKey(data, "q") || matchesKey(data, "Q")) done();
							tui.requestRender();
							return;
						}

						if (matchesKey(data, "up") || matchesKey(data, "left")) select(idx - 1);
						else if (matchesKey(data, "down") || matchesKey(data, "right")) select(idx + 1);
						else if (matchesKey(data, "pageUp")) select(idx - Math.max(1, Math.floor(lastViewportH / 2)));
						else if (matchesKey(data, "pageDown")) select(idx + Math.max(1, Math.floor(lastViewportH / 2)));
						else if (matchesKey(data, "home")) select(0);
						else if (matchesKey(data, "end")) select(items.length - 1);
						else if (matchesKey(data, "enter") || matchesKey(data, "space")) { const opening = items[idx]; expanded = true; atBottom = !!opening?.running; scrollOffset = 0; }
						else if (matchesKey(data, "v")) { verbosity = (verbosity + 1) % 3; }
						else if (matchesKey(data, "q") || matchesKey(data, "Q")) done();
						tui.requestRender();
					},
					dispose() { clearInterval(interval); },
				};
			});
			} finally {
				inspectorOpen = false;
				updateStatusPanel(ctx);
			}
		},
	});

	// alt+s toggle fold
	pi.registerShortcut("alt+s", {
		description: "Toggle subagents widget fold",
		handler: async (ctx) => {
			subagentsFolded = !subagentsFolded;
			updateStatusPanel(ctx);
		},
	});
}
