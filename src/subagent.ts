/**
 * picopi subagents — oh-my-opencode-slim style.
 *
 * A minimal set of specialist agents (planner, explorer, fixer, auditor,
 * web-searcher) defined as markdown files in `agents/`. Each agent's MODEL and
 * THINKING level come from the central config.json `agents` map (feature #5),
 * resolved through the same alias -> fallback chain as the orchestrator. The
 * markdown frontmatter only carries the prompt, description, and tool list, so
 * model policy stays centralized.
 *
 * Each invocation spawns an isolated `pi` process (JSON mode, no session) so
 * subagent context never pollutes the main conversation.
 *
 * Modes:
 *   single   { agent, task }
 *   parallel { tasks: [{agent, task}] }
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Message } from "@earendil-works/pi-ai";
import { StringEnum } from "@earendil-works/pi-ai";
import { type ExtensionAPI, getAgentDir, getMarkdownTheme, parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { loadConfig, roleModelPattern } from "./config.ts";
import { type LogFn, createPane, finalizePane, isTmux } from "./tmux.ts";

const MAX_PARALLEL = 6;
const MAX_CONCURRENCY = 3;
const PER_CHILD_OUTPUT_CAP = 50 * 1024; // bytes of model-visible output per child
// Depth guard: subagents inherit PI_CODING_AGENT_DIR, so a child pi reloads
// picopi (including this tool). Cap nesting to avoid runaway spawning.
const MAX_DEPTH = 2;
const DEPTH_ENV = "PICOPI_SUBAGENT_DEPTH";

// Sane tool defaults per agent role. Omitted from agent markdown or config →
// falls back here. Order: config.json > agent markdown > built-in defaults.
const BUILT_IN_DEFAULTS: Record<string, string[]> = {
	planner: ["read", "grep", "find", "ls"],
	explorer: ["read", "grep", "find", "ls", "bash"],
	fixer: ["read", "write", "edit", "bash"],
	auditor: ["read", "grep", "find", "ls", "bash"],
	"web-searcher": ["web_search", "fetch_content", "read"],
};

interface AgentDef {
	name: string;
	description: string;
	tools?: string[];
	systemPrompt: string;
}

function discoverAgents(): AgentDef[] {
	const here = import.meta.dirname;
	const dirs = [
		path.join(getAgentDir(), "agents"),
		path.resolve(here, "..", "agents"), // installed agent dir
		path.resolve(here, "..", "agent", "agents"), // repo layout
	];
	const seen = new Map<string, AgentDef>();
	for (const dir of dirs) {
		let entries: fs.Dirent[];
		try {
			entries = fs.readdirSync(dir, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const e of entries) {
			if (!e.name.endsWith(".md")) continue;
			let content: string;
			try {
				content = fs.readFileSync(path.join(dir, e.name), "utf-8");
			} catch {
				continue;
			}
			const { frontmatter, body } = parseFrontmatter<Record<string, string>>(content);
			if (!frontmatter.name || !frontmatter.description) continue;
			if (seen.has(frontmatter.name)) continue; // agent-dir wins over bundled
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
}

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
	return r.exitCode !== 0 || r.stopReason === "error" || r.stopReason === "aborted";
}
function output(r: RunResult): string {
	return failed(r) ? r.errorMessage || r.stderr || finalOutput(r.messages) || "(no output)" : finalOutput(r.messages) || "(no output)";
}

function piInvocation(args: string[]): { command: string; args: string[] } {
	const script = process.argv[1];
	const isBunVirtual = script?.startsWith("/$bunfs/root/");
	if (script && !isBunVirtual && fs.existsSync(script)) return { command: process.execPath, args: [script, ...args] };
	const exe = path.basename(process.execPath).toLowerCase();
	if (!/^(node|bun)(\.exe)?$/.test(exe)) return { command: process.execPath, args };
	return { command: "pi", args };
}

/** Resolve tools: config.json > agent markdown > built-in defaults. */
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
	step: number | undefined,
	signal: AbortSignal | undefined,
	logFn?: LogFn,
): Promise<RunResult> {
	const agent = agents.find((a) => a.name === name);
	const base: RunResult = { agent: name, task, exitCode: 0, messages: [], stderr: "", step };
	if (!agent) {
		const avail = agents.map((a) => `"${a.name}"`).join(", ") || "none";
		return { ...base, exitCode: 1, stderr: `Unknown agent "${name}". Available: ${avail}.` };
	}

	const cfg = loadConfig();
	const role = cfg.agents?.[name];
	const tools = resolveTools(agent, role);
	const args = ["--mode", "json", "-p", "--no-session"];
	if (role) {
		const pattern = roleModelPattern(cfg, role.model);
		if (pattern) args.push("--model", pattern);
		if (role.thinking) args.push("--thinking", role.thinking);
	}
	args.push("--tools", tools.join(","));
	// Pass extension path so child pi loads picopi (registers web_search, fetch_content, etc.)
	args.push("--extension", import.meta.dirname);
	const timeoutMs = role?.timeout && role.timeout > 0 ? role.timeout * 1000 : undefined;

	let promptDir: string | null = null;
	let promptPath: string | null = null;
	try {
		if (agent.systemPrompt.trim()) {
			promptDir = fs.mkdtempSync(path.join(os.tmpdir(), "picopi-agent-"));
			promptPath = path.join(promptDir, `${name.replace(/[^\w.-]+/g, "_")}.md`);
			fs.writeFileSync(promptPath, agent.systemPrompt, { encoding: "utf-8", mode: 0o600 });
			args.push("--append-system-prompt", promptPath);
		}
		args.push(`Task: ${task}`);

		let aborted = false;
		let timedOut = false;
		const code = await new Promise<number>((resolve) => {
			const inv = piInvocation(args);
			const childDepth = Number(process.env[DEPTH_ENV] ?? "0") + 1;
			const proc = spawn(inv.command, inv.args, {
				cwd: defaultCwd,
				shell: false,
				stdio: ["ignore", "pipe", "pipe"],
				env: { ...process.env, [DEPTH_ENV]: String(childDepth) },
			});
			let buf = "";
			let timer: ReturnType<typeof setTimeout> | undefined;
			const killTree = () => {
				proc.kill("SIGTERM");
				setTimeout(() => !proc.killed && proc.kill("SIGKILL"), 4000);
			};
			if (timeoutMs) timer = setTimeout(() => {
				timedOut = true;
				killTree();
			}, timeoutMs);
			const onLine = (line: string) => {
				if (!line.trim()) return;
				let ev: any;
				try {
					ev = JSON.parse(line);
				} catch {
					return;
				}
				if ((ev.type === "message_end" || ev.type === "tool_result_end") && ev.message) {
					const msg = ev.message as Message;
					base.messages.push(msg);
					if (msg.role === "assistant") {
						if (!base.model && msg.model) base.model = msg.model;
						if (msg.stopReason) base.stopReason = msg.stopReason;
						if (msg.errorMessage) base.errorMessage = msg.errorMessage;
						// Log text output
						for (const p of msg.content) {
							if (p.type === "text" && p.text.trim()) logFn?.(p.text.trim());
						}
					}
					if (msg.role === "toolResult") {
						for (const p of msg.content) {
							if (p.type === "text" && p.text.trim()) logFn?.(`  → ${p.text.trim().split("\n")[0]}`);
						}
					}
				}
			};
			proc.stdout.on("data", (d) => {
				buf += d.toString();
				const lines = buf.split("\n");
				buf = lines.pop() || "";
				for (const l of lines) onLine(l);
			});
			proc.stderr.on("data", (d) => {
				base.stderr += d.toString();
			});
			proc.on("close", (c) => {
				if (timer) clearTimeout(timer);
				if (buf.trim()) onLine(buf);
				resolve(c ?? 0);
			});
			proc.on("error", () => {
				if (timer) clearTimeout(timer);
				resolve(1);
			});
			if (signal) {
				const kill = () => {
					aborted = true;
					killTree();
				};
				signal.aborted ? kill() : signal.addEventListener("abort", kill, { once: true });
			}
		});
		base.exitCode = code;
		if (timedOut) {
			base.stopReason = "error";
			if (!base.errorMessage) base.errorMessage = `Subagent timed out after ${(timeoutMs ?? 0) / 1000}s`;
		} else if (aborted) {
			base.stopReason = "aborted";
		}
		return base;
	} finally {
		try {
			if (promptDir) fs.rmSync(promptDir, { recursive: true, force: true });
		} catch {
			/* ignore */
		}
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

const TaskItem = Type.Object({
	agent: Type.String({ description: "Agent name" }),
	task: Type.String({ description: "Task for the agent" }),
});
const Params = Type.Object({
	agent: Type.Optional(Type.String({ description: "Agent name (single mode)" })),
	task: Type.Optional(Type.String({ description: "Task (single mode)" })),
	tasks: Type.Optional(Type.Array(TaskItem, { description: "Parallel: array of {agent, task}" })),
});

interface SubagentCompleteDetails {
	agent: string;
	task: string;
	ok: boolean;
	model?: string;
	durationMs: number;
	preview: string;
}

function formatDuration(ms: number): string {
	if (ms < 1000) return `${ms}ms`;
	if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
	const m = Math.floor(ms / 60_000);
	const s = Math.round((ms % 60_000) / 1000);
	return `${m}m${s}s`;
}

function outputPreview(text: string, maxLen = 120): string {
	const first = text.split("\n")[0].trim();
	return first.length > maxLen ? first.slice(0, maxLen) + "…" : first;
}

export function setupSubagent(pi: ExtensionAPI) {
	// Register message renderer for subagent completion notifications
	pi.registerMessageRenderer("subagent-complete", (message, _opts, theme) => {
		const d = message.details as SubagentCompleteDetails | undefined;
		if (!d) return new Text(String(message.content), 0, 0);

		const icon = d.ok ? theme.fg("success", "✓") : theme.fg("error", "✗");
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
			"Models/thinking come from central config.json. Modes: single {agent,task}, parallel {tasks}.",
		].join(" "),
		parameters: Params,
		promptSnippet: "Delegate scoped work to specialist subagents (planner/explorer/fixer/auditor/web-searcher)",
		promptGuidelines: [
			"Use the subagent tool to offload exploration, planning, fixing, auditing, or web research so the main context stays focused.",
		],
		async execute(_id, params, signal, onUpdate, ctx) {
			const depth = Number(process.env[DEPTH_ENV] ?? "0");
			if (depth >= MAX_DEPTH) {
				return {
					content: [{ type: "text", text: `Subagent nesting limit reached (depth ${depth}); refusing to spawn more.` }],
					details: { results: [] },
					isError: true,
				};
			}
			const agents = discoverAgents();
			const hasSingle = Boolean(params.agent && params.task);
			const hasTasks = (params.tasks?.length ?? 0) > 0;
			if (Number(hasSingle) + Number(hasTasks) !== 1) {
				const avail = agents.map((a) => `${a.name}: ${a.description}`).join("\n");
				return { content: [{ type: "text", text: `Provide exactly one mode.\nAvailable agents:\n${avail}` }], details: { results: [] } };
			}

			// tmux: create pane(s) for visibility
			const useTmux = isTmux();
			const logFns = new Map<string, LogFn>();

			const setupPane = (key: string, agentName: string, task: string, totalPanes: number = 1) => {
				if (!useTmux) return () => {};
				const fn = createPane(key, task, totalPanes);
				logFns.set(key, fn);
				return fn;
			};

			const teardownPane = (key: string, isError: boolean) => {
				if (!useTmux) return;
				finalizePane(key, isError);
				logFns.delete(key);
			};

			if (hasTasks) {
				if (params.tasks!.length > MAX_PARALLEL)
					return { content: [{ type: "text", text: `Too many tasks (max ${MAX_PARALLEL})` }], details: { results: [] } };

				// Create panes for all parallel tasks with unique keys
				const totalPanes = params.tasks!.length;
				const logFnsList = params.tasks!.map((t, i) => setupPane(`${t.agent}:${i}`, t.agent, t.task, totalPanes));
				const startMs = Date.now();
				let completed = 0;

				const results = await mapLimit(params.tasks!, MAX_CONCURRENCY, async (t, i) => {
					const result = await runAgent(ctx.cwd, agents, t.agent, t.task, undefined, signal, logFnsList[i]);
					// Finalize pane as soon as this agent completes
					finalizePane(`${t.agent}:${i}`, failed(result));

					completed++;
					const isError = failed(result);
					const preview = outputPreview(output(result));
					const durationMs = Date.now() - startMs;

					// Stream progress update to the tool call UI
					onUpdate?.({
						content: [{ type: "text", text: `${completed}/${totalPanes} done — ${t.agent} ${isError ? "failed" : "ok"}` }],
						details: { completed, total: totalPanes },
					});

					// Queue individual result as a steer (delivered after current turn)
					pi.sendMessage({
						customType: "subagent-complete",
						content: `${t.agent} ${isError ? "failed" : "done"}`,
						display: true,
						details: {
							agent: t.agent,
							task: t.task,
							ok: !isError,
							model: result.model,
							durationMs,
							preview,
						} satisfies SubagentCompleteDetails,
					}, { deliverAs: "steer" });

					return result;
				});

				const ok = results.filter((r) => !failed(r)).length;
				const elapsed = Date.now() - startMs;

				// Send final summary notification
				pi.sendMessage({
					customType: "subagent-complete",
					content: `parallel ${ok}/${results.length} done`,
					display: true,
					details: {
						agent: results.map((r) => r.agent).join(", "),
						task: `${results.length} parallel tasks`,
						ok: ok === results.length,
						durationMs: elapsed,
						preview: ok === results.length
							? `All ${results.length} tasks completed`
							: `${results.length - ok} task${results.length - ok > 1 ? "s" : ""} failed`,
					} satisfies SubagentCompleteDetails,
				});

				const text = results.map((r) => `### [${r.agent}] ${failed(r) ? "failed" : "ok"}\n\n${capOutput(output(r))}`).join("\n\n---\n\n");
				return { content: [{ type: "text", text: `Parallel: ${ok}/${results.length} succeeded\n\n${text}` }], details: { results } };
			}

			// Single mode
			const logFn = setupPane(params.agent!, params.agent!, params.task!);
			const startMs = Date.now();
			try {
				const r = await runAgent(ctx.cwd, agents, params.agent!, params.task!, undefined, signal, logFn);
				const isError = failed(r);
				teardownPane(params.agent!, isError);

				// Send completion notification
				pi.sendMessage({
					customType: "subagent-complete",
					content: `${params.agent} ${isError ? "failed" : "done"}`,
					display: true,
					details: {
						agent: params.agent!,
						task: params.task!,
						ok: !isError,
						model: r.model,
						durationMs: Date.now() - startMs,
						preview: outputPreview(output(r)),
					} satisfies SubagentCompleteDetails,
				});

				if (isError) return { content: [{ type: "text", text: `Agent ${r.stopReason || "failed"}: ${capOutput(output(r))}` }], details: { results: [r] }, isError: true };
				return { content: [{ type: "text", text: capOutput(finalOutput(r.messages) || "(no output)") }], details: { results: [r] } };
			} catch (e) {
				teardownPane(params.agent!, true);

				pi.sendMessage({
					customType: "subagent-complete",
					content: `${params.agent} crashed`,
					display: true,
					details: {
						agent: params.agent!,
						task: params.task!,
						ok: false,
						durationMs: Date.now() - startMs,
						preview: e instanceof Error ? e.message : String(e),
					} satisfies SubagentCompleteDetails,
				});

				throw e;
			}
		},
		renderCall(args, theme) {
			if (args.tasks?.length) return new Text(theme.fg("toolTitle", theme.bold("subagent ")) + theme.fg("accent", `parallel (${args.tasks.length})`), 0, 0);
			const preview = args.task ? (args.task.length > 60 ? args.task.slice(0, 60) + "…" : args.task) : "…";
			return new Text(theme.fg("toolTitle", theme.bold("subagent ")) + theme.fg("accent", args.agent || "…") + `\n  ${theme.fg("dim", preview)}`, 0, 0);
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
				const icon = failed(r) ? theme.fg("error", "✗") : theme.fg("success", "✓");
				const head = `${icon} ${theme.fg("toolTitle", theme.bold(r.agent))}${r.model ? theme.fg("dim", ` ${r.model}`) : ""}`;
				c.addChild(new Text(head, 0, 0));
				if (expanded) {
					c.addChild(new Text(theme.fg("muted", "Task: ") + theme.fg("dim", r.task), 0, 0));
					const out = finalOutput(r.messages) || output(r);
					if (out) {
						c.addChild(new Spacer(1));
						c.addChild(new Markdown(out.trim(), 0, 0, md));
					}
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
