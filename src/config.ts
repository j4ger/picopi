/**
 * Centralized picopi config + model resolution.
 *
 * The agent dir IS the config dir (PI_CODING_AGENT_DIR -> ~/.config/picopi by
 * default), so config lives at <agentDir>/config.json. Resolved (first existing
 * wins) from:
 *   1. $PICOPI_CONFIG          — explicit override (flake bakes this)
 *   2. <agentDir>/config.json  — the user config
 *   3. the repo bundled default — dev fallback
 *
 * Model strategy: role -> { model: alias, thinking, timeout }; alias -> an
 * ordered list of provider/id models. The first one in the list with working
 * auth wins (so put your preferred model first, fallbacks after).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

export interface RoleConfig {
	model: string;
	thinking?: ThinkingLevel;
	timeout?: number;
	tools?: string[];
}

export interface PicopiConfig {
	orchestrator?: RoleConfig;
	agents?: Record<string, RoleConfig>;
	aliases?: Record<string, string[]>;
	compaction?: { model?: string | null };
	webSearch?: { provider?: string | null; searchModel?: string | null; summaryModel?: string | null };
}

const here = import.meta.dirname;

function candidatePaths(): string[] {
	const out: string[] = [];
	// 1. Explicit override (a flake bakes its config here).
	if (process.env.PICOPI_CONFIG) out.push(process.env.PICOPI_CONFIG);
	// 2. The user config: the agent dir IS the config dir.
	try {
		out.push(path.join(getAgentDir(), "config.json"));
	} catch {
		/* ignore */
	}
	// 3. Repo bundled default (dev fallback).
	out.push(path.resolve(here, "..", "agent", "config.json"));
	return out;
}

// Drop "_comment" keys recursively so the config doubles as inline docs.
function stripComments(o: unknown): unknown {
	if (Array.isArray(o)) return o.map(stripComments);
	if (o && typeof o === "object")
		return Object.fromEntries(Object.entries(o).filter(([k]) => k !== "_comment").map(([k, v]) => [k, stripComments(v)]));
	return o;
}

let cache: { file: string; mtime: number; cfg: PicopiConfig } | null = null;

export function loadConfig(): PicopiConfig {
	for (const p of candidatePaths()) {
		try {
			const { mtimeMs } = fs.statSync(p);
			if (cache?.file === p && cache.mtime === mtimeMs) return cache.cfg;
			const cfg = stripComments(JSON.parse(fs.readFileSync(p, "utf-8"))) as PicopiConfig;
			cache = { file: p, mtime: mtimeMs, cfg };
			return cfg;
		} catch (err) {
			// Warn when a file exists but can't be parsed (syntax error, etc.)
			try {
				if (fs.existsSync(p)) console.warn(`picopi: failed to load config from ${p} (${err instanceof Error ? err.message : err}), falling back`);
			} catch {
				/* eexist race, ignore */
			}
		}
	}
	return {};
}

export function configPath(): string | null {
	return candidatePaths().find((p) => fs.existsSync(p)) ?? null;
}

/** Separator for preset-scoped alias keys, e.g. `pro@fast`. */
const PRESET_SEP = "@";

// ── Active preset (session-local, persisted across invocations) ──────────────

/** Load the last-used preset from `state.json` in the agent dir, if any. */
function loadPersistedPreset(): string {
	try {
		const statePath = path.join(getAgentDir(), "state.json");
		if (!fs.existsSync(statePath)) return "";
		const state = JSON.parse(fs.readFileSync(statePath, "utf-8"));
		if (typeof state.activePreset === "string" && state.activePreset) return state.activePreset;
	} catch {
		/* corrupted or missing — ignore */
	}
	return "";
}

/** Write the current preset to the state file so it survives across invocations. */
function persistPreset(name: string): void {
	try {
		const statePath = path.join(getAgentDir(), "state.json");
		if (name) {
			fs.writeFileSync(statePath, JSON.stringify({ activePreset: name }, null, 2), "utf-8");
		} else {
			// Clear the file when reverting to default (don't leave stale preset around).
			try { fs.unlinkSync(statePath); } catch { /* ok if already gone */ }
		}
	} catch {
		/* can't write — non-fatal */
	}
}

// Seed from the env var first (child/subagent processes), then fall back to the
// persisted state file so the preset survives restarts and session resumes.
let activePreset = process.env.PICOPI_ACTIVE_PRESET ?? loadPersistedPreset();

/** Get the current active preset (session-local). */
export function getActivePreset(): string {
	return activePreset;
}

/** Set (or clear) the active preset. Persists to state.json so it survives
 *  restarts and session resumes. Pass "" to clear (reverts to default). */
export function setActivePreset(name: string): void {
	activePreset = name;
	persistPreset(name);
}

/** Unique preset names declared in the config via `alias@preset` keys, sorted. */
export function listPresets(cfg: PicopiConfig): string[] {
	const presets = new Set<string>();
	for (const key of Object.keys(cfg.aliases ?? {})) {
		const at = key.lastIndexOf(PRESET_SEP);
		if (at > 0 && at < key.length - 1) presets.add(key.slice(at + 1));
	}
	return Array.from(presets).sort();
}

/** Expand an alias into its ordered resolution chain (or treat it as a literal provider/id).
 *  When a preset is active, prefers the `alias@preset` chain, then falls back to the
 *  base alias, then to the alias as a literal provider/id. */
export function resolveChain(cfg: PicopiConfig, alias: string): string[] {
	const aliases = cfg.aliases;
	let chain = activePreset ? aliases?.[`${alias}${PRESET_SEP}${activePreset}`] : undefined;
	if (!chain?.length) chain = aliases?.[alias];
	return chain?.length ? Array.from(new Set(chain)) : [alias];
}

export interface ModelRegistryLike {
	find(provider: string, id: string): unknown;
	getApiKeyAndHeaders(model: unknown): Promise<{ ok: boolean; apiKey?: string; headers?: Record<string, string> }>;
}

/** First model in the role's chain that exists and has working auth, else null. */
export async function resolveRoleModel(
	registry: ModelRegistryLike,
	cfg: PicopiConfig,
	alias: string,
): Promise<{ model: unknown; spec: string } | null> {
	for (const spec of resolveChain(cfg, alias)) {
		const slash = spec.indexOf("/");
		if (slash <= 0) continue;
		const model = registry.find(spec.slice(0, slash), spec.slice(slash + 1));
		if (!model) continue;
		try {
			const auth = await registry.getApiKeyAndHeaders(model);
			if (auth.ok && (auth.apiKey || auth.headers)) return { model, spec };
		} catch {
			/* try next */
		}
	}
	return null;
}

/** Comma-separated `--model` pattern so a spawned pi does the fallback walk itself.
 *  @deprecated Use `resolveModelForSpawn` instead — comma-separated chains are
 *  not understood by pi's `--model` flag. */
export function roleModelPattern(cfg: PicopiConfig, alias: string): string {
	return resolveChain(cfg, alias).join(",");
}

// ── Models.json resolution ────────────────────────────────────────────────────

interface ModelsJson {
	providers?: Record<string, {
		apiKey?: string;
		models?: { id: string }[];
	}>;
}

let modelsCache: { file: string; mtime: number; data: ModelsJson } | null = null;

/** Load models.json from the agent dir (same location pi uses). */
function loadModelsJson(): ModelsJson {
	try {
		const agentDir = getAgentDir();
		const p = path.join(agentDir, "models.json");
		const { mtimeMs } = fs.statSync(p);
		if (modelsCache?.file === p && modelsCache.mtime === mtimeMs) return modelsCache.data;
		const data = JSON.parse(fs.readFileSync(p, "utf-8")) as ModelsJson;
		modelsCache = { file: p, mtime: mtimeMs, data };
		return data;
	} catch {
		return {};
	}
}

/**
 * Resolve the first model from an alias chain that exists in models.json and
 * has an API key configured.  Returns the `provider/modelId` spec or null.
 *
 * This replaces the broken `roleModelPattern` approach for spawned pi
 * processes (pi does NOT support comma-separated fallback chains).
 */
export function resolveModelForSpawn(cfg: PicopiConfig, alias: string): string | null {
	const chain = resolveChain(cfg, alias);
	const mj = loadModelsJson();
	for (const spec of chain) {
		const slash = spec.indexOf("/");
		if (slash <= 0) continue;
		const provider = spec.slice(0, slash);
		const modelId = spec.slice(slash + 1);
		const prov = mj.providers?.[provider];
		if (!prov) continue;
		// Check the model exists in the provider's model list
		const hasModel = prov.models?.some((m) => m.id === modelId) ?? false;
		if (!hasModel) continue;
		// Check the provider has an API key
		if (!prov.apiKey) continue;
		return spec;
	}
	return null;
}

export interface ValidationIssue {
	spec: string;
	reason: "not-found" | "no-auth" | "malformed";
}

export interface RoleValidationResult {
	role: string;
	alias: string;
	ok: boolean;
	resolved?: string;
	issues: ValidationIssue[];
}

export interface ValidationReport {
	ok: boolean;
	results: RoleValidationResult[];
}

/** Validate every configured role model (orchestrator, agents, compaction) by
 * walking each alias chain and checking registry + auth.  Best-effort: never
 * throws. */
export async function validateAllResolutions(
	registry: ModelRegistryLike,
	cfg: PicopiConfig,
): Promise<ValidationReport> {
	const results: RoleValidationResult[] = [];
	const roles: { role: string; alias: string }[] = [];
	if (cfg.orchestrator?.model) roles.push({ role: "orchestrator", alias: cfg.orchestrator.model });
	for (const [name, r] of Object.entries(cfg.agents ?? {})) {
		if (r.model) roles.push({ role: `agent:${name}`, alias: r.model });
	}
	if (cfg.compaction?.model) roles.push({ role: "compaction", alias: cfg.compaction.model });

	for (const { role, alias } of roles) {
		const issues: ValidationIssue[] = [];
		let resolved: string | undefined;
		for (const spec of resolveChain(cfg, alias)) {
			const slash = spec.indexOf("/");
			if (slash <= 0) {
				issues.push({ spec, reason: "malformed" });
				continue;
			}
			const model = registry.find(spec.slice(0, slash), spec.slice(slash + 1));
			if (!model) {
				issues.push({ spec, reason: "not-found" });
				continue;
			}
			try {
				const auth = await registry.getApiKeyAndHeaders(model);
				if (auth.ok && (auth.apiKey || auth.headers)) {
					resolved = spec;
					break;
				}
				issues.push({ spec, reason: "no-auth" });
			} catch {
				issues.push({ spec, reason: "no-auth" });
			}
		}
		results.push({ role, alias, ok: !!resolved, resolved, issues });
	}

	return { ok: results.every((r) => r.ok), results };
}
