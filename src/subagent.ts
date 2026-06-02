/**
 * picopi subagents — specialist agents with status panel overlay.
 *
 * Agents: planner, explorer, fixer, auditor, web-searcher (markdown files).
 * Models/thinking from central config.json `agents` map.
 * Spawns isolated `pi` processes (JSON mode, no session).
 *
 * Modes: single {agent, task}, parallel {tasks: [{agent, task}]}
 * Features: status panel overlay, watchdog timer for stuck detection.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Message } from "@earendil-works/pi-ai";
import { StringEnum } from "@earendil-works/pi-ai";
import { type ExtensionAPI, getAgentDir, getMarkdownTheme, parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Spacer, Text, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { getActivePreset, loadConfig, resolveChain, resolveModelChainForSpawn, resolveModelForSpawn } from "./config.ts";

// Constants

const MAX_PARALLEL = 6;
const MAX_CONCURRENCY = 3;
const PER_CHILD_OUTPUT_CAP = 50 * 1024;
const MAX_DEPTH = 2;
const DEPTH_ENV = "PICOPI_SUBAGENT_DEPTH";
const DEFAULT_TIMEOUT = 120; // seconds
const WATCHDOG_INTERVAL = 5000; // ms

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
	exitCode: number;
	messages: Message[];
	stderr: string;
	model?: string;
	stopReason?: string;
	errorMessage?: string;
	step?: number;
	stuck?: boolean;
}

interface SubagentStatus {
	id: string;
	agent: string;
	task: string;
	status: "running" | "done" | "failed" | "stuck";
	progress?: string;
	currentTool?: string;
	startTime: number;
	endTime?: number;
	lastActivity?: number;
	timeout?: number;
}

interface SubagentCompleteDetails {
	agent: string;
	task: string;
	ok: boolean;
	model?: string;
	durationMs: number;
	preview: string;
}

// Global state

const activeSubagents = new Map<string, SubagentStatus>();
let statusHandle: { hide(): void; setHidden(h: boolean): void } | null = null;
let extensionCtx: any = null;

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
	return r.exitCode !== 0 || r.stopReason === "error" || r.stopReason === "aborted" || r.stuck;
}

function output(r: RunResult): string {
	return r.stuck ? "Provider stopped responding (timeout)" :
		failed(r) ? r.errorMessage || r.stderr || finalOutput(r.messages) || "(no output)" :
		finalOutput(r.messages) || "(no output)";
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

const MAX_DISPLAY_SUBAGENTS = 4;
const MAX_RUNNING_IN_STATS = 3;

function updateStatusPanel(context?: any) {
	if (context) extensionCtx = context;
	if (!extensionCtx) return;

	if (activeSubagents.size === 0) {
		statusHandle?.hide();
		statusHandle = null;
		return;
	}

	if (!statusHandle) {
		try {
			statusHandle = extensionCtx.ui.custom(
				(tui: any, theme: any) => {
					const container = new Container();

					const render = () => {
						container.clear();
						container.addChild(new Text(theme.fg("accent", " Subagents "), 0, 0));

						const sorted = [...activeSubagents.values()].sort((a, b) =>
							a.status === b.status ? a.startTime - b.startTime :
							a.status === "running" ? -1 : b.status === "running" ? 1 :
							a.status === "stuck" ? -1 : 1
						);

						// When there are too many subagents to show individually,
						// switch to a compact statistics view to avoid truncation.
						if (sorted.length > MAX_DISPLAY_SUBAGENTS) {
							const counts = {
								running: sorted.filter(s => s.status === "running").length,
								done: sorted.filter(s => s.status === "done").length,
								stuck: sorted.filter(s => s.status === "stuck").length,
								failed: sorted.filter(s => s.status === "failed").length,
							};
							const totalMs = sorted.reduce((sum, s) => sum + ((s.endTime ?? Date.now()) - s.startTime), 0);
							const avgMs = totalMs / sorted.length;

							container.addChild(new Text(
								theme.fg("text", ` ${sorted.length} total`) + theme.fg("dim", ` · ${formatDuration(avgMs)} avg`),
								1, 0
							));

							if (counts.running) container.addChild(new Text(theme.fg("warning", ` ${counts.running} running`), 1, 0));
							if (counts.done) container.addChild(new Text(theme.fg("success", ` ${counts.done} done`), 1, 0));
							if (counts.stuck) container.addChild(new Text(theme.fg("warning", ` ${counts.stuck} stuck`), 1, 0));
							if (counts.failed) container.addChild(new Text(theme.fg("error", ` ${counts.failed} failed`), 1, 0));

							// Still show the most relevant running agents
							const running = sorted.filter(s => s.status === "running");
							if (running.length) {
								container.addChild(new Spacer(1));
								for (const sub of running.slice(0, MAX_RUNNING_IN_STATS)) {
									const elapsed = formatDuration(Date.now() - sub.startTime);
									container.addChild(new Text(
										theme.fg("warning", ` ▸ ${truncateToWidth(sub.agent, 12, "")}`) + theme.fg("dim", ` ${elapsed}`),
										1, 0
									));
								}
								if (running.length > MAX_RUNNING_IN_STATS) {
									container.addChild(new Text(theme.fg("dim", ` +${running.length - MAX_RUNNING_IN_STATS} more`), 1, 0));
								}
							}
						} else {
							for (const sub of sorted) {
								const icon = sub.status === "running" ? "o" : sub.status === "done" ? "+" : sub.status === "stuck" ? "!" : "x";
								const color = sub.status === "running" ? "warning" : sub.status === "done" ? "success" : sub.status === "stuck" ? "warning" : "error";
								const elapsed = formatDuration((sub.endTime ?? Date.now()) - sub.startTime);

								container.addChild(new Text(
									theme.fg(color, ` ${icon} ${truncateToWidth(sub.agent, 12, "")}`) + theme.fg("dim", ` ${elapsed}`),
									1, 0
								));

								if (sub.status === "stuck") {
									container.addChild(new Text(theme.fg("warning", "    timeout"), 1, 0));
								} else if (sub.status === "running" && (sub.progress || sub.currentTool)) {
									container.addChild(new Text(theme.fg("dim", `    ${truncateToWidth(sub.progress || sub.currentTool!, 22, "...")}`), 1, 0));
								}
							}

							const running = [...activeSubagents.values()].filter(s => s.status === "running").length;
							const stuck = [...activeSubagents.values()].filter(s => s.status === "stuck").length;
							if (running || stuck) {
								container.addChild(new Spacer(1));
								const parts: string[] = [];
								if (running) parts.push(`${running} active`);
								if (stuck) parts.push(`${stuck} stuck`);
								container.addChild(new Text(theme.fg(stuck ? "warning" : "muted", parts.join(", ")), 1, 0));
							}
						}
					};

					render();
					const interval = setInterval(() => { render(); tui.requestRender(); }, 1000);
					return {
						render: (w: number) => {
							const border = (s: string) => theme.fg("accent", s);
							const innerW = Math.max(0, w - 2);
							const hr = "─".repeat(innerW);
							const out: string[] = [];
							out.push(border("┌" + hr + "┐"));
							for (const raw of container.render(innerW)) {
								const inner = truncateToWidth(raw, innerW);
								const pad = innerW - visibleWidth(inner);
								out.push(border("│") + inner + " ".repeat(Math.max(0, pad)) + border("│"));
							}
							out.push(border("└" + hr + "┘"));
							return out;
						},
						invalidate: () => container.invalidate(),
						handleInput: () => {},
						dispose: () => clearInterval(interval),
					};
				},
				{
					overlay: true,
					overlayOptions: { anchor: "right-center", width: 28, maxHeight: "90%", margin: { right: 1 }, nonCapturing: true },
					onHandle: (h: any) => { statusHandle = h; },
				}
			);
		} catch { /* overlay failed */ }
	}
}

const trackAgent = (id: string, agent: string, task: string, timeout?: number) => {
	const now = Date.now();
	const sub: SubagentStatus = { id, agent, task, status: "running", startTime: now, lastActivity: now, timeout };
	activeSubagents.set(id, sub);
	updateStatusPanel();
};

const trackProgress = (id: string, progress?: string, tool?: string) => {
	const sub = activeSubagents.get(id);
	if (!sub) return;
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
	setTimeout(() => { activeSubagents.delete(id); updateStatusPanel(); }, success ? 3000 : 5000);
};

const trackStuck = (id: string) => {
	const sub = activeSubagents.get(id);
	if (!sub) return;
	sub.status = "stuck";
	sub.endTime = Date.now();
	updateStatusPanel();
	setTimeout(() => { activeSubagents.delete(id); updateStatusPanel(); }, 8000);
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
): Promise<RunResult> {
	const agent = agents.find((a) => a.name === name);
	if (!agent) {
		trackComplete(statusId, false);
		return { agent: name, task, exitCode: 1, messages: [], stderr: `Unknown agent "${name}". Available: ${agents.map((a) => `"${a.name}"`).join(", ") || "none"}.` };
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

			const base: RunResult = { agent: name, task, exitCode: 0, messages: [], stderr: "" };
			let aborted = false;
			let stuck = false;
			let lastEventTime = Date.now();
			let watchdogId: NodeJS.Timeout | null = null;

			const code = await new Promise<number>((resolve) => {
				const inv = piInvocation(args);
				const childDepth = Number(process.env[DEPTH_ENV] ?? "0") + 1;
				const proc = spawn(inv.command, inv.args, {
					cwd: defaultCwd,
					shell: false,
					stdio: ["ignore", "pipe", "pipe"],
					env: { ...process.env, [DEPTH_ENV]: String(childDepth), PICOPI_ACTIVE_PRESET: getActivePreset() },
				});
				let buf = "";

				// Per-process watchdog — only mark as stuck on the first
				// attempt; retries show "retrying" via trackProgress above.
				watchdogId = setInterval(() => {
					if (Date.now() - lastEventTime > effectiveTimeout * 1000) {
						stuck = true;
						if (attempt === 0) trackStuck(statusId);
						proc.kill("SIGTERM");
						setTimeout(() => !proc.killed && proc.kill("SIGKILL"), 4000);
					}
				}, WATCHDOG_INTERVAL);

				const onLine = (line: string) => {
					if (!line.trim()) return;
					let ev: any;
					try { ev = JSON.parse(line); } catch { return; }

					// Any event means process is alive
					lastEventTime = Date.now();

					if (ev.type === "tool_execution_start") {
						trackProgress(statusId, undefined, ev.toolName);
					}

					if ((ev.type === "message_end" || ev.type === "tool_result_end") && ev.message) {
						const msg = ev.message as Message;
						base.messages.push(msg);
						if (msg.role === "assistant") {
							if (!base.model && msg.model) base.model = msg.model;
							if (msg.stopReason) base.stopReason = msg.stopReason;
							if (msg.errorMessage) base.errorMessage = msg.errorMessage;
						}
						const turns = base.messages.filter(m => m.role === "assistant").length;
						const label = attempt > 0
							? `${turns} turns (attempt ${attempt + 1}/${modelSpecs.length})`
							: `${turns} turns`;
						trackProgress(statusId, label);
					}
				};

				proc.stdout.on("data", (d) => {
					buf += d.toString();
					const lines = buf.split("\n");
					buf = lines.pop() || "";
					for (const l of lines) onLine(l);
				});
				proc.stderr.on("data", (d) => { base.stderr += d.toString(); });
				proc.on("close", (c) => {
					if (watchdogId) { clearInterval(watchdogId); watchdogId = null; }
					if (buf.trim()) onLine(buf);
					resolve(c ?? 0);
				});
				proc.on("error", () => {
					if (watchdogId) { clearInterval(watchdogId); watchdogId = null; }
					resolve(1);
				});

				if (signal) {
					const kill = () => { aborted = true; proc.kill("SIGTERM"); setTimeout(() => !proc.killed && proc.kill("SIGKILL"), 4000); };
					signal.aborted ? kill() : signal.addEventListener("abort", kill, { once: true });
				}
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
		return lastResult!;
	} catch (e) {
		trackComplete(statusId, false);
		throw e;
	} finally {
		try { if (promptDir) fs.rmSync(promptDir, { recursive: true, force: true }); } catch {}
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
});
const Params = Type.Object({
	agent: Type.Optional(Type.String({ description: "Agent name (single mode)" })),
	task: Type.Optional(Type.String({ description: "Task (single mode)" })),
	tasks: Type.Optional(Type.Array(TaskItem, { description: "Parallel: array of {agent, task}" })),
	timeout: Type.Optional(Type.Number({ description: `Watchdog timeout in seconds (default: ${DEFAULT_TIMEOUT})` })),
});

// Extension

export function setupSubagent(pi: ExtensionAPI) {
	pi.on("session_start", (_e, ctx) => { extensionCtx = ctx; });
	pi.on("session_shutdown", () => { activeSubagents.clear(); statusHandle?.hide(); statusHandle = null; });

	pi.registerMessageRenderer("subagent-complete", (message, _opts, theme) => {
		const d = message.details as SubagentCompleteDetails | undefined;
		if (!d) return new Text(String(message.content), 0, 0);
		const icon = d.ok ? theme.fg("success", "+") : theme.fg("error", "x");
		const agent = theme.bold(theme.fg("accent", d.agent));
		const dur = theme.fg("dim", formatDuration(d.durationMs));
		const model = d.model ? theme.fg("dim", ` ${d.model}`) : "";
		let text = `${icon} ${agent}${model} ${dur}`;
		if (d.preview) text += `\n${theme.fg("dim", d.preview)}`;
		return new Text(text, 1, 0);
	});

	pi.registerTool({
		name: "subagent",
		label: "Subagent",
		description: [
			"Delegate to a specialist subagent with an isolated context window.",
			"Agents: planner, explorer, fixer, auditor, web-searcher (see agents/ dir).",
			"Models/thinking from central config.json. Modes: single {agent,task}, parallel {tasks}.",
			"Includes watchdog timeout detection for stuck providers.",
		].join(" "),
		parameters: Params,
		promptSnippet: "Delegate scoped work to specialist subagents (planner/explorer/fixer/auditor/web-searcher)",
		promptGuidelines: [
			"Use the subagent tool to offload exploration, planning, fixing, auditing, or web research so the main context stays focused.",
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
					trackAgent(sid, t.agent, t.task, timeout);
					return sid;
				});

				let completed = 0;
				const startMs = Date.now();

				const results = await mapLimit(params.tasks!, MAX_CONCURRENCY, async (t, i) => {
					const result = await runAgent(ctx.cwd, agents, t.agent, t.task, signal, sids[i], timeout);
					completed++;

					onUpdate?.({
						content: [{ type: "text", text: `${completed}/${totalPanes} done - ${t.agent} ${failed(result) ? "failed" : "ok"}` }],
						details: { completed, total: totalPanes },
					});

					pi.sendMessage({
						customType: "subagent-complete",
						content: `${t.agent} ${failed(result) ? "failed" : "done"}`,
						display: true,
						details: {
							agent: t.agent, task: t.task, ok: !failed(result),
							model: result.model, durationMs: Date.now() - startMs,
							preview: outputPreview(output(result)),
						} satisfies SubagentCompleteDetails,
					}, { deliverAs: "steer" });

					return result;
				});

				const ok = results.filter((r) => !failed(r)).length;
				const stuckCount = results.filter(r => r.stuck).length;
				const elapsed = Date.now() - startMs;
				const summary = stuckCount > 0 ? `${ok} ok, ${stuckCount} timeout` : `${ok}/${results.length} ok`;

				pi.sendMessage({
					customType: "subagent-complete",
					content: `parallel ${summary}`,
					display: true,
					details: {
						agent: results.map((r) => r.agent).join(", "),
						task: `${results.length} parallel tasks`,
						ok: ok === results.length, durationMs: elapsed,
						preview: ok === results.length ? `All ${results.length} tasks completed` : `${results.length - ok} failed`,
					} satisfies SubagentCompleteDetails,
				});

				const text = results.map((r) => `### [${r.agent}] ${r.stuck ? "timeout" : failed(r) ? "failed" : "ok"}\n\n${capOutput(output(r))}`).join("\n\n---\n\n");
				return { content: [{ type: "text", text: `Parallel: ${summary}\n\n${text}` }], details: { results } };
			}

			// Single mode
			const sid = `single-${Date.now()}`;
			trackAgent(sid, params.agent!, params.task!, timeout);
			const startMs = Date.now();

			try {
				const r = await runAgent(ctx.cwd, agents, params.agent!, params.task!, signal, sid, timeout);
				const isError = failed(r);

				pi.sendMessage({
					customType: "subagent-complete",
					content: `${params.agent} ${r.stuck ? "timeout" : isError ? "failed" : "done"}`,
					display: true,
					details: {
						agent: params.agent!, task: params.task!, ok: !isError,
						model: r.model, durationMs: Date.now() - startMs,
						preview: outputPreview(output(r)),
					} satisfies SubagentCompleteDetails,
				});

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
						agent: params.agent!, task: params.task!, ok: false,
						durationMs: Date.now() - startMs,
						preview: e instanceof Error ? e.message : String(e),
					} satisfies SubagentCompleteDetails,
				});
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
				const icon = r.stuck ? theme.fg("warning", "!") : failed(r) ? theme.fg("error", "x") : theme.fg("success", "+");
				const head = `${icon} ${theme.fg("toolTitle", theme.bold(r.agent))}${r.model ? theme.fg("dim", ` ${r.model}`) : ""}`;
				c.addChild(new Text(head, 0, 0));
				if (r.stuck) c.addChild(new Text(theme.fg("warning", "Provider stopped responding (timeout)"), 0, 0));
				if (expanded) {
					c.addChild(new Text(theme.fg("muted", "Task: ") + theme.fg("dim", r.task), 0, 0));
					const out = finalOutput(r.messages) || output(r);
					if (out) { c.addChild(new Spacer(1)); c.addChild(new Markdown(out.trim(), 0, 0, md)); }
				} else {
					const out = (finalOutput(r.messages) || output(r)).split("\n").slice(0, 4).join("\n");
					c.addChild(new Text(theme.fg("toolOutput", out), 0, 0));
				}
				c.addChild(new Spacer(1));
			}
			if (!expanded) c.addChild(new Text(theme.fg("muted", "(Ctrl+O to expand)"), 0, 0));
			return c;
		},
	});
}
