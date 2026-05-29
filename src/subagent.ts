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
	const args = ["--mode", "json", "-p", "--no-session"];
	if (role) {
		const pattern = roleModelPattern(cfg, role.model);
		if (pattern) args.push("--model", pattern);
		if (role.thinking) args.push("--thinking", role.thinking);
	}
	if (agent.tools?.length) args.push("--tools", agent.tools.join(","));
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

export function setupSubagent(pi: ExtensionAPI) {
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
		async execute(_id, params, signal, _onUpdate, ctx) {
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

			const setupPane = (agentName: string, task: string) => {
				if (!useTmux) return () => {};
				const fn = createPane(agentName, task);
				logFns.set(agentName, fn);
				return fn;
			};

			const teardownPane = (agentName: string, isError: boolean) => {
				if (!useTmux) return;
				finalizePane(agentName, isError);
				logFns.delete(agentName);
			};

			if (hasTasks) {
				if (params.tasks!.length > MAX_PARALLEL)
					return { content: [{ type: "text", text: `Too many tasks (max ${MAX_PARALLEL})` }], details: { results: [] } };

				// Create panes for all parallel tasks
				const logFnsList = params.tasks!.map((t) => setupPane(t.agent, t.task));

				const results = await mapLimit(params.tasks!, MAX_CONCURRENCY, async (t, i) => {
					try {
						return await runAgent(ctx.cwd, agents, t.agent, t.task, undefined, signal, logFnsList[i]);
					} finally {
						teardownPane(t.agent, false); // will check failed after
					}
				});

				// Finalize panes with error status
				for (const r of results) {
					if (failed(r)) finalizePane(r.agent, true);
				}

				const ok = results.filter((r) => !failed(r)).length;
				const text = results.map((r) => `### [${r.agent}] ${failed(r) ? "failed" : "ok"}\n\n${capOutput(output(r))}`).join("\n\n---\n\n");
				return { content: [{ type: "text", text: `Parallel: ${ok}/${results.length} succeeded\n\n${text}` }], details: { results } };
			}

			// Single mode
			const logFn = setupPane(params.agent!, params.task!);
			try {
				const r = await runAgent(ctx.cwd, agents, params.agent!, params.task!, undefined, signal, logFn);
				const isError = failed(r);
				teardownPane(params.agent!, isError);
				if (isError) return { content: [{ type: "text", text: `Agent ${r.stopReason || "failed"}: ${capOutput(output(r))}` }], details: { results: [r] }, isError: true };
				return { content: [{ type: "text", text: capOutput(finalOutput(r.messages) || "(no output)") }], details: { results: [r] } };
			} catch (e) {
				teardownPane(params.agent!, true);
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
