/**
 * picopi web tools — self-contained, zero-dependency web search + fetch.
 *
 * No external packages: only Node built-ins and global fetch. This keeps the
 * Nix build fast and the behaviour fully under our control.
 *
 * web_search:
 *   provider resolution (config.webSearch.provider, default "auto"):
 *     exa        -> EXA_API_KEY        (POST api.exa.ai/search)
 *     perplexity -> PERPLEXITY_API_KEY (synthesized answer, sonar)
 *     brave      -> BRAVE_API_KEY      (GET api.search.brave.com)
 *     duckduckgo -> no key (zero-config HTML fallback)
 *   "auto" picks the first provider whose key is present, else duckduckgo.
 *
 * fetch_content:
 *   fetches a URL and returns readable text/markdown (HTML stripped). JSON,
 *   text, and markdown are returned as-is. Output is capped; the LLM can
 *   re-fetch with a different range if needed.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { loadConfig } from "./config.ts";

const UA = "picopi/0.1 (+https://github.com/; pi coding agent)";
const FETCH_CAP = 30_000;
const MAX_DOWNLOAD = 10 * 1024 * 1024; // hard cap on bytes read from a response
const SEARCH_TIMEOUT = 20_000;
const FETCH_TIMEOUT = 30_000;

/** Read a response body as text, aborting once MAX_DOWNLOAD bytes are seen. */
async function readCapped(res: Response): Promise<string> {
	const len = Number(res.headers.get("content-length") ?? "0");
	if (len > MAX_DOWNLOAD) throw new Error(`response too large (${len} bytes)`);
	if (!res.body) return res.text();
	const reader = res.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		total += value.length;
		if (total > MAX_DOWNLOAD) {
			await reader.cancel().catch(() => {});
			throw new Error("response exceeded size limit");
		}
		chunks.push(value);
	}
	return Buffer.concat(chunks).toString("utf8");
}

function assertSafeUrl(urlStr: string): URL {
	const parsed = new URL(urlStr);
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
		throw new Error(`URL protocol must be http or https, got ${parsed.protocol}`);
	}
	const host = parsed.hostname.toLowerCase();
	if (host === "localhost") throw new Error("URL targets localhost (loopback)");
	if (host.endsWith(".internal") || host.endsWith(".local"))
		throw new Error(`URL targets internal/local hostname: ${host}`);
	const ipv4 = host.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
	if (ipv4) {
		const a = Number(ipv4[1]), b = Number(ipv4[2]), c = Number(ipv4[3]), d = Number(ipv4[4]);
		if (a === 127) throw new Error("URL targets loopback (127.0.0.0/8)");
		if (a === 10) throw new Error("URL targets private network (10.0.0.0/8)");
		if (a === 169 && b === 254) throw new Error("URL targets link-local (169.254.0.0/16)");
		if (a === 192 && b === 168) throw new Error("URL targets private network (192.168.0.0/16)");
		if (a === 172 && b >= 16 && b <= 31) throw new Error("URL targets private network (172.16.0.0/12)");
	}
	if (host.includes(":")) {
		const ipv6 = host.replace(/%[a-z0-9]+$/i, "").toLowerCase();
		if (ipv6 === "::1" || ipv6 === "0:0:0:0:0:0:0:1") throw new Error("URL targets loopback (::1)");
		if (ipv6.startsWith("fc") || ipv6.startsWith("fd")) throw new Error("URL targets unique-local (fc00::/7)");
		if (ipv6.startsWith("fe80")) throw new Error("URL targets link-local (fe80::/10)");
	}
	return parsed;
}

async function fetchSafe(url: string, headers: Record<string, string>, signal: AbortSignal): Promise<Response> {
	let parsed = assertSafeUrl(url);
	let remaining = 5;
	while (true) {
		const res = await fetch(parsed.href, { headers, signal, redirect: "manual" });
		if (res.status >= 300 && res.status < 400 && res.status !== 304 && res.headers.has("location")) {
			if (--remaining < 0) throw new Error("too many redirects");
			const loc = new URL(res.headers.get("location")!, parsed.href);
			assertSafeUrl(loc.href);
			parsed = loc;
			continue;
		}
		return res;
	}
}

function envKey(name: string): string | undefined {
	const v = process.env[name];
	return v && v.trim() ? v.trim() : undefined;
}

async function withTimeout<T>(ms: number, fn: (signal: AbortSignal) => Promise<T>, outer?: AbortSignal): Promise<T> {
	const ctrl = new AbortController();
	const t = setTimeout(() => ctrl.abort(), ms);
	const onAbort = () => ctrl.abort();
	outer?.addEventListener("abort", onAbort, { once: true });
	try {
		return await fn(ctrl.signal);
	} finally {
		clearTimeout(t);
		outer?.removeEventListener("abort", onAbort);
	}
}

// --- HTML -> readable text ----------------------------------------------------
const ENTITIES: Record<string, string> = {
	"&amp;": "&",
	"&lt;": "<",
	"&gt;": ">",
	"&quot;": '"',
	"&#39;": "'",
	"&apos;": "'",
	"&nbsp;": " ",
	"&mdash;": "—",
	"&ndash;": "–",
	"&hellip;": "…",
};
function decodeEntities(s: string): string {
	return s
		.replace(/&#(\d+);/g, (_, n) => { const cp = Number(n); return cp >= 0 && cp <= 0x10FFFF ? String.fromCodePoint(cp) : _; })
		.replace(/&#x([0-9a-f]+);/gi, (_, n) => { const cp = parseInt(n, 16); return cp >= 0 && cp <= 0x10FFFF ? String.fromCodePoint(cp) : _; })
		.replace(/&[a-z]+;/gi, (m) => ENTITIES[m.toLowerCase()] ?? m);
}
function htmlToText(html: string): string {
	let s = html;
	s = s.replace(/<!--[\s\S]*?-->/g, "");
	// Pull a title for context (after comment-strip so commented-out titles don't win).
	const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(s)?.[1]?.trim();
	s = s.replace(/<(script|style|head|nav|footer|svg|noscript)[\s\S]*?<\/\1>/gi, "");
	s = s.replace(/<\/(p|div|section|article|li|tr|h[1-6]|blockquote)>/gi, "\n");
	s = s.replace(/<br\s*\/?>/gi, "\n");
	s = s.replace(/<li[^>]*>/gi, "- ");
	s = s.replace(/<h([1-6])[^>]*>/gi, (_, n) => "\n" + "#".repeat(Number(n)) + " ");
	s = s.replace(/<[^>]+>/g, "");
	s = decodeEntities(s);
	s = s.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").replace(/[ \t]{2,}/g, " ").trim();
	return title ? `# ${decodeEntities(title)}\n\n${s}` : s;
}

function cap(text: string): string {
	if (text.length <= FETCH_CAP) return text;
	return `${text.slice(0, FETCH_CAP)}\n\n[truncated: ${text.length - FETCH_CAP} more chars]`;
}

// --- search providers ---------------------------------------------------------
interface SearchHit {
	title: string;
	url: string;
	snippet?: string;
}
interface SearchResult {
	provider: string;
	answer?: string;
	hits: SearchHit[];
}

async function searchExa(key: string, query: string, n: number, signal: AbortSignal): Promise<SearchResult> {
	const res = await fetch("https://api.exa.ai/search", {
		method: "POST",
		headers: { "content-type": "application/json", "x-api-key": key, "user-agent": UA },
		body: JSON.stringify({ query, numResults: n, contents: { text: { maxCharacters: 500 } } }),
		signal,
	});
	if (!res.ok) throw new Error(`exa ${res.status}`);
	const body = await readCapped(res);
	const data: any = JSON.parse(body);
	return {
		provider: "exa",
		hits: (data.results ?? []).map((r: any) => ({ title: r.title ?? r.url, url: r.url, snippet: r.text?.slice(0, 400) })),
	};
}

async function searchPerplexity(key: string, query: string, model: string, signal: AbortSignal): Promise<SearchResult> {
	const res = await fetch("https://api.perplexity.ai/chat/completions", {
		method: "POST",
		headers: { "content-type": "application/json", authorization: `Bearer ${key}`, "user-agent": UA },
		body: JSON.stringify({
			model,
			messages: [{ role: "user", content: query }],
		}),
		signal,
	});
	if (!res.ok) throw new Error(`perplexity ${res.status}`);
	const body = await readCapped(res);
	const data: any = JSON.parse(body);
	const answer = data.choices?.[0]?.message?.content ?? "";
	const hits: SearchHit[] = (data.citations ?? []).map((u: string, i: number) => ({ title: `[${i + 1}] ${u}`, url: u }));
	return { provider: "perplexity", answer, hits };
}

async function searchBrave(key: string, query: string, n: number, signal: AbortSignal): Promise<SearchResult> {
	const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${n}`;
	const res = await fetch(url, { headers: { accept: "application/json", "x-subscription-token": key, "user-agent": UA }, signal });
	if (!res.ok) throw new Error(`brave ${res.status}`);
	const body = await readCapped(res);
	const data: any = JSON.parse(body);
	return {
		provider: "brave",
		hits: (data.web?.results ?? []).map((r: any) => ({ title: r.title, url: r.url, snippet: r.description })),
	};
}

async function searchDuckDuckGo(query: string, n: number, signal: AbortSignal): Promise<SearchResult> {
	const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
	const res = await fetch(url, { headers: { "user-agent": UA }, signal });
	if (!res.ok) throw new Error(`duckduckgo ${res.status}`);
	const body = await readCapped(res);
	const html = body;
	const hits: SearchHit[] = [];
	const re = /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
	let m: RegExpExecArray | null;
	while ((m = re.exec(html)) && hits.length < n) {
		let href = decodeEntities(m[1]);
		// DDG wraps targets in /l/?uddg=<encoded>
		const uddg = /[?&]uddg=([^&]+)/.exec(href);
		if (uddg) href = decodeURIComponent(uddg[1]);
		const title = htmlToText(m[2]).trim();
		if (href.startsWith("http")) hits.push({ title, url: href });
	}
	// Snippets
	const snipRe = /<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/gi;
	let i = 0;
	let s: RegExpExecArray | null;
	while ((s = snipRe.exec(html)) && i < hits.length) {
		hits[i].snippet = htmlToText(s[1]).trim();
		i++;
	}
	// If DDG's HTML structure changed and no results were parsed, throw so
	// the caller can surface a clear error instead of silently returning 0 hits.
	if (hits.length === 0 && html.length > 1000) {
		throw new Error("duckduckgo: no results parsed — HTML layout may have changed");
	}
	return { provider: "duckduckgo", hits };
}

async function runSearch(query: string, n: number, requested: string | undefined, signal: AbortSignal): Promise<SearchResult> {
	const cfg = loadConfig();
	const provider = (requested ?? cfg.webSearch?.provider ?? "auto").toLowerCase();
	const exa = envKey("EXA_API_KEY");
	const pplx = envKey("PERPLEXITY_API_KEY");
	const brave = envKey("BRAVE_API_KEY");
	const pplxModel = typeof cfg.webSearch?.searchModel === "string" && cfg.webSearch.searchModel.trim() ? cfg.webSearch.searchModel.trim() : "sonar";

	const tryOrder: string[] =
		provider === "auto"
			? [exa && "exa", pplx && "perplexity", brave && "brave", "duckduckgo"].filter(Boolean) as string[]
			: [provider];

	let lastErr: unknown;
	for (const p of tryOrder) {
		try {
			if (p === "exa" && exa) return await searchExa(exa, query, n, signal);
			if (p === "perplexity" && pplx) return await searchPerplexity(pplx, query, pplxModel, signal);
			if (p === "brave" && brave) return await searchBrave(brave, query, n, signal);
			if (p === "duckduckgo") return await searchDuckDuckGo(query, n, signal);
			// requested a keyed provider but no key
			throw new Error(`${p}: missing API key`);
		} catch (e) {
			lastErr = e;
		}
	}
	throw lastErr ?? new Error("no search provider available");
}

function formatSearch(query: string, r: SearchResult): string {
	const lines: string[] = [`# Search: ${query}  (via ${r.provider})`];
	if (r.answer) lines.push("", r.answer);
	if (r.hits.length) {
		lines.push("", "## Sources");
		for (const h of r.hits) {
			lines.push(`- [${h.title}](${h.url})`);
			if (h.snippet) lines.push(`  ${h.snippet}`);
		}
	}
	if (!r.answer && !r.hits.length) lines.push("", "(no results)");
	return lines.join("\n");
}

// --- tools --------------------------------------------------------------------
const SearchParams = Type.Object({
	query: Type.Optional(Type.String({ description: "Search query" })),
	queries: Type.Optional(Type.Array(Type.String(), { description: "Multiple queries, each searched in turn" })),
	numResults: Type.Optional(Type.Number({ description: "Results per query (default 5, max 15)" })),
	provider: Type.Optional(Type.String({ description: "exa | perplexity | brave | duckduckgo | auto" })),
});

const FetchParams = Type.Object({
	url: Type.Optional(Type.String({ description: "URL to fetch" })),
	urls: Type.Optional(Type.Array(Type.String(), { description: "Multiple URLs to fetch" })),
});

export function setupWeb(pi: ExtensionAPI) {
	pi.registerTool({
		name: "web_search",
		label: "Web Search",
		description:
			"Search the web. Returns a synthesized answer (perplexity) or ranked sources (exa/brave/duckduckgo). Pass `queries` for several searches. Zero-config via DuckDuckGo; set EXA_API_KEY / PERPLEXITY_API_KEY / BRAVE_API_KEY for better results.",
		promptSnippet: "Search the web with web_search (query or queries[])",
		promptGuidelines: ["Use web_search for up-to-date facts; prefer several varied queries over one broad query."],
		parameters: SearchParams,
		async execute(_id, params, signal, _onUpdate, _ctx) {
			const queries = params.queries?.length ? params.queries : params.query ? [params.query] : [];
			if (!queries.length)
				return { content: [{ type: "text", text: "Error: query or queries required" }], details: { results: [] }, isError: true };
			const n = Math.min(Math.max(params.numResults ?? 5, 1), 15);
			const blocks: string[] = [];
			const details: SearchResult[] = [];
			for (const q of queries) {
				try {
					const r = await withTimeout(SEARCH_TIMEOUT, (s) => runSearch(q, n, params.provider, s), signal);
					details.push(r);
					blocks.push(formatSearch(q, r));
				} catch (e) {
					blocks.push(`# Search: ${q}\n\nError: ${e instanceof Error ? e.message : String(e)}`);
				}
			}
			return { content: [{ type: "text", text: cap(blocks.join("\n\n---\n\n")) }], details: { results: details } };
		},
		renderCall(args, theme) {
			const q = args.queries?.length ? `${args.queries.length} queries` : args.query || "…";
			return new Text(theme.fg("toolTitle", theme.bold("web_search ")) + theme.fg("accent", q), 0, 0);
		},
		renderResult(result, _opts, theme) {
			const d = result.details as { results?: SearchResult[] } | undefined;
			const total = d?.results?.reduce((a, r) => a + r.hits.length, 0) ?? 0;
			const prov = d?.results?.[0]?.provider ?? "?";
			return new Text(theme.fg("success", "✓ ") + theme.fg("muted", `${total} sources via ${prov}`), 0, 0);
		},
	});

	pi.registerTool({
		name: "fetch_content",
		label: "Fetch",
		description:
			"Fetch a URL and return readable content (HTML stripped to text/markdown; JSON/text returned as-is). Pass `urls` to fetch several. Output is capped at 30k chars.",
		promptSnippet: "Read a web page with fetch_content (url or urls[])",
		promptGuidelines: ["Use fetch_content to read pages found via web_search before relying on snippets."],
		parameters: FetchParams,
		async execute(_id, params, signal, _onUpdate, _ctx) {
			const urls = params.urls?.length ? params.urls : params.url ? [params.url] : [];
			if (!urls.length) return { content: [{ type: "text", text: "Error: url or urls required" }], details: { urls: [] }, isError: true };
			const blocks: string[] = [];
			for (const url of urls) {
				try {
					const text = await withTimeout(
						FETCH_TIMEOUT,
						async (s) => {
							const res = await fetchSafe(url, { "user-agent": UA, accept: "text/html,application/json,text/plain,*/*" }, s);
							if (!res.ok) throw new Error(`HTTP ${res.status}`);
							const ct = res.headers.get("content-type") ?? "";
							const body = await readCapped(res);
							if (ct.includes("html")) return htmlToText(body);
							return body; // json / text / markdown
						},
						signal,
					);
					blocks.push(`# ${url}\n\n${text}`);
				} catch (e) {
					blocks.push(`# ${url}\n\nError: ${e instanceof Error ? e.message : String(e)}`);
				}
			}
			return { content: [{ type: "text", text: cap(blocks.join("\n\n---\n\n")) }], details: { urls } };
		},
		renderCall(args, theme) {
			const u = args.urls?.length ? `${args.urls.length} urls` : args.url || "…";
			return new Text(theme.fg("toolTitle", theme.bold("fetch ")) + theme.fg("accent", u), 0, 0);
		},
		renderResult(result, _opts, theme) {
			const t = result.content[0];
			const text = t?.type === "text" ? t.text : "";
			return new Text(theme.fg("success", "✓ ") + theme.fg("muted", `${text.length} chars`), 0, 0);
		},
	});
}
