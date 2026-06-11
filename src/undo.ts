/**
 * opencode-style undo for picopi.
 *
 * At the start of every turn we snapshot the workspace (a git stash object,
 * which captures tracked + untracked changes without touching the index or
 * working tree). The snapshot ref is keyed to the current session entry id and
 * persisted as a custom session entry, so it branches correctly and survives
 * /reload.
 *
 * Undo restores BOTH halves of state:
 *   - conversation: pi forks the session before the chosen user message
 *   - workspace:    we `git checkout` the matching snapshot over the tree
 *
 * Double-ESC integration: set `"doubleEscapeAction": "fork"` in settings.json
 * (picopi ships this default). Double-ESC then opens the fork picker; choosing
 * a point fires `session_before_fork`, where we restore the workspace to the
 * snapshot captured for that entry. `/undo` is a one-keystroke shortcut that
 * forks straight to the previous user turn.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const CHECKPOINT_TYPE = "picopi-checkpoint";

interface Checkpoint {
	entryId: string;
	ref: string;
	createdAt: number;
}

export function setupUndo(pi: ExtensionAPI) {
	// entryId -> stash object sha. Rebuilt from session entries on load.
	const checkpoints = new Map<string, Checkpoint>();
	let gitAvailable: boolean | null = null;
	let currentEntryId: string | undefined;

	async function inGitRepo(): Promise<boolean> {
		// Cache only positive results: the cwd can change mid-session (cd into a
		// repo), so a `false` must stay re-checkable.
		if (gitAvailable === true) return true;
		const { code } = await pi.exec("git", ["rev-parse", "--is-inside-work-tree"]);
		gitAvailable = code === 0;
		return gitAvailable;
	}

	function gitFileList(stdout: string): string[] {
		return stdout.split("\n").map((s) => s.trim()).filter(Boolean);
	}

	function rebuild(ctx: ExtensionContext) {
		checkpoints.clear();
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type === "custom" && entry.customType === CHECKPOINT_TYPE) {
				const cp = entry.data as Checkpoint;
				if (cp?.entryId && cp?.ref) checkpoints.set(cp.entryId, cp);
			}
		}
	}

	async function snapshot(entryId: string) {
		if (!(await inGitRepo())) return;
		if (checkpoints.has(entryId)) return;
		// `git stash create` builds a commit object for the dirty state without
		// modifying the working tree or stash list. Empty tree -> empty stdout.
		const { stdout, code } = await pi.exec("git", ["stash", "create", "picopi checkpoint"]);
		const ref = stdout.trim();
		if (code !== 0) return;
		const head = (await pi.exec("git", ["rev-parse", "HEAD"])).stdout.trim();
		// If nothing is dirty, anchor to HEAD so undo still has a target.
		const cp: Checkpoint = { entryId, ref: ref || head, createdAt: Date.now() };
		checkpoints.set(entryId, cp);
		pi.appendEntry(CHECKPOINT_TYPE, cp);
	}

	async function restore(ref: string): Promise<boolean> {
		if (!(await inGitRepo())) return false;
		// Faithful restore of TRACKED files to the snapshot:
		//  1. overwrite tracked files (and re-create tracked files deleted since)
		//     with the snapshot's content;
		//  2. remove files that became tracked AFTER the snapshot, so the tree
		//     matches the checkpoint. Those are recoverable from a git ref
		//     (refs/picopi/undo-backup/*), so this is safe.
		// Untracked files are intentionally left untouched (never auto-deleted).
		//
		// Safety: stash current state first so the user can recover if needed.
		const backup = (await pi.exec("git", ["stash", "create", "picopi undo backup"])).stdout.trim();
		const snapFiles = new Set(gitFileList((await pi.exec("git", ["ls-tree", "-r", "--name-only", ref])).stdout));
		const { code } = await pi.exec("git", ["checkout", ref, "--", "."]);
		if (code !== 0) return false;
		const added = gitFileList((await pi.exec("git", ["ls-files"])).stdout).filter((f) => !snapFiles.has(f));
		if (added.length) await pi.exec("git", ["rm", "-f", "--", ...added]);
		if (backup) {
			await pi.exec("git", ["update-ref", `refs/picopi/undo-backup/${Date.now()}`, backup]);
			pi.appendEntry(CHECKPOINT_TYPE, { entryId: `backup-${Date.now()}`, ref: backup, createdAt: Date.now() });
		}
		return true;
	}

	pi.on("session_start", async (_e, ctx) => rebuild(ctx));
	pi.on("session_tree", async (_e, ctx) => rebuild(ctx));

	// At turn start the leaf is the user message just submitted; snapshot the
	// pre-edit workspace and key it to that entry. Undo forks "before" that entry
	// and restores this snapshot.
	pi.on("turn_start", async (_e, ctx) => {
		const leaf = ctx.sessionManager.getLeafId();
		currentEntryId = leaf ?? currentEntryId;
		if (currentEntryId) await snapshot(currentEntryId);
	});

	// Double-ESC (doubleEscapeAction: "fork") and /fork land here.
	pi.on("session_before_fork", async (event, ctx) => {
		if (!ctx.hasUI) return;
		const cp = checkpoints.get(event.entryId);
		if (!cp) return;
		const choice = await ctx.ui.select("picopi undo — restore tracked files too?", [
			"Yes — restore conversation + tracked files (untracked files kept)",
			"No — rewind conversation only",
		]);
		if (choice?.startsWith("Yes")) {
			const ok = await restore(cp.ref);
			ctx.ui.notify(ok ? "Tracked files restored to checkpoint" : "Workspace restore failed", ok ? "info" : "error");
		}
	});

	// /undo — fork to the previous user message; the fork handler then offers to
	// restore tracked files for that checkpoint.
	pi.registerCommand("undo", {
		description: "Rewind to the previous user turn (then choose whether to restore tracked files)",
		handler: async (_args, ctx) => {
			await ctx.waitForIdle();
			const branch = ctx.sessionManager.getBranch();
			const userEntries = branch.filter((e) => e.type === "message" && (e as any).message?.role === "user");
			// Target the second-to-last user message (rewind one full turn);
			// fall back to the last if only one exists.
			const target = userEntries.length >= 2 ? userEntries[userEntries.length - 2] : userEntries[userEntries.length - 1];
			if (!target) {
				ctx.ui.notify("Nothing to undo", "warning");
				return;
			}
			const result = await ctx.fork(target.id, { position: "before" });
			if (result.cancelled) return;
		},
	});

	// /checkpoints — quick visibility into available restore points.
	pi.registerCommand("checkpoints", {
		description: "List picopi workspace checkpoints on this branch",
		handler: async (_args, ctx) => {
			rebuild(ctx);
			if (checkpoints.size === 0) {
				ctx.ui.notify("No checkpoints yet (need a git repo + at least one turn)", "info");
				return;
			}
			const cps = Array.from(checkpoints.values())
				.sort((a, b) => a.createdAt - b.createdAt);
			const lines = cps.map((c, i) => `${i + 1}. ${new Date(c.createdAt).toLocaleTimeString()}  ${c.ref.slice(0, 10)}`);
			ctx.ui.notify(`${checkpoints.size} checkpoint(s): ${lines.join(" | ")}`, "info");
		},
	});
}
