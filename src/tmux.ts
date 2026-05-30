/**
 * tmux pane visibility for subagents.
 *
 * Spawns a pane to the right (50% width) when a subagent runs,
 * tails a structured log file, and auto-closes when the subagent finishes.
 * When multiple subagents run in parallel, panes split vertically in the
 * right column with even distribution.
 *
 * Notifications use tmux display-message (status bar) — never send-keys,
 * which would inject keystrokes into pi's stdin and corrupt the editor.
 */

import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export type LogFn = (line: string) => void;

interface PaneState {
	id: string;
	logFile: string;
}

const panes = new Map<string, PaneState>();
let rightColumnPane: string | null = null;
let rightColumnPanes: string[] = [];

/** Check if we're inside a tmux session. */
export function isTmux(): boolean {
	return Boolean(process.env.TMUX);
}

/** Run a tmux command and return stdout. */
function tmux(...args: string[]): string {
	return execSync(`tmux ${args.join(" ")}`, { encoding: "utf-8" }).trim();
}

/** Get the current pane ID. */
function currentPane(): string {
	return tmux("display-message", "-p", "'#{pane_id}'");
}

/**
 * Show a brief message in tmux's status bar (no keystroke injection).
 * Falls back silently if tmux is unavailable.
 */
function notify(msg: string): void {
	try {
		tmux("display-message", "-d", "3000", msg);
	} catch {
		// Ignore — pane may be gone or tmux unavailable
	}
}

/**
 * Get the current tmux window height in rows.
 */
function getWindowHeight(): number {
	try {
		return parseInt(tmux("display-message", "-p", "'#{window_height}'"), 10);
	} catch {
		return 40; // fallback
	}
}

/**
 * Calculate the absolute row count for each pane to ensure even distribution.
 * Accounts for pane borders (1 row each, N-1 borders for N panes).
 */
function calculatePaneRows(totalPanes: number): number {
	const windowHeight = getWindowHeight();
	const borders = totalPanes - 1; // N-1 borders between N panes
	const usableHeight = windowHeight - borders;
	return Math.max(1, Math.floor(usableHeight / totalPanes));
}

/**
 * Create a tmux pane for a subagent and return a log function.
 * The pane appears to the right, with width split evenly among parallel panes.
 * @param key Unique identifier for this pane (e.g. "web-searcher:0").
 * @param task Short task description shown in the pane header.
 * @param totalPanes Total number of panes to create (for even vertical splitting).
 * @param paneIndex Index of this pane (0-based) for calculating split percentage.
 */
export function createPane(key: string, task: string, totalPanes: number = 1, paneIndex: number = 0): LogFn {
	if (!isTmux()) return () => {};

	// Clean up any existing pane with the same key
	const existing = panes.get(key);
	if (existing) {
		killPane(existing.id);
		panes.delete(key);
	}

	// Create temp log file
	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "picopi-tmux-"));
	const logFile = path.join(tmpDir, `${key}.log`);
	fs.writeFileSync(logFile, "", { mode: 0o600 });

	// Write header
	const header = `── ${key} ── ${task}\n`;
	fs.appendFileSync(logFile, header);

	// Enable mouse support (scrolling, pane selection, resizing)
	tmux("set", "-g", "mouse", "on");

	// First pane creates the right column (50% width).
	// Each subsequent pane splits from the FIRST pane in the right column.
	const parentId = currentPane();
	const isFirst = rightColumnPane === null;

	let splitArgs: string[];
	if (isFirst) {
		// First pane: horizontal split to create right column (50% width)
		splitArgs = ["-h", "-l", "50%", "-t", parentId];
	} else {
		// Use absolute row count for even distribution
		const rows = calculatePaneRows(totalPanes);
		// Always split from the FIRST pane in the right column
		splitArgs = ["-v", "-l", `${rows}`, "-t", rightColumnPane!];
	}

	const paneId = tmux(
		"split-window",
		...splitArgs,
		"-P", "-F", "'#{pane_id}'",
		`"tail -f '${logFile}'"`,
	);

	// Clean up the pane ID (remove quotes)
	const cleanId = paneId.replace(/'/g, "");

	if (isFirst) {
		rightColumnPane = cleanId;
		rightColumnPanes = [cleanId];
	} else {
		rightColumnPanes.push(cleanId);
	}

	panes.set(key, { id: cleanId, logFile });

	// Keep focus on the main pane
	tmux("select-pane", "-t", parentId);

	// Return log function
	return (line: string) => {
		try {
			fs.appendFileSync(logFile, `${line}\n`);
		} catch {
			// Ignore write errors (pane might be closed)
		}
	};
}

/**
 * Finalize a pane: close it immediately and flash a status bar notification.
 * Panes always close on completion — the tool result in the TUI carries the
 * full output, so the pane is just a live preview.
 */
export function finalizePane(name: string, isError: boolean = false): void {
	const state = panes.get(name);
	if (!state) return;

	notify(isError ? `✗ ${name} — failed` : `✓ ${name} — done`);
	cleanupPane(name);
}

/** Remove a pane and clean up its temp files. */
function cleanupPane(name: string): void {
	const state = panes.get(name);
	if (!state) return;
	killPane(state.id);
	panes.delete(name);
	// Remove from rightColumnPanes array
	const paneIdx = rightColumnPanes.indexOf(state.id);
	if (paneIdx !== -1) rightColumnPanes.splice(paneIdx, 1);
	// Update rightColumnPane reference
	if (rightColumnPane === state.id) {
		rightColumnPane = rightColumnPanes.length > 0 ? rightColumnPanes[0] : null;
	}
	// When panes are removed, remaining panes keep their sizes
	// (no automatic rebalancing to avoid layout jumps)
	try {
		fs.unlinkSync(state.logFile);
		fs.rmdirSync(path.dirname(state.logFile));
	} catch {
		// Ignore cleanup errors
	}
}

/** Kill a tmux pane by ID. */
function killPane(paneId: string): void {
	try {
		tmux("kill-pane", "-t", paneId);
	} catch {
		// Pane might already be closed
	}
}
