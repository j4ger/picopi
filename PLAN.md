# Plan: Fix color audit issues in src/subagent.ts

## Goal
Eliminate ~360 lines of duplicated inspector code, fix 3 inconsistent "done" colorings, remove 4 unused theme keys, and make the stuck "timeout" suffix distinguishable — all in `src/subagent.ts` and `agent/themes/picopi.json`.

## Verified findings

- The `/subagents` command handler (lines 1090–1454) and the `alt+i` shortcut handler (lines 1469–1821) are **byte-identical from `rebuildResults(ctx)` through the `finally` block**. The only difference is the `hasUI` guard message. The duplicated region includes the `InspectItem` interface, `buildItems()`, and the full `ctx.ui.custom<void>(…)` factory (render/handleInput/dispose). ~360 lines × 2.
- `ctx.ui.custom<T>` signature (from pi-coding-agent `types.d.ts:116`): `factory: (tui, theme, keybindings, done) => (Component & { dispose?() }) | Promise<…>`. The inner code uses `tui`, `theme`, `done` as closures and references module-level state/helpers only (`activeSubagents`, `resultHistory`, `rebuildResults`, `extensionCtx`, `updateStatusPanel`, `statusFg`, `tryFg`, `formatDuration`, `outputPreview`, `primaryArg`, `summarizeResult`, `resolveModelDisplayName`, `truncateToWidth`, `visibleWidth`, `wrapTextWithAnsi`, `matchesKey`, `STATUS_ICON`). No per-handler state — safe to lift into one module function.
- "done" gray-on-dim occurrences:
  - `src/subagent.ts:1070` — `renderResult` statusTag `: theme.fg("dim", " done")` (inside the tool registration, NOT the inspector; independent of refactor).
  - `src/subagent.ts:1317` — `/subagents` expanded header `: cur.ok ? theme.fg("dim", " · done")` (inside inspector).
  - `src/subagent.ts:1696` — `alt+i` expanded header, identical (inside inspector; deduped by refactor).
- Theme keys `statusRunning`/`statusDone`/`statusFailed`/`statusStuck` exist **only** at `agent/themes/picopi.json:80-83`. Grep across repo confirms zero code references. Only `subagentRunning/Done/Failed/Stuck` are used (via `STATUS_COLOR` in `subagent.ts:272`).
- Stuck suffix at `src/subagent.ts:367`: `… + statusFg(theme, "stuck", " timeout")` — same `subagentStuck` color as `agentPart` on the same line (line 365), so the suffix blends in.

## Plan

### Task 1 — Extract `runInspector(ctx)` (dedup)
One concern, ~2 files (really 1), ~20 min.

**Add** a module-level async function in `src/subagent.ts`, placed immediately before the `// --- /subagents command ---` comment (currently ~line 1083, after the tool `renderResult` closes). It owns everything the two handlers currently share:

```ts
/** Open the combined live+history subagent inspector overlay. */
async function runInspector(ctx: any): Promise<void> {
	rebuildResults(ctx);
	inspectorOpen = true;
	if (extensionCtx) extensionCtx.ui.setWidget("picopi-subagents", undefined);
	// Combined live + history inspector. Selection is keyed by a stable `key`
	// (the subagent id) so an agent finishing mid-view doesn't shift the
	// cursor when it migrates from activeSubagents to the persisted history.
	interface InspectItem {
		key: string;
		agent: string;
		subLabel: string;
		reason?: string;
		running: boolean;
		ok: boolean;
		stuck: boolean;
		model?: string;
		durationMs: number;
		transcript?: TranscriptEntry[];
		output?: string;
		errorMessage?: string;
		streamingText?: string;
		isStreaming?: boolean;
	}
	const buildItems = (): InspectItem[] => {
		// … exact body from current lines 1120–1158 …
	};
	try {
		await ctx.ui.custom<void>((tui, theme, _kb, done) => {
			// … exact body from current lines 1162–1449 …
		});
	} finally {
		inspectorOpen = false;
		updateStatusPanel(ctx);
	}
}
```

The body is a verbatim lift of the current `/subagents` handler body from line 1096 (`rebuildResults(ctx);`) through line 1454 (the `finally` close). No logic changes.

**Replace** the `/subagents` handler (lines 1091–1454) with:
```ts
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify("/subagents needs interactive mode", "error");
				return;
			}
			await runInspector(ctx);
		},
```

**Replace** the `alt+i` handler (lines 1471–1821) with:
```ts
		handler: async (ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify("alt+i needs interactive mode", "error");
				return;
			}
			await runInspector(ctx);
		},
```

**Why this is safe:** the two handler bodies were identical except for the guard string, which stays in each handler. `runInspector` closes over `ctx` (its param) and module-level symbols only. `function`-hoisting is irrelevant since it's declared before both registrations, but declaring it as `async function runInspector` is hoisted anyway. The `InspectItem`/`buildItems` locals move from handler scope to function scope — no behavioral change since nothing outside referenced them.

**Verification:** `bunx tsc --noEmit` (typecheck); then run pi, trigger a subagent run, open via `/subagents` and via `alt+i`, exercise ↑↓/Enter/v/r/q — both must behave identically to before. Check live (running) and completed (done/failed/stuck) items both render.

### Task 2 — Fix "done" coloring (3 sites → 2 after dedup)
~5 min. Two distinct code locations remain after Task 1:

- **`src/subagent.ts:1070`** (in tool `renderResult`, untouched by Task 1):
  ```diff
  -					: theme.fg("dim", " done");
  +					: statusFg(theme, "done", " done");
  ```
- **`src/subagent.ts:1317`** (now the single copy inside `runInspector`, was 1317 in `/subagents` and 1696 in `alt+i`; after Task 1 the file shrinks so this line number is approximate — locate by the `cur.ok ? theme.fg("dim", " · done")` text):
  ```diff
  -							: cur.ok ? theme.fg("dim", " · done")
  +							: cur.ok ? statusFg(theme, "done", " · done")
  ```
  This single edit fixes what was previously two spots (1317 and 1696), since Task 1 collapsed them.

**Verification:** run a successful subagent; in the expanded inspector header the `· done` label should now be green (`subagentDone`/`string`) matching the `✓` glyph, and in the tool result compact row `done` should be green matching `✓` — consistent with failed showing red and stuck showing amber.

### Task 3 — Make stuck "timeout" suffix distinguishable
~2 min. One edit.

- **`src/subagent.ts:367`** (unfolded status widget):
  ```diff
  -				lines.push(theme.fg("dim", "  ") + agentPart + statusFg(theme, "stuck", " timeout"));
  +				lines.push(theme.fg("dim", "  ") + agentPart + theme.fg("dim", " timeout"));
  ```
  `agentPart` (line 365) already uses `statusFg(theme, "stuck", …)` = `subagentStuck` (amber). Making the suffix `dim` (gray) separates it from the agent name, matching how the `failed` branch on line 369 keeps `agentPart` colored but that's a different status. The `icon` (`⚠`) on line 364 already conveys stuck-ness in color, so the suffix doesn't need to repeat it.

  Alternative considered: make the suffix *more* prominent (e.g. `theme.fg("warning", " timeout")`). Rejected — `dim` is consistent with other secondary metadata in the widget (durations, progress on line 371 all use `dim`), and the `⚠` icon already carries the stuck signal. `dim` is the lower-risk choice.

**Verification:** trigger a stuck subagent (or fake one); in the unfolded status widget the agent name is amber and ` timeout` is gray — visibly distinct.

### Task 4 — Remove unused theme keys
~1 min. One file.

- **`agent/themes/picopi.json`** — delete lines 80–83:
  ```diff
       "subagentStuck": "function",
  -    "statusRunning": "accent",
  -    "statusDone": "string",
  -    "statusFailed": "markup",
  -    "statusStuck": "function",
       "overlayTitle": "accent",
  ```
  Confirmed via repo-wide grep: `statusRunning`/`statusDone`/`statusFailed`/`statusStuck` appear nowhere except these 4 lines. `STATUS_COLOR` in `subagent.ts:272` maps to `subagent*` keys only.

**Verification:** `bunx tsc --noEmit`; launch pi and confirm no theme-load errors and subagent colors still render (they use `subagent*` keys). Optionally validate the JSON against the `$schema` URL noted at the top of the file (the schema lists allowed keys; if the schema still enumerates `status*`, their absence is still valid since they're optional).

## Files to touch
- `src/subagent.ts` — add `runInspector()` (Task 1); replace 2 handler bodies with calls to it (Task 1); change 2 `theme.fg("dim", … done …)` → `statusFg(theme, "done", …)` (Task 2); change line 367 stuck suffix to `theme.fg("dim", " timeout")` (Task 3).
- `agent/themes/picopi.json` — remove 4 `status*` keys (Task 4).

## Risks
- **Refactor correctness (Task 1):** the dedup is a pure move with no logic change, but a copy-paste mistake during the lift could break input handling (scroll/select/verbosity) or the 1s refresh interval. Mitigate by lifting the body verbatim and testing both entry points. Indentation: the lifted body currently lives 3 levels deep (inside `handler` → `try` → `ctx.ui.custom`); at module scope it shifts left by 3 tabs — keep indentation consistent to avoid lint churn, but functionally irrelevant.
- **`done` visibility (Task 2):** switching done from `dim` to `subagentDone` (green) increases visual prominence of successful runs. Intended per audit, but verify it doesn't make the expanded header feel "alarmed" — the `·` prefix and short text keep it subtle. If `subagentDone` proves too bright, fallback is `tryFg(theme, "subagentDone", "success", " · done")`, but `statusFg` already does exactly that fallback internally, so no extra code needed.
- **Stuck suffix (Task 3):** using `dim` for the suffix is low-risk, but if a user's terminal has poor dim contrast the suffix may be hard to read. The `⚠` icon + amber agent name still signal stuck clearly, so this is acceptable. No behavior change, only color.
- **Theme schema (Task 4):** if an external consumer or another theme references `status*`, removal breaks them — but repo grep shows none. The picopi theme is the only theme in `agent/themes/`.
- **Ordering:** Task 1 changes line numbers, so do Task 1 before locating the Task 2 inspector edit by text search (not line number). Task 2's line-1070 edit and Task 3's line-367 edit are above the refactored region and unaffected by Task 1's line shifts. Task 4 is a separate file. Recommended order: Task 4 (independent) → Task 1 (big refactor) → Task 2 (locate by text) → Task 3.
