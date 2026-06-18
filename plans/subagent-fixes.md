# Plan: subagent.ts duplicate-message, reason-enforcement, and AGENTS.md fixes

## Goal
Eliminate the duplicate "subagent done" system message in single mode, align the `reason` parameter's documented optionality with its runtime enforcement, and remove the "small model" phrasing from AGENTS.md.

---

## Issue 1 — Duplicate system message on subagent completion (single mode)

### Decision: Option (a) — remove the `pi.sendMessage` calls entirely

**Why (a) over (b)/(c):**
- `subagent-complete` is consumed ONLY by the `registerMessageRenderer` at `src/subagent.ts:873`. A repo-wide grep for `subagent-complete` finds exactly 3 hits: the renderer (873) and the two producers (984, 1003). Nothing else reads the message — not the status panel, not the `/subagents` overlay, not compaction logic.
- The status panel and overlay are driven by `trackAgent` / `trackComplete` / `persistResult` (which calls `pi.appendEntry("subagent-result", …)`). Parallel mode already proves this: it never calls `pi.sendMessage` (lines 935–966) yet the panel, overlay, and persistence all work.
- Option (b) `display: false` would keep a message in the transcript that nothing consumes — pure noise, and it would still pollute the orchestrator's context on compaction (a `display: true` session message is part of the conversation the model sees, which is the "duplicate system message" the issue names).
- Option (c) "keep and understand": the only purpose is redundant display; `renderResult` (lines 1035+) already renders the tool result inline with the same info (icon, agent, model, status; expandable to task + output). The standalone message adds a second, redundant top-level entry. No reason to keep it.

So: single mode should behave like parallel mode — show only the tool result.

### Required change — `src/subagent.ts`

**Success path (lines 983–994): delete the `pi.sendMessage({...})` block.**

Current:
```ts
			pi.sendMessage({
				customType: "subagent-complete",
				content: `${params.agent} ${r.stuck ? "timeout" : isError ? "failed" : "done"}`,
				display: true,
				details: {
					agent: params.agent!, task: params.task!, reason: params.reason, ok: !isError,
					model: r.model, durationMs: Date.now() - startMs,
					preview: outputPreview(output(r)),
				} satisfies SubagentCompleteDetails,
			});

			persistResult(pi, r, Date.now() - startMs, sid);
```
After: keep only `persistResult(pi, r, Date.now() - startMs, sid);` and everything below it. The `isError` local is still used by the subsequent `if (isError)` block, so leave `const isError = failed(r);` (line 981) untouched.

**Catch path (lines 1003–1012): delete the `pi.sendMessage({...})` block.**

Current:
```ts
		} catch (e) {
			pi.sendMessage({
				customType: "subagent-complete",
				content: `${params.agent} crashed`,
				display: true,
				details: {
					agent: params.agent!, task: params.task!, reason: params.reason, ok: false,
					durationMs: Date.now() - startMs,
					preview: e instanceof Error ? e.message : String(e),
				} satisfies SubagentCompleteDetails,
			});
			trackComplete(sid, false);
```
After: keep `trackComplete(sid, false);`, the `pi.appendEntry("subagent-result", …)` block, and `throw e;`. Only the `pi.sendMessage({...});` call is removed.

### Optional cleanup (recommended, low-risk) — `src/subagent.ts`

After removing both producers, these become dead code:
- `registerMessageRenderer("subagent-complete", …)` block — lines 873–889.
- `interface SubagentCompleteDetails { … }` — lines 123–131 (fields: agent, task, reason?, ok, model?, durationMs, preview). Its only 3 references were the renderer cast (874) and the two `satisfies` clauses (991, 1010), all removed above.

Removing them avoids implying a feature that no longer fires. Leaving them is harmless (a registered renderer for an unsent message type is a no-op), so this is strictly optional. If the project prefers minimal diffs, skip this cleanup.

### Verification
- `bun run build` (or the repo's typecheck/build command) — confirms no dangling `SubagentCompleteDetails` references if cleanup is done.
- Manual: run a single-mode `subagent` call (e.g. `explorer` with a small task). Expect exactly ONE completion entry (the tool result block) in the session — no separate "✓ explorer …" system message above it. Confirm the status panel and `/subagents` overlay still show the run and its result (they read from `trackAgent`/`persistResult`, not the removed message).
- Manual: run a parallel `subagent` call — unchanged behavior (already had no separate message).

---

## Issue 2 — `reason` parameter enforcement misalignment

Runtime (`src/subagent.ts:971-972`) throws unless `reason` is present **in single mode**. In parallel mode `reason` is genuinely optional, so the schema-level `Type.Optional` wrapper stays — only the human-facing descriptions change to "Required for single-mode calls."

### Change 1 — `src/subagent.ts:831` (tool schema description)
Current:
```ts
	reason: Type.Optional(Type.String({ description: "UI-only metadata for the status panel; the subagent cannot see it" })),
```
After (keep `Type.Optional`, append to description):
```ts
	reason: Type.Optional(Type.String({ description: "UI-only metadata for the status panel; the subagent cannot see it. Required for single-mode calls." })),
```

### Change 2 — `src/subagent.ts:903` (promptGuidelines)
Current:
```ts
			"Optional `reason` is UI-only metadata; the subagent cannot see it.",
```
After:
```ts
			"Required for single-mode calls. `reason` is UI-only metadata; the subagent cannot see it.",
```

### Change 3 — `agent/AGENTS.md:64` (Subagent call protocol section)
Current:
```
Optional `reason` is UI-only metadata for the orchestrator's audit trail. The subagent cannot see it.
```
After:
```
Required for single-mode calls. `reason` is UI-only metadata for the orchestrator's audit trail. The subagent cannot see it.
```

### Verification
- Typecheck/build still passes (`Type.Optional` unchanged).
- Grep the three spots for "Optional `reason`" / the old description to confirm none remain: `grep -rn "Optional \`reason\`" src/subagent.ts agent/AGENTS.md` should return nothing; `grep -n "Required for single-mode calls" src/subagent.ts agent/AGENTS.md` should return 3 hits (831, 903, 64).

---

## Issue 3 — Remove "small model" note from AGENTS.md

### Change — `agent/AGENTS.md:3`
Current:
```
You are the picopi orchestrator — a router, dispatcher, tracker, and verifier. You run on a small model. Do not do specialist work yourself.
```
After:
```
You are the picopi orchestrator — a router, dispatcher, tracker, and verifier. Do not do specialist work yourself.
```
Only the sentence `You run on a small model. ` is removed; the rest of the line is unchanged. (Confirmed: "small model" appears exactly once in the repo, at this line.)

### Verification
- `grep -rn "small model" agent/AGENTS.md` returns nothing.

---

## Files to touch
- `src/subagent.ts` — Issue 1 (remove 2 `pi.sendMessage` blocks: 983–994, 1003–1012; optional: remove renderer 873–889 and interface 123–131); Issue 2 (description at 831, guideline at 903).
- `agent/AGENTS.md` — Issue 2 (line 64); Issue 3 (line 3).

## Risks / ordering
- **Issue 1 ordering:** remove the two `sendMessage` calls first. The `SubagentCompleteDetails` interface and renderer are only safe to delete after both producers are gone (otherwise `satisfies`/cast references break the build). If doing the optional cleanup, do it last and re-typecheck.
- **`isError` still needed:** after deleting the success-path `sendMessage`, `const isError = failed(r);` (line 981) must remain — it's used by the `if (isError)` return at 996–998. Don't accidentally remove it.
- **No behavior change to parallel mode or status panel:** those paths don't touch `subagent-complete`; confirmed via grep + the fact that parallel mode never sends the message.
- **`reason` schema stays `Type.Optional`:** parallel mode legitimately omits `reason`, so making it schema-required would break parallel calls. Only the description/guidelines change.
- **AGENTS.md line numbers:** issue referenced "~line 28" for the `reason` line; actual location is line 64 (one occurrence). Line 3 is correct for "small model".
