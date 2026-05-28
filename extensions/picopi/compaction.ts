/**
 * Custom compaction — use a cheaper/faster model for context summarization.
 *
 * Pi's native compaction uses the session's current model. If that's an expensive
 * slow model (e.g. DeepSeek Pro), compaction becomes costly. This hook intercepts
 * compaction and delegates summarization to a configurable cheap model.
 *
 * Config in config.json:
 *   "compaction": { "model": "sensenova/sense-lite-explore" }
 *
 * If no compaction.model is set, Pi handles compaction natively.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getConfig, resolveModel } from "./config";
import { spawn } from "node:child_process";

const SUMMARY_SYSTEM_PROMPT =
  `You are a context summarization assistant. Your task is to read a conversation ` +
  `between a user and an AI coding assistant, then produce a structured summary ` +
  `following the exact format specified.\n\n` +
  `Do NOT continue the conversation. Do NOT respond to any questions in the ` +
  `conversation. ONLY output the structured summary.`;

const SUMMARY_FORMAT = `\n\n` +
  `Format your summary with these sections:\n` +
  `## Goal\nWhat the user asked for.\n\n` +
  `## Constraints & Preferences\n` +
  `## Progress\n` +
  `### Done\n` +
  `### In Progress\n` +
  `### Blocked\n` +
  `## Key Decisions\n` +
  `## Next Steps\n` +
  `## Critical Context\nFiles, APIs, or dependencies that must not be forgotten.`;

export function registerCompactionHook(pi: ExtensionAPI) {
  pi.on("session_before_compact", async (event: any, _ctx: any) => {
    const cfg = getConfig();
    const compactionModel = (cfg as any).compaction?.model;
    if (!compactionModel) return; // Let Pi handle it natively

    const { preparation, signal } = event;

    // Serialize messages to text
    let conversationText: string;
    try {
      const { serializeConversation, convertToLlm } = await import("@earendil-works/pi-coding-agent");
      conversationText = serializeConversation(convertToLlm(preparation.messagesToSummarize));
    } catch {
      // Fallback: manual serialization if Pi's utils aren't available
      conversationText = manualSerialize(preparation.messagesToSummarize);
    }

    // Build prompt with previous summary if available
    let prompt = `<conversation>\n${conversationText}\n</conversation>\n\n${SUMMARY_FORMAT}`;
    if (preparation.previousSummary) {
      prompt = `<conversation>\n${conversationText}\n</conversation>\n\n` +
        `<previous-summary>\n${preparation.previousSummary}\n</previous-summary>\n\n` +
        `Update the previous summary with any new information from the conversation above.\n` +
        SUMMARY_FORMAT;
    }

    // Call the configured cheap model
    const summary = await summarizeWithModel(compactionModel, SUMMARY_SYSTEM_PROMPT, prompt, signal);
    if (!summary) return; // Fallback to native compaction on failure

    return {
      compaction: {
        summary,
        firstKeptEntryId: preparation.firstKeptEntryId,
        tokensBefore: preparation.tokensBefore,
        details: preparation.fileOps,
      },
    };
  });
}

function manualSerialize(messages: any[]): string {
  const parts: string[] = [];
  for (const msg of messages) {
    const role = msg.role || msg.type || "unknown";
    const content = msg.content || msg.text || "";
    if (role === "user") parts.push(`[User]: ${content}`);
    else if (role === "assistant") parts.push(`[Assistant]: ${content}`);
    else if (role === "toolResult") parts.push(`[Tool result]: ${String(content).slice(0, 2000)}`);
    else parts.push(`[${role}]: ${String(content).slice(0, 2000)}`);
  }
  return parts.join("\n\n");
}

async function summarizeWithModel(
  modelRef: string, systemPrompt: string, userPrompt: string, signal: AbortSignal
): Promise<string | null> {
  const resolver = resolveModel(modelRef);
  const fullPrompt = `${systemPrompt}\n\n${userPrompt}`;

  // Try each fallback chain entry: spawn pi with --model provider/modelId
  for (const entry of resolver.chain) {
    const { provider } = resolver.parse(entry);
    try {
      const result = await spawnSummary(entry, fullPrompt, signal);
      if (result) return result;
    } catch {
      // provider-level failure — try next fallback
      continue;
    }
  }

  return null;
}

/** Spawn a lightweight pi process for summarization — no tools, no thinking. */
function spawnSummary(modelRef: string, prompt: string, signal: AbortSignal): Promise<string | null> {
  return new Promise((resolve) => {
    const child = spawn("pi", [
      "--mode", "json", "-p", "--no-session",
      "--no-tools", "--no-skills",
      "--model", modelRef,
      "--thinking", "off",
    ], {
      env: { ...process.env, PI_OFFLINE: "1" },
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    child.stdin.write(prompt);
    child.stdin.end();
    child.stdout.on("data", d => { stdout += d.toString(); });

    const onAbort = () => { child.kill("SIGTERM"); resolve(null); };
    signal.addEventListener("abort", onAbort);

    child.on("close", code => {
      signal.removeEventListener("abort", onAbort);
      if (code !== 0) { resolve(null); return; }
      // Extract final assistant text from JSONL
      try {
        let text = "";
        for (const line of stdout.trim().split("\n")) {
          const ev = JSON.parse(line);
          if (ev.type === "message_end" && ev.message?.role === "assistant") {
            for (const part of ev.message.content || []) {
              if (part.type === "text") text += part.text;
            }
          }
        }
        resolve(text.trim() || null);
      } catch { resolve(null); }
    });
    child.on("error", () => { signal.removeEventListener("abort", onAbort); resolve(null); });
  });
}
