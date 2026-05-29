/**
 * Simple, branch-aware todo list for picopi.
 *
 * State lives in tool-result details (not a side file), so it branches and
 * survives /reload correctly. The LLM drives it via the `todo` tool; the user
 * inspects it with `/todos` (an elegant inline panel) and it surfaces a compact
 * live widget above the editor whenever there are open items.
 */

import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, Text, truncateToWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";

interface Todo {
	id: number;
	text: string;
	done: boolean;
}
interface TodoDetails {
	action: "list" | "add" | "toggle" | "remove" | "clear";
	todos: Todo[];
	nextId: number;
	error?: string;
}

const TodoParams = Type.Object({
	action: StringEnum(["list", "add", "toggle", "remove", "clear"] as const),
	text: Type.Optional(Type.String({ description: "Todo text (for add)" })),
	id: Type.Optional(Type.Number({ description: "Todo id (for toggle/remove)" })),
});

class TodoPanel {
	constructor(
		private todos: Todo[],
		private theme: Theme,
		private onClose: () => void,
	) {}
	handleInput(data: string) {
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) this.onClose();
	}
	invalidate() {
		/* render is cheap; nothing to cache-bust */
	}
	render(width: number): string[] {
		const th = this.theme;
		const lines: string[] = [""];
		const title = th.fg("accent", " ✸ Todos ");
		lines.push(truncateToWidth(th.fg("borderMuted", "──") + title + th.fg("borderMuted", "─".repeat(Math.max(0, width - 12))), width));
		lines.push("");
		if (this.todos.length === 0) {
			lines.push(truncateToWidth(`  ${th.fg("dim", "No todos yet.")}`, width));
		} else {
			const done = this.todos.filter((t) => t.done).length;
			lines.push(truncateToWidth(`  ${th.fg("muted", `${done}/${this.todos.length} done`)}`, width));
			lines.push("");
			for (const t of this.todos) {
				const check = t.done ? th.fg("success", "✓") : th.fg("dim", "○");
				const text = t.done ? th.fg("dim", t.text) : th.fg("text", t.text);
				lines.push(truncateToWidth(`  ${check} ${th.fg("accent", `#${t.id}`)} ${text}`, width));
			}
		}
		lines.push("");
		lines.push(truncateToWidth(`  ${th.fg("dim", "Esc to close")}`, width));
		lines.push("");
		return lines;
	}
}

export function setupTodo(pi: ExtensionAPI) {
	let todos: Todo[] = [];
	let nextId = 1;

	const rebuild = (ctx: ExtensionContext) => {
		todos = [];
		nextId = 1;
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type !== "message") continue;
			const msg = (entry as any).message;
			if (msg?.role !== "toolResult" || msg.toolName !== "todo") continue;
			const d = msg.details as TodoDetails | undefined;
			// Validate shape: don't trust arbitrary historical tool-result details.
			if (d && Array.isArray(d.todos) && typeof d.nextId === "number") {
				todos = d.todos.filter((t) => t && typeof t.id === "number" && typeof t.text === "string");
				nextId = d.nextId;
			}
		}
		refreshWidget(ctx);
	};

	const refreshWidget = (ctx: ExtensionContext) => {
		const open = todos.filter((t) => !t.done);
		if (open.length === 0) {
			ctx.ui.setWidget("picopi-todo", []);
			return;
		}
		const th = ctx.ui.theme;
		const head = th.fg("accent", `✸ ${open.length} todo${open.length > 1 ? "s" : ""}`);
		const clip = (s: string) => (s.length > 60 ? s.slice(0, 57) + "…" : s);
		const preview = open.slice(0, 3).map((t) => "  " + th.fg("dim", "○ ") + th.fg("muted", clip(t.text)));
		if (open.length > 3) preview.push(th.fg("dim", `  … +${open.length - 3} more`));
		ctx.ui.setWidget("picopi-todo", [head, ...preview]);
	};

	pi.on("session_start", async (_e, ctx) => rebuild(ctx));
	pi.on("session_tree", async (_e, ctx) => rebuild(ctx));

	pi.registerTool({
		name: "todo",
		label: "Todo",
		description: "Manage the task list. actions: list | add(text) | toggle(id) | remove(id) | clear",
		promptSnippet: "Track multi-step work with the todo tool (add/toggle/remove/clear/list)",
		promptGuidelines: [
			"Use the todo tool to plan and track multi-step tasks; add items up front, toggle them done as you finish.",
		],
		parameters: TodoParams,
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const details = (action: TodoDetails["action"], error?: string): TodoDetails => ({
				action,
				todos: [...todos],
				nextId,
				error,
			});
			const result = (text: string, d: TodoDetails) => {
				refreshWidget(ctx);
				return { content: [{ type: "text" as const, text }], details: d };
			};

			switch (params.action) {
				case "list":
					return result(
						todos.length ? todos.map((t) => `[${t.done ? "x" : " "}] #${t.id} ${t.text}`).join("\n") : "No todos",
						details("list"),
					);
				case "add": {
					if (!params.text) return result("Error: text required", details("add", "text required"));
					const t: Todo = { id: nextId++, text: params.text, done: false };
					todos.push(t);
					return result(`Added #${t.id}: ${t.text}`, details("add"));
				}
				case "toggle": {
					if (params.id === undefined) return result("Error: id required", details("toggle", "id required"));
					const t = todos.find((x) => x.id === params.id);
					if (!t) return result(`#${params.id} not found`, details("toggle", "not found"));
					t.done = !t.done;
					return result(`#${t.id} ${t.done ? "done" : "reopened"}`, details("toggle"));
				}
				case "remove": {
					if (params.id === undefined) return result("Error: id required", details("remove", "id required"));
					const before = todos.length;
					todos = todos.filter((x) => x.id !== params.id);
					return result(before === todos.length ? `#${params.id} not found` : `Removed #${params.id}`, details("remove"));
				}
				case "clear": {
					const n = todos.length;
					todos = [];
					nextId = 1;
					return result(`Cleared ${n} todos`, details("clear"));
				}
			}
		},
		renderCall(args, theme) {
			let t = theme.fg("toolTitle", theme.bold("todo ")) + theme.fg("muted", args.action);
			if (args.text) t += ` ${theme.fg("dim", `"${args.text}"`)}`;
			if (args.id !== undefined) t += ` ${theme.fg("accent", `#${args.id}`)}`;
			return new Text(t, 0, 0);
		},
		renderResult(result, _opts, theme) {
			const d = result.details as TodoDetails | undefined;
			if (!d) return new Text("", 0, 0);
			if (d.error) return new Text(theme.fg("error", `Error: ${d.error}`), 0, 0);
			if (d.todos.length === 0) return new Text(theme.fg("dim", "No todos"), 0, 0);
			let t = theme.fg("muted", `${d.todos.filter((x) => x.done).length}/${d.todos.length} done`);
			for (const td of d.todos.slice(0, 8)) {
				const check = td.done ? theme.fg("success", "✓") : theme.fg("dim", "○");
				const text = td.done ? theme.fg("dim", td.text) : theme.fg("muted", td.text);
				t += `\n${check} ${theme.fg("accent", `#${td.id}`)} ${text}`;
			}
			if (d.todos.length > 8) t += `\n${theme.fg("dim", `… +${d.todos.length - 8} more`)}`;
			return new Text(t, 0, 0);
		},
	});

	pi.registerCommand("todos", {
		description: "Show the todo list for the current branch",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify("/todos needs interactive mode", "error");
				return;
			}
			await ctx.ui.custom<void>((_tui, theme, _kb, done) => new TodoPanel(todos, theme, () => done()));
		},
	});
}
