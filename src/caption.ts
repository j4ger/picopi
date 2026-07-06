/**
 * Auto-caption sessions using a lite/cheap model.
 *
 * Hooks into the first assistant response and generates a short session
 * title via a minimal pi subprocess with the configured lite model.
 * The title is set via pi.setSessionName(), which flows to terminal
 * title, session selector, and /name display — all existing UI.
 *
 * Config example (config.json):
 *   "lite": { "model": "cheap", "thinking": "off" }
 *
 * Falls back to the last (cheapest) model in the orchestrator chain
 * if no lite role is configured. Entirely silent on failure — the
 * session simply stays unnamed.
 */

import { spawn } from "node:child_process";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadConfig, resolveModelChainForSpawn } from "./config.ts";
import { piInvocation, sanitizeEnv } from "./subagent.ts";

// ── Module-level state (scoped to current session) ───────────────────────────

let firstUserText: string | null = null;
let captionSet = false;

// ── Helpers ──────────────────────────────────────────────────────────────────

function extractText(msg: any): string {
	if (typeof msg.content === "string") return msg.content;
	if (!Array.isArray(msg.content)) return "";
	return msg.content
		.filter((p: any) => p.type === "text")
		.map((p: any) => p.text)
		.join(" ")
		.trim();
}

// ── Caption generation ───────────────────────────────────────────────────────

async function generateCaption(ctx: any, userText: string, assistantText: string): Promise<string | null> {
	const cfg = loadConfig();
	const titleModel = cfg["title-maker"]?.model;

	// Resolve model chain for the lite role, or fall back to the
	// cheapest model in the orchestrator chain.
	let modelSpecs: string[] = [];
	if (titleModel) {
		modelSpecs = await resolveModelChainForSpawn(cfg, titleModel, ctx?.modelRegistry);
	}
	if (modelSpecs.length === 0 && cfg.orchestrator?.model) {
		const orchChain = await resolveModelChainForSpawn(cfg, cfg.orchestrator.model, ctx?.modelRegistry);
		if (orchChain.length > 0) {
			modelSpecs = [orchChain[orchChain.length - 1]]; // cheapest in chain
		}
	}
	if (modelSpecs.length === 0) return null;

	const model = modelSpecs[0];
	const titleRole = cfg["title-maker"];
	const timeoutMs = titleRole?.timeout ? titleRole.timeout * 1000 : 30_000;
	const thinking = titleRole?.thinking ?? "off";

	// One-line prompt — safe to pass as a single CLI argument.
	const userSnippet = userText.replace(/"/g, "'").slice(0, 250).trim();
	const assistantSnippet = assistantText.replace(/"/g, "'").slice(0, 250).trim();
	const prompt =
		`You are a concise session captioner. Generate a 5-10 word title for this coding task. ` +
		`User: ${userSnippet} Assistant: ${assistantSnippet}. Reply with ONLY the title. Title:`;

	try {
		const spawnArgs = ["--mode", "json", "-p", "--no-session", "--model", model, "--thinking", thinking, prompt];
		const inv = piInvocation(spawnArgs);
		const text = await new Promise<string>((resolve) => {
			const proc = spawn(inv.command, inv.args, {
				cwd: ctx.cwd,
				shell: false,
				stdio: ["ignore", "pipe", "pipe"],
				env: sanitizeEnv(),
			});
			let buf = "";
			let caption = "";

			// Bound the caption subprocess — if it hangs, don't leak it forever.
			const killTimer = setTimeout(() => {
				proc.kill("SIGTERM");
				setTimeout(() => proc.kill("SIGKILL"), 2000);
				resolve("");
			}, timeoutMs);

			proc.stdout.on("data", (d: Buffer) => {
				buf += d.toString();
				const lines = buf.split("\n");
				buf = lines.pop() || "";
				for (const line of lines) {
					try {
						const ev = JSON.parse(line);
						if (ev.type === "message_end" && ev.message?.role === "assistant") {
							const t =
								ev.message.content
									?.filter((p: any) => p.type === "text")
									.map((p: any) => p.text)
									.join("") || "";
							if (t) caption = t;
						}
					} catch {
						// skip non-JSON lines (progress, etc.)
					}
				}
			});

			proc.on("close", () => {
				clearTimeout(killTimer);
				// Flush remaining buffer
				if (buf.trim()) {
					try {
						const ev = JSON.parse(buf.trim());
						if (ev.type === "message_end" && ev.message?.role === "assistant") {
							const t =
								ev.message.content
									?.filter((p: any) => p.type === "text")
									.map((p: any) => p.text)
									.join("") || "";
							if (t) caption = t;
						}
					} catch {
						// skip
					}
				}
				resolve(caption);
			});

			proc.on("error", () => {
				clearTimeout(killTimer);
				resolve("");
			});
		});

		if (!text) return null;
		return text.replace(/^["'\s]+|["'\s]+$/g, "").trim().slice(0, 100);
	} catch {
		return null;
	}
}

// ── Extension entry point ────────────────────────────────────────────────────

export function setupCaption(pi: ExtensionAPI) {
	// Reset state on new session
	pi.on("session_start", () => {
		firstUserText = null;
		captionSet = false;
	});

	// Capture the first user message
	pi.on("message_start", (event) => {
		if (captionSet) return;
		const ev = event as any;
		if (ev.message?.role === "user" && !firstUserText) {
			firstUserText = extractText(ev.message).slice(0, 400);
		}
	});

	// On the first assistant response that has text, generate a caption
	pi.on("message_end", async (event, ctx) => {
		if (captionSet) return;
		const ev = event as any;
		if (ev.message?.role !== "assistant") return;
		if (!firstUserText) return;

		const assistantText = extractText(ev.message).slice(0, 400);
		if (!assistantText) {
			// Only tool calls in the response — the next assistant message
			// will likely have text, so keep waiting.
			return;
		}

		captionSet = true;

		// Fire-and-forget — don't block the agent loop since pi awaits
		// extension handlers. The session name pops in ~1-2s later.
		generateCaption(ctx, firstUserText, assistantText).then((caption) => {
			if (caption) {
				try {
					pi.setSessionName(caption);
				} catch {
					// Session may have been disposed — silently ignore.
				}
			}
		}).catch(() => {
			// Caption generation failed — session stays unnamed, no harm.
		});
	});
}