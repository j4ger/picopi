/**
 * Centralized picopi config + model resolution.
 *
 * The agent dir IS the config dir (PI_CODING_AGENT_DIR -> ~/.config/picopi by
 * default), so the single config file lives at <agentDir>/config.json. The
 * installer/flake seed it there once; it's the only path consulted at runtime.
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
	titleMaker?: RoleConfig;
	agents?: Record<string, RoleConfig>;
	aliases?: Record<string, string[]>;
	compaction?: { model?: string | null };
	webSearch?: { provider?: string | null; searchModel?: string | null; summaryModel?: string | null };
	/** Max concurrent subagent processes in parallel mode (default: 3). */
	concurrency?: number;
	/** Cleanup of stale session artifacts (undo backup refs, etc.). */
	cleanup?: CleanupConfig;
}

export interface CleanupConfig {
	/** Delete undo backup refs older than this many days (default: 30, 0 = never). */
	checkpointMaxAgeDays?: number;
}

/** The single config file path: <agentDir>/config.json (~/.config/picopi by
 *  default). Returns null if the agent dir can't be resolved. */
function configFilePath(): string | null {
	try {
		return path.join(getAgentDir(), "config.json");
	} catch {
		return null;
	}
}

// Drop "_comment" keys recursively so the config doubles as inline docs.
function stripComments(o: unknown): unknown {
	if (Array.isArray(o)) return o.map(stripComments);
	if (o && typeof o === "object")
		return Object.fromEntries(Object.entries(o).filter(([k]) => k !== "_comment").map(([k, v]) => [k, stripComments(v)]));
	return o;
}

let cache: { file: string; mtime: number; cfg: PicopiConfig; checkedAt: number } | null = null;
const CACHE_TTL_MS = 5000;

export function loadConfig(): PicopiConfig {
	const p = configFilePath();
	if (!p) return {};
	try {
		const now = Date.now();
		// Skip statSync if cache is fresh enough (TTL-based).
		if (cache?.file === p && now - cache.checkedAt < CACHE_TTL_MS) return cache.cfg;
		const { mtimeMs } = fs.statSync(p);
		if (cache?.file === p && cache.mtime === mtimeMs) {
			cache.checkedAt = now;
			return cache.cfg;
		}
		const cfg = stripComments(JSON.parse(fs.readFileSync(p, "utf-8"))) as PicopiConfig;
		cache = { file: p, mtime: mtimeMs, cfg, checkedAt: now };
		return cfg;
	} catch (err) {
		// Warn when the file exists but can't be parsed (syntax error, etc.).
		try {
			if (fs.existsSync(p)) console.warn(`picopi: failed to load config from ${p} (${err instanceof Error ? err.message : err})`);
		} catch {
			/* eexist race, ignore */
		}
		return {};
	}
}

export function configPath(): string | null {
	const p = configFilePath();
	return p && fs.existsSync(p) ? p : null;
}

/** Separator for preset-scoped alias keys, e.g. `pro@fast`. */
const PRESET_SEP = "@";

// ── Active preset (per-workspace, persisted across invocations) ──────────────

const statePath = (): string => path.join(getAgentDir(), "state.json");

function readState(): { activePreset?: string; presets?: Record<string, string> } {
	try {
		return JSON.parse(fs.readFileSync(statePath(), "utf-8"));
	} catch {
		return {}; // missing or corrupted
	}
}

/** Load the last-used preset for the current workspace (falls back to the
 *  legacy global key for configs written before per-workspace tracking). */
function loadPersistedPreset(): string {
	const state = readState();
	const byWorkspace = state.presets?.[process.cwd()];
	if (typeof byWorkspace === "string") return byWorkspace;
	return typeof state.activePreset === "string" ? state.activePreset : "";
}

/** Persist the current workspace's preset, preserving other workspaces' entries. */
function persistPreset(name: string): void {
	try {
		const state = readState();
		const presets = state.presets ?? {};
		if (name) presets[process.cwd()] = name;
		else delete presets[process.cwd()];
		const next = { ...state, presets };
		fs.writeFileSync(statePath(), JSON.stringify(next, null, 2), "utf-8");
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
	find(provider: string, id: string): object | undefined;
	getApiKeyAndHeaders(model: object): Promise<{ ok: boolean; apiKey?: string; headers?: Record<string, string> }>;
}

/** First model in the role's chain that exists and has working auth, else null. */
export async function resolveRoleModel(
	registry: ModelRegistryLike,
	cfg: PicopiConfig,
	alias: string,
): Promise<{ model: object; spec: string } | null> {
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
	const chain = resolveModelChainForSpawn(cfg, alias);
	return chain.length > 0 ? chain[0] : null;
}

/**
 * Resolve ALL models from an alias chain that exist in models.json and have
 * an API key configured.  Returns the full ordered list of `provider/modelId`
 * specs so callers can implement runtime retry-with-fallback.
 */
export function resolveModelChainForSpawn(cfg: PicopiConfig, alias: string): string[] {
	const chain = resolveChain(cfg, alias);
	const mj = loadModelsJson();
	const result: string[] = [];
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
		result.push(spec);
	}
	return result;
}

/**
 * Resolve a raw model ID to its friendly display name using the model registry.
 * Returns the raw ID if no friendly name is found.
 */
export function resolveModelDisplayName(
	modelRegistry: any,
	rawModelId: string | undefined,
): string | undefined {
	if (!rawModelId || !modelRegistry) return rawModelId;
	try {
		// pi's model registry has a find() method that takes provider and modelId
		// Try provider/modelId format first (precise lookup)
		const slashIdx = rawModelId.indexOf("/");
		if (slashIdx > 0) {
			const provider = rawModelId.slice(0, slashIdx);
			const modelId = rawModelId.slice(slashIdx + 1);
			const found = modelRegistry.find?.(provider, modelId);
			if (found?.name) return found.name;
		}
		// Fallback: try bare model ID match
		const models = modelRegistry.getAll?.();
		if (models) {
			const found = models.find((m: any) => m.id === rawModelId);
			if (found?.name) return found.name;
		}
	} catch {
		/* registry lookup failed, fall through */
	}
	return rawModelId;
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
