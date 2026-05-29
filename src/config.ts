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

interface RoleConfig {
	model: string;
	thinking?: ThinkingLevel;
	timeout?: number;
}

export interface PicopiConfig {
	autoResolveOrchestrator?: boolean;
	orchestrator?: RoleConfig;
	agents?: Record<string, RoleConfig>;
	aliases?: Record<string, string[]>;
	compaction?: { model?: string | null };
	webSearch?: { provider?: string | null; searchModel?: string | null; summaryModel?: string | null };
}

const here = import.meta.dirname ?? __dirname;

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
		} catch {
			/* try next */
		}
	}
	return {};
}

export function configPath(): string | null {
	return candidatePaths().find((p) => fs.existsSync(p)) ?? null;
}

/** Expand an alias into its ordered resolution chain (or treat it as a literal provider/id). */
export function resolveChain(cfg: PicopiConfig, alias: string): string[] {
	const chain = cfg.aliases?.[alias] ?? [];
	return chain.length ? Array.from(new Set(chain)) : [alias];
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
			if (auth.ok && auth.apiKey) return { model, spec };
		} catch {
			/* try next */
		}
	}
	return null;
}

/** Comma-separated `--model` pattern so a spawned pi does the fallback walk itself. */
export function roleModelPattern(cfg: PicopiConfig, alias: string): string {
	return resolveChain(cfg, alias).join(",");
}
