/**
 * picopi rtk-bash — overrides the built-in bash tool to route commands
 * through `rtk rewrite`, which rewrites supported commands (git status,
 * cargo test, …) into token-efficient `rtk <subcmd>` equivalents.
 *
 * Behavior:
 *  - rtk not installed        -> identical to built-in bash (zero overhead
 *                                after one cached `command -v rtk` check)
 *  - `rtk rewrite` exits 3    -> run the rewritten command it printed
 *  - `rtk rewrite` exits 1    -> run the original command unchanged
 *  - any error/timeout        -> run the original command unchanged
 *  - params.raw === true      -> bypass rtk entirely (exact byte output)
 *
 * Execution is delegated to the original createBashToolDefinition execute,
 * so timeouts, truncation, abort, and BashToolDetails (truncation /
 * fullOutputPath) behave exactly like the built-in. renderCall/renderResult
 * are omitted so the built-in TUI renderers are inherited.
 */

import {
	createBashToolDefinition,
	type BashToolDetails,
	type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { spawn } from "node:child_process";

const REWRITE_TIMEOUT_MS = 2_000;

const RtkBashParams = Type.Object({
	command: Type.String({ description: "The bash command to execute" }),
	timeout: Type.Optional(Type.Number({ description: "Timeout in seconds" })),
	raw: Type.Optional(
		Type.Boolean({
			description:
				"Bypass rtk rewriting and run the command verbatim. Use for binary output or when exact bytes matter.",
		}),
	),
});

/** Cached availability check — resolved once per session. */
let rtkAvailable: Promise<boolean> | undefined;

function checkRtkAvailable(): Promise<boolean> {
	rtkAvailable ??= new Promise<boolean>((resolve) => {
		const child = spawn("bash", ["-lc", "command -v rtk"], {
			stdio: ["ignore", "ignore", "ignore"],
		});
		const timer = setTimeout(() => {
			child.kill("SIGKILL");
			resolve(false);
		}, REWRITE_TIMEOUT_MS);
		child.on("error", () => {
			clearTimeout(timer);
			resolve(false);
		});
		child.on("close", (code) => {
			clearTimeout(timer);
			resolve(code === 0);
		});
	});
	return rtkAvailable;
}

/**
 * Ask rtk to rewrite a command. Returns the rewritten command when rtk
 * exits 3 with output; returns undefined in every other case (exit 1 =
 * unhandled, spawn error, timeout, empty output).
 */
function rtkRewrite(
	command: string,
	signal?: AbortSignal,
): Promise<string | undefined> {
	return new Promise((resolve) => {
		if (signal?.aborted) return resolve(undefined);
		const child = spawn("rtk", ["rewrite", command], {
			stdio: ["ignore", "pipe", "ignore"],
		});
		let out = "";
		let settled = false;
		const finish = (value: string | undefined) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
			resolve(value);
		};
		const onAbort = () => {
			child.kill("SIGKILL");
			finish(undefined);
		};
		const timer = setTimeout(onAbort, REWRITE_TIMEOUT_MS);
		signal?.addEventListener("abort", onAbort, { once: true });
		child.stdout.on("data", (d: Buffer) => {
			out += d.toString("utf8");
		});
		child.on("error", () => finish(undefined));
		child.on("close", (code) => {
			const rewritten = out.trim();
			finish(code === 3 && rewritten ? rewritten : undefined);
		});
	});
}

/**
 * Setup rtk-bash tool override. Call during extension initialization.
 */
export function setupRtkBash(pi: ExtensionAPI) {
	// Inner built-in definitions, cached per cwd. We delegate execution to
	// these so behavior (streaming, truncation, details) is byte-identical.
	const innerByCwd = new Map<
		string,
		ReturnType<typeof createBashToolDefinition>
	>();
	const inner = (cwd: string) => {
		let def = innerByCwd.get(cwd);
		if (!def) {
			def = createBashToolDefinition(cwd);
			innerByCwd.set(cwd, def);
		}
		return def;
	};

	// Build a template definition to harvest built-in metadata.
	const template = createBashToolDefinition(process.cwd());

	pi.registerTool<typeof RtkBashParams, BashToolDetails | undefined>({
		name: "bash", // same name -> overrides the built-in bash tool
		label: template.label,
		description:
			(template.description ?? "Execute a shell command") +
			"\nCommands may be transparently rewritten by rtk into token-efficient equivalents. " +
			"Set raw: true to bypass rewriting when exact/binary output is required.",
		parameters: RtkBashParams,
		promptSnippet: template.promptSnippet,
		promptGuidelines: [
			...(template.promptGuidelines ?? []),
			"If rtk output seems stripped, rerun with raw: true.",
		],
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			let command = params.command;
			if (!params.raw && (await checkRtkAvailable())) {
				const rewritten = await rtkRewrite(command, signal);
				if (rewritten) command = rewritten;
			}
			return inner(ctx.cwd).execute(
				toolCallId,
				{ command, timeout: params.timeout },
				signal,
				onUpdate,
				ctx,
			);
		},
		// renderCall/renderResult omitted -> built-in bash renderers inherited.
	});
}
