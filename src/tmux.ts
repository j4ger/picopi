/**
 * tmux pane visibility for subagents.
 *
 * Spawns a pane to the right (30% width) when a subagent runs,
 * tails a structured log file, and auto-closes after completion.
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
 * Create a tmux pane for a subagent and return a log function.
 * The pane appears to the right, 30% width, tailing a log file.
 */
export function createPane(name: string, task: string): LogFn {
	if (!isTmux()) return () => {};

	// Clean up any existing pane with the same name
	const existing = panes.get(name);
	if (existing) {
		killPane(existing.id);
		panes.delete(name);
	}

	// Create temp log file
	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "picopi-tmux-"));
	const logFile = path.join(tmpDir, `${name}.log`);
	fs.writeFileSync(logFile, "", { mode: 0o600 });

	// Write header
	const header = `── ${name} ── ${task}\n`;
	fs.appendFileSync(logFile, header);

	// Create pane: split right, 30% width, tail the log file
	const parentId = currentPane();
	const paneId = tmux(
		"split-window",
		"-h", // horizontal split (right side)
		"-l", "30%", // 30% width
		"-t", parentId,
		"-P", "-F", "'#{pane_id}'", // print new pane ID
		`"tail -f '${logFile}'"`,
	);

	// Clean up the pane ID (remove quotes)
	const cleanId = paneId.replace(/'/g, "");

	panes.set(name, { id: cleanId, logFile });

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
 * Finalize a pane: write completion status and close it.
 * Shows a status message in the main pane.
 * Keeps pane open on error.
 */
export function finalizePane(name: string, isError: boolean = false): void {
	const state = panes.get(name);
	if (!state) return;

	if (isError) {
		// Keep pane open on error, show error status in main pane
		const parentId = currentPane();
		tmux("send-keys", "-t", parentId, `echo '\n✗ ${name} — failed'`, "Enter");
		return;
	}

	// Close the pane immediately
	killPane(state.id);
	panes.delete(name);

	// Clean up temp files
	try {
		fs.unlinkSync(state.logFile);
		fs.rmdirSync(path.dirname(state.logFile));
	} catch {
		// Ignore cleanup errors
	}

	// Show success status in main pane
	const parentId = currentPane();
	tmux("send-keys", "-t", parentId, `echo '\n✓ ${name} — done'`, "Enter");
}

/** Kill a tmux pane by ID. */
function killPane(paneId: string): void {
	try {
		tmux("kill-pane", "-t", paneId);
	} catch {
		// Pane might already be closed
	}
}
