/**
 * Todo tool — per-project task tracking
 *
 * Each project directory gets its own todo list, keyed by SHA256(cwd at load time).
 * Todos live in ~/.pi/agent/todos/<hash>.json
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";

const TODO_DIR = join(homedir(), ".pi", "agent", "todos");
const PROJECT_KEY = createHash("sha256").update(process.cwd()).digest("hex").slice(0, 16);
const TODO_FILE = join(TODO_DIR, `${PROJECT_KEY}.json`);

interface Todo { id: string; description: string; priority: "high" | "medium" | "low"; status: "pending" | "in-progress" | "done"; created: string; }

const schema = Type.Object({
  action: Type.String({ description: "add, list, done, progress, remove, clear" }),
  description: Type.Optional(Type.String()),
  priority: Type.Optional(Type.String({ default: "medium" })),
  index: Type.Optional(Type.Number()),
});

function loadTodos(): Todo[] {
  if (!existsSync(TODO_FILE)) return [];
  try { return JSON.parse(readFileSync(TODO_FILE, "utf-8")); } catch { return []; }
}

function saveTodos(todos: Todo[]) {
  if (!existsSync(TODO_DIR)) mkdirSync(TODO_DIR, { recursive: true });
  // Atomic write: temp file → rename (avoids corrupting on crash)
  const tmp = `${TODO_FILE}.tmp`;
  writeFileSync(tmp, JSON.stringify(todos, null, 2));
  renameSync(tmp, TODO_FILE);
}

export function registerTodoTool(pi: ExtensionAPI) {
  pi.registerTool({
    name: "todo",
    label: "Todo",
    description: "Manage a per-project todo list. Actions: add, list, done, progress, remove, clear.",
    parameters: schema,
    async execute(_id, params) { return handle(params); },
  });

  pi.registerCommand("todos", {
    description: "Show project todo list",
    handler: async (_args, ctx) => { ctx.ui.notify(handle({ action: "list" }).content[0].text, "info"); },
  });
}

function handle(p: { action: string; description?: string; priority?: string; index?: number }) {
  const todos = loadTodos();

  switch (p.action) {
    case "add": {
      if (!p.description) return { content: [{ type: "text" as const, text: "[todo] Usage: add '<desc>' [priority]" }] };
      todos.push({ id: `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, description: p.description, priority: (p.priority as Todo["priority"]) || "medium", status: "pending", created: new Date().toISOString() });
      saveTodos(todos);
      return { content: [{ type: "text" as const, text: `[todo] Added: ${p.description}` }] };
    }
    case "done": case "progress": {
      const i = (p.index || 1) - 1;
      if (i < 0 || i >= todos.length) return { content: [{ type: "text" as const, text: "[todo] Invalid index." }] };
      todos[i].status = p.action as Todo["status"];
      saveTodos(todos);
      return { content: [{ type: "text" as const, text: `[todo] ${p.action}: ${todos[i].description}` }] };
    }
    case "remove": {
      const i = (p.index || 1) - 1;
      if (i < 0 || i >= todos.length) return { content: [{ type: "text" as const, text: "[todo] Invalid index." }] };
      const r = todos.splice(i, 1)[0];
      saveTodos(todos);
      return { content: [{ type: "text" as const, text: `[todo] Removed: ${r.description}` }] };
    }
    case "clear": {
      const c = todos.filter(t => t.status === "done").length;
      saveTodos(todos.filter(t => t.status !== "done"));
      return { content: [{ type: "text" as const, text: `[todo] Cleared ${c} items.` }] };
    }
    default: {
      if (!todos.length) return { content: [{ type: "text" as const, text: "[todo] No items." }] };
      const lines = ["=== Todo List ==="];
      todos.forEach((t, i) => { const icon = t.status === "done" ? "✓" : t.status === "in-progress" ? "►" : "○"; lines.push(`  ${icon} [${t.priority[0].toUpperCase()}] ${t.description}`); });
      lines.push(`\n  Pending: ${todos.filter(t => t.status !== "done").length} | Done: ${todos.filter(t => t.status === "done").length}`);
      return { content: [{ type: "text" as const, text: lines.join("\n") }] };
    }
  }
}
