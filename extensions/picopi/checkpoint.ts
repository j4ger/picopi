/**
 * Turn-based checkpoints — like opencode.
 *
 * Saves workspace + conversation state BEFORE Pi processes each user message.
 * /undo restores both files AND conversation, putting your message back in the input box.
 *
 * Uses Pi's session tree API (ctx.sessionManager.getBranch + ctx.navigateTree)
 * for true conversation rollback, plus git shadow repos for file rollback.
 *
 * Checkpoint metadata (including session tree entry IDs) is persisted to disk
 * at ~/.pi/agent/checkpoints/.meta.json so conversation rollback survives Pi restarts.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, appendFileSync, writeFileSync, readFileSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";

const CP_DIR = join(homedir(), ".pi", "agent", "checkpoints");
const META_FILE = join(CP_DIR, ".meta.json");
const REDO_FILE = ".redo-stack";
const LAST_INPUT = ".last-input";
const EXCLUDE = ["node_modules", ".git", ".venv", "__pycache__", ".cache", "dist", "build", ".next", "*.log"];

/** Max individual checkpoints to keep. Older history is squashed into one commit. */
const MAX_HISTORY = 50;
/** How many recent checkpoints to preserve when compressing. */
const COMPRESS_KEEP = 25;

/** Project key computed once at module load — stable even if cwd changes mid-session. */
const PROJECT_KEY = createHash("sha256").update(process.cwd()).digest("hex").slice(0, 16);
const REPO_DIR = join(CP_DIR, PROJECT_KEY);

/** Per-repo metadata: each git commit hash maps to its checkpoint metadata. */
interface CommitMeta { ts: number; treeEntryId?: string; }
type RepoMeta = Record<string, CommitMeta>;
type AllMeta = Record<string, RepoMeta>;

export function registerCheckpoint(pi: ExtensionAPI) {
  if (!existsSync(CP_DIR)) mkdirSync(CP_DIR, { recursive: true });

  const allMeta = loadMeta();

  // Save checkpoint BEFORE Pi starts working on user input
  pi.on("turn_start", async (event: any, ctx: any) => {
    if (!existsSync(REPO_DIR)) { mkdirSync(REPO_DIR); initRepo(REPO_DIR); }

    const msg = event?.message || "";
    if (msg) writeFileSync(join(REPO_DIR, LAST_INPUT), msg);

    let treeEntryId: string | undefined;
    try {
      const branch = ctx?.sessionManager?.getBranch?.() || [];
      const lastEntry = branch[branch.length - 1];
      if (lastEntry?.id) treeEntryId = lastEntry.id;
    } catch { /* sessionManager may not be available */ }

    const hash = saveCp(REPO_DIR, `turn-${Date.now()}`, allMeta, treeEntryId);
    if (hash !== "no-changes") {
      if (!allMeta[PROJECT_KEY]) allMeta[PROJECT_KEY] = {};
      allMeta[PROJECT_KEY][hash] = { ts: Date.now(), treeEntryId };
    }
  });

  // Manual checkpoint
  pi.registerCommand("checkpoint", {
    description: "Save a named workspace snapshot",
    handler: async (args, ctx: any) => {
      if (!existsSync(REPO_DIR)) { mkdirSync(REPO_DIR); initRepo(REPO_DIR); }

      let treeEntryId: string | undefined;
      try {
        const branch = ctx?.sessionManager?.getBranch?.() || [];
        const lastEntry = branch[branch.length - 1];
        if (lastEntry?.id) treeEntryId = lastEntry.id;
      } catch { /* ignore */ }

      const hash = saveCp(REPO_DIR, args || `manual-${Date.now()}`, allMeta, treeEntryId);
      if (hash !== "no-changes") {
        if (!allMeta[PROJECT_KEY]) allMeta[PROJECT_KEY] = {};
        allMeta[PROJECT_KEY][hash] = { ts: Date.now(), treeEntryId };
      }
      ctx.ui.notify(`Checkpoint: ${hash.slice(0, 7)}`, "success");
    },
  });

  // Undo — restore files + conversation + put message back in input box
  pi.registerCommand("undo", {
    description: "Undo last turn — restore workspace, conversation, and retry message",
    handler: async (_args, ctx: any) => {
      if (!existsSync(REPO_DIR)) { ctx.ui.notify("No checkpoints yet", "warning"); return; }

      const msgFile = join(REPO_DIR, LAST_INPUT);
      const msg = existsSync(msgFile) ? readFileSync(msgFile, "utf-8") : "";

      const r = undoTurn(REPO_DIR, process.cwd());
      if (!r.ok) { ctx.ui.notify(r.err || "Nothing to undo", "warning"); return; }

      if (r.hash) {
        const entry = allMeta[PROJECT_KEY]?.[r.hash];
        if (entry?.treeEntryId && ctx?.navigateTree) {
          try {
            await ctx.navigateTree(entry.treeEntryId, { summarize: true });
          } catch {
            ctx.ui.notify("Files restored (conversation rollback failed)", "warning");
          }
        }
      }

      if (msg) setInput(ctx, msg);
      ctx.ui.notify(`Undone${msg ? " — message restored" : ""}`, "success");
    },
  });

  // Redo
  pi.registerCommand("redo", {
    description: "Redo last undone turn",
    handler: async (_args, ctx: any) => {
      if (!existsSync(REPO_DIR)) { ctx.ui.notify("No checkpoints yet", "warning"); return; }

      const r = redoTurn(REPO_DIR, process.cwd());
      if (!r.ok) { ctx.ui.notify(r.err || "Nothing to redo", "warning"); return; }

      ctx.ui.notify(`Redone to ${r.hash?.slice(0, 7)}`, "success");
    },
  });
}

// ─── Metadata persistence ───

function loadMeta(): AllMeta {
  if (!existsSync(META_FILE)) return {};
  try { return JSON.parse(readFileSync(META_FILE, "utf-8")); } catch { return {}; }
}

function persistMeta(allMeta: AllMeta) {
  try {
    const tmp = `${META_FILE}.tmp`;
    writeFileSync(tmp, JSON.stringify(allMeta, null, 2));
    renameSync(tmp, META_FILE);
  } catch { /* best-effort — don't crash on write failure */ }
}

// ─── Core ───

function initRepo(dir: string) {
  execSync("git init --quiet", { cwd: dir });
  execSync("git config user.email 'pi@localhost' && git config user.name 'Pi'", { cwd: dir });
  writeFileSync(join(dir, ".gitignore"), [...EXCLUDE, LAST_INPUT, REDO_FILE].join("\n") + "\n");
  execSync("git add .gitignore && git commit --quiet -m init", { cwd: dir });
}

/** Rsync workspace → shadow repo, git commit, compress if history grew too large. */
function saveCp(dir: string, label: string, allMeta: AllMeta, treeEntryId?: string): string {
  const cwd = process.cwd();
  const ex = EXCLUDE.map(e => `--exclude='${e}'`).join(" ");
  try { execSync(`rsync -a --delete ${ex} '${cwd}/' '${dir}/'`, { timeout: 30000 }); }
  catch { execSync(`cp -r '${cwd}'/* '${dir}/' 2>/dev/null || true`, { timeout: 30000 }); }
  execSync("git add -A", { cwd: dir });
  if (!execSync("git status --porcelain", { cwd: dir, encoding: "utf-8" }).trim()) return "no-changes";
  execSync(`git commit --quiet -m "${label}"`, { cwd: dir });

  const hash = execSync("git rev-parse --short HEAD", { cwd: dir, encoding: "utf-8"}).trim();

  // Store metadata keyed by commit hash
  if (!allMeta[PROJECT_KEY]) allMeta[PROJECT_KEY] = {};
  allMeta[PROJECT_KEY][hash] = { ts: Date.now(), treeEntryId };

  // Sliding window compression
  const count = parseInt(execSync("git rev-list --count HEAD", { cwd: dir, encoding: "utf-8" }).trim());
  if (count > MAX_HISTORY) {
    const keptHashes = new Set<string>();
    try {
      const kept = execSync(`git log --format=%h HEAD~${COMPRESS_KEEP - 1}..HEAD`, { cwd: dir, encoding: "utf-8" }).trim().split("\n").filter(Boolean);
      for (const h of kept) keptHashes.add(h);
    } catch { /* ignore */ }

    const squashPoint = execSync(`git rev-parse HEAD~${COMPRESS_KEEP}`, { cwd: dir, encoding: "utf-8" }).trim();
    execSync(`git reset --soft ${squashPoint}`, { cwd: dir });
    execSync(`git commit --amend -m "cp: compressed history"`, { cwd: dir });

    const repoMeta = allMeta[PROJECT_KEY];
    if (repoMeta) {
      for (const h of Object.keys(repoMeta)) {
        if (!keptHashes.has(h)) delete repoMeta[h];
      }
    }

    // Clear redo stack since old commit hashes are now dangling
    try { writeFileSync(join(dir, REDO_FILE), ""); } catch { /* ignore */ }
  }

  persistMeta(allMeta);
  return hash;
}

/** Undo: go back one commit, push current to redo stack, sync to workspace. */
function undoTurn(dir: string, project: string): { ok: boolean; hash?: string; err?: string } {
  const prev = execSync("git log --format=%h --skip=1 -n 1", { cwd: dir, encoding: "utf-8" }).trim();
  if (!prev) return { ok: false, err: "At initial state" };
  const cur = execSync("git rev-parse --short HEAD", { cwd: dir, encoding: "utf-8" }).trim();
  appendFileSync(join(dir, REDO_FILE), cur + "\n");
  execSync(`git checkout --quiet ${prev} -- .`, { cwd: dir });
  syncToProject(dir, project);
  return { ok: true, hash: prev };
}

/** Redo: pop from redo stack, checkout, sync to workspace. */
function redoTurn(dir: string, project: string): { ok: boolean; hash?: string; err?: string } {
  const redoPath = join(dir, REDO_FILE);
  if (!existsSync(redoPath)) return { ok: false, err: "Nothing to redo" };
  const stack = readFileSync(redoPath, "utf-8").trim().split("\n").filter(Boolean);
  if (!stack.length) return { ok: false, err: "Nothing to redo" };
  const h = stack.pop()!;
  writeFileSync(redoPath, stack.join("\n") + (stack.length ? "\n" : ""));
  execSync(`git checkout --quiet ${h} -- .`, { cwd: dir });
  syncToProject(dir, project);
  return { ok: true, hash: h };
}

/** Sync shadow repo → real project directory. */
function syncToProject(dir: string, project: string) {
  const ex = EXCLUDE.map(e => `--exclude='${e}'`).join(" ");
  try { execSync(`rsync -a --delete ${ex} '${dir}/' '${project}/'`, { timeout: 30000 }); }
  catch { execSync(`cp -r '${dir}'/* '${project}/' 2>/dev/null || true`, { timeout: 30000 }); }
}

/** Best-effort: put text in Pi's input box. Tries multiple API shapes. */
function setInput(ctx: ExtensionContext, text: string) {
  const ui = (ctx as any).ui;
  ui?.setInput?.(text);
  ui?.setInputText?.(text);
  ui?.prompt?.(text);
}
