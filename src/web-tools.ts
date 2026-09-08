import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	keyHint,
	truncateHead,
	type ExtensionAPI,
	type ThemeColor,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type, type TSchema } from "typebox";
import { buildAttributionHeaders, resolveMcpUrl } from "./lunaroute.js";

// First-class web tools (kata akyg). The hosted LunaRoute MCP server exposes
// a normalized web_search tool; this module surfaces it as a real Pi tool —
// but only when no other extension already provides web search, because
// cross-extension tool names are first-registration-wins and a duplicate
// registration is silently ignored (pi runner.ts getAllRegisteredTools).
//
// Transport notes (verified 2026-09-08 against lunaroute-mcp 0.1.0): the
// server is stateless Streamable HTTP over plain JSON — tools/call works
// standalone, no Mcp-Session-Id is issued. We still send a one-time
// initialize handshake so self-hosted/stateful gateways behind
// LUNAROUTE_MCP_URL behave, and we capture the session header if present.

// ============================================================================
// Detection
// ============================================================================

// Names that mean "someone already provides web search/fetch". Covers the
// pi ecosystem conventions: pi-web-access (web_search, fetch_content),
// pi-web-search (web_search, url_context), @bytetrue/pi-web-search
// (web_fetch), plus pi-mcp-adapter directTools prefixes (e.g.
// lunaroute_web_search, parallel_web_search) via the trailing-_ patterns.
const WEB_SEARCH_TOOL_PATTERNS = [/^web_?search$/i, /^search_?web$/i, /_web_?search$/i];
const WEB_FETCH_TOOL_PATTERNS = [
	/^web_?fetch$/i,
	/^fetch_?content$/i,
	/^url_?context$/i,
	/_web_?fetch$/i,
	/_fetch_?content$/i,
];

export function matchesAnyPattern(name: string, patterns: RegExp[]): boolean {
	return patterns.some((p) => p.test(name));
}

export interface WebToolPresence {
	hasWebSearch: boolean;
	hasWebFetch: boolean;
}

/** Detect existing web tools by name across all registered Pi tools.
 * Must run in session_start (all extension factories have run) and check
 * getAllTools() — registered-but-inactive still wins the name (first-wins). */
export function detectWebTools(toolNames: string[]): WebToolPresence {
	return {
		hasWebSearch: toolNames.some((n) => matchesAnyPattern(n, WEB_SEARCH_TOOL_PATTERNS)),
		hasWebFetch: toolNames.some((n) => matchesAnyPattern(n, WEB_FETCH_TOOL_PATTERNS)),
	};
}

// ============================================================================
// MCP client (minimal Streamable HTTP JSON-RPC)
// ============================================================================

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface McpToolCallResult {
	content: { type: string; text?: string }[];
	isError?: boolean;
}

export interface LunarouteMcpClient {
	listTools(signal?: AbortSignal): Promise<string[]>;
	callTool(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<McpToolCallResult>;
}

export interface McpClientOptions {
	url: string;
	headers: Record<string, string>;
	fetchImpl: FetchLike;
	requestTimeoutMs?: number;
}

/** Extract JSON payloads from an SSE body (data: lines), in order. */
export function parseSseData(body: string): unknown[] {
	const payloads: unknown[] = [];
	for (const line of body.split("\n")) {
		if (!line.startsWith("data:")) continue;
		const data = line.slice(5).trim();
		if (!data || data === "[DONE]") continue;
		try {
			payloads.push(JSON.parse(data));
		} catch {
			// Ignore malformed SSE frames.
		}
	}
	return payloads;
}

interface JsonRpcResponse {
	jsonrpc?: string;
	id?: number;
	result?: unknown;
	error?: { code?: number; message?: string };
}

function decodeJsonRpcBody(body: string, expectedId: number): JsonRpcResponse {
	const contentTypeIsSse = body.includes("data:");
	if (contentTypeIsSse && !body.trimStart().startsWith("{")) {
		const frames = parseSseData(body).filter(
			(f): f is JsonRpcResponse =>
				typeof f === "object" && f !== null && (f as JsonRpcResponse).id === expectedId,
		);
		if (frames.length === 0) throw new Error("MCP: no response frame in SSE stream");
		return frames[frames.length - 1];
	}
	return JSON.parse(body) as JsonRpcResponse;
}

/** Minimal MCP Streamable HTTP client for the hosted LunaRoute server.
 * One POST per call; a lazy initialize handshake runs once and is optional
 * (the production server is stateless and accepts bare tools/call). */
export function createLunarouteMcpClient(opts: McpClientOptions): LunarouteMcpClient {
	let nextId = 1;
	let initialized = false;

	async function rpc(method: string, params?: unknown, signal?: AbortSignal): Promise<unknown> {
		const id = nextId++;
		const response = await opts.fetchImpl(opts.url, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Accept: "application/json, text/event-stream",
				...opts.headers,
			},
			body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
			signal,
		});
		if (!response.ok) {
			throw new Error(`MCP ${method} failed: HTTP ${response.status}`);
		}
		const decoded = decodeJsonRpcBody(await response.text(), id);
		if (decoded.error) {
			throw new Error(`MCP ${method} failed: ${decoded.error.message ?? "unknown error"}`);
		}
		return decoded.result;
	}

	async function ensureInitialized(signal?: AbortSignal): Promise<void> {
		if (initialized) return;
		initialized = true;
		try {
			// Fire-and-forget politeness: stateless servers (production) just
			// answer; stateful ones issue Mcp-Session-Id, which we cannot
			// propagate without per-request state — such gateways are not a
			// supported target for the direct client (use pi-mcp-adapter).
			await rpc(
				"initialize",
				{
					protocolVersion: "2025-06-18",
					capabilities: {},
					clientInfo: { name: "lunaroute-pi-extension", version: "web-tools" },
				},
				signal,
			);
			await rpc("notifications/initialized", undefined, signal);
		} catch {
			// Stateless servers may reject initialize; tools/call still works.
		}
	}

	return {
		async listTools(signal) {
			await ensureInitialized(signal);
			const result = (await rpc("tools/list", undefined, signal)) as {
				tools?: { name?: string }[];
			};
			return (result.tools ?? [])
				.map((t) => t.name)
				.filter((n): n is string => typeof n === "string");
		},
		async callTool(name, args, signal) {
			await ensureInitialized(signal);
			const result = (await rpc("tools/call", { name, arguments: args }, signal)) as McpToolCallResult;
			if (result?.isError) {
				const text = result.content?.map((c) => c.text ?? "").join("\n").trim();
				throw new Error(text || `MCP tool ${name} returned an error`);
			}
			return result;
		},
	};
}

// ============================================================================
// web_search result shaping
// ============================================================================

export interface WebSearchResultItem {
	title?: string;
	url?: string;
	snippet?: string;
	published_date?: string | null;
	score?: number | null;
}

export interface WebSearchPayload {
	query: string;
	provider: string;
	results: WebSearchResultItem[];
	/** Set when the server text was not the expected JSON payload. */
	rawText?: string;
}

/** Parse the normalized {query, provider, results[]} payload the MCP tool
 * returns as its content text. Tolerant: any parse failure keeps the raw
 * text so the model still sees what the server sent. */
export function parseWebSearchPayload(text: string): WebSearchPayload {
	try {
		const parsed = JSON.parse(text) as Partial<WebSearchPayload>;
		return {
			query: typeof parsed.query === "string" ? parsed.query : "",
			provider: typeof parsed.provider === "string" ? parsed.provider : "",
			results: Array.isArray(parsed.results) ? parsed.results : [],
		};
	} catch {
		return { query: "", provider: "", results: [], rawText: text };
	}
}

function formatResultItem(item: WebSearchResultItem, index: number): string {
	const lines: string[] = [];
	const title = item.title?.trim() || "(untitled)";
	const url = item.url?.trim() || "";
	lines.push(`${index + 1}. ${title}`);
	if (url) lines.push(`   ${url}`);
	if (item.snippet?.trim()) lines.push(`   ${item.snippet.trim()}`);
	if (item.published_date) lines.push(`   published: ${item.published_date}`);
	return lines.join("\n");
}

/** Format the payload as the text content sent to the LLM. */
export function formatWebSearchForModel(payload: WebSearchPayload): string {
	if (payload.rawText !== undefined) return payload.rawText;
	if (payload.results.length === 0) {
		return `No results${payload.query ? ` for "${payload.query}"` : ""}${
			payload.provider ? ` (provider: ${payload.provider})` : ""
		}.`;
	}
	const header = `Web search${payload.query ? ` for "${payload.query}"` : ""}${
		payload.provider ? ` via ${payload.provider}` : ""
	} — ${payload.results.length} result(s):`;
	return [header, ...payload.results.map(formatResultItem)].join("\n\n");
}

/** Cap output per Pi's tool rules (50KB / 2000 lines, head-truncated). */
export function truncateForModel(text: string): { text: string; truncated: boolean } {
	const result = truncateHead(text, { maxLines: DEFAULT_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES });
	return { text: result.content, truncated: result.truncated };
}

/** Spill full output to a temp file when truncation kicked in, so the model
 * can be pointed at the complete content (pi's truncated-tool convention). */
export async function spillFullOutput(
	text: string,
	io: {
		writeFile: (path: string, data: string) => Promise<void>;
		tmpdir: () => string;
		randomUUID: () => string;
	} = { writeFile, tmpdir, randomUUID },
): Promise<string> {
	const path = join(io.tmpdir(), `lunaroute-web-${io.randomUUID()}.txt`);
	await io.writeFile(path, text);
	return path;
}

// ============================================================================
// Renderers (pure builders + thin Component wrappers)
// ============================================================================

type ThemeLike = {
	fg: (color: ThemeColor, text: string) => string;
	bold: (text: string) => string;
};

const truncateText = (s: string, n: number) => (s.length <= n ? s : s.slice(0, n - 1) + "…");

export function webSearchCallText(
	args: { query?: string; count?: number },
	theme: ThemeLike,
	isPartial: boolean,
): string {
	const label = theme.fg("toolTitle", theme.bold("web_search"));
	let out = `${label} ${theme.fg("dim", truncateText(`"${args.query ?? ""}"`, 64))}`;
	if (typeof args.count === "number") {
		out += theme.fg("dim", ` (${args.count} results)`);
	}
	if (isPartial) out += `  ${theme.fg("warning", "⠸ searching…")}`;
	return out;
}

export function webSearchCollapsedText(
	details: WebSearchToolDetails,
	theme: ThemeLike,
): string {
	const count = details.results?.length ?? 0;
	let line = `${theme.fg("success", "✓")} ${theme.fg("muted", `${count} result${count === 1 ? "" : "s"}`)}`;
	if (details.provider) line += theme.fg("muted", ` · ${details.provider}`);
	line += ` ${theme.fg("dim", `(${keyHint("app.tools.expand", "to expand")})`)}`;
	return line;
}

export function webSearchExpandedLines(results: WebSearchResultItem[], theme: ThemeLike): string[] {
	if (results.length === 0) {
		return [theme.fg("muted", "No results.")];
	}
	const lines: string[] = [];
	results.forEach((r, i) => {
		lines.push(` ${theme.fg("accent", `${i + 1}. ${truncateText(r.title ?? "(untitled)", 90)}`)}`);
		if (r.url) lines.push(`   ${theme.fg("dim", truncateText(r.url, 92))}`);
		if (r.snippet) lines.push(`   ${theme.fg("muted", truncateText(r.snippet, 110))}`);
	});
	return lines;
}

// ============================================================================
// Tool definitions
// ============================================================================

export interface WebSearchToolDetails {
	provider?: string;
	query?: string;
	// Full result items (title/url/snippet) — details are the session-persisted
	// state, so the expanded renderer rebuilds from here, not live memory.
	results?: WebSearchResultItem[];
	rawText?: string;
	bytes?: number;
	fullOutputPath?: string;
	error?: string;
}

export interface WebToolBuildDeps {
	client: LunarouteMcpClient;
	/** Server-side MCP tool name (resolved from tools/list, not assumed). */
	mcpToolName: string;
}

const webSearchSchema = Type.Object({
	query: Type.String({ description: "Search query" }),
	count: Type.Optional(
		Type.Number({ minimum: 1, maximum: 20, description: "Number of results to return (server default applies)" }),
	),
	provider: Type.Optional(
		Type.String({ description: "Optional search provider override (as supported by the server)" }),
	),
});

export function buildWebSearchTool(deps: WebToolBuildDeps): ToolDefinition<typeof webSearchSchema, WebSearchToolDetails> {
	return {
		name: "web_search",
		label: "Web Search",
		description:
			"Search the web through LunaRoute. Returns normalized results (title, url, snippet, date). " +
			"Issue multiple web_search calls in one message to run searches in parallel.",
		promptSnippet: "Search the web via LunaRoute and return normalized results with sources",
		promptGuidelines: [
			"Use web_search for web research; issue multiple web_search calls in a single message to run them in parallel.",
		],
		parameters: webSearchSchema,
		async execute(_toolCallId, params, signal, onUpdate) {
			onUpdate?.({ content: [{ type: "text", text: "Searching the web via LunaRoute…" }], details: {} });
			const call = await deps.client.callTool(
				deps.mcpToolName,
				{ query: params.query, count: params.count, provider: params.provider },
				signal,
			);
			const payload = parseWebSearchPayload(call.content?.[0]?.text ?? "");
			const formatted = formatWebSearchForModel(payload);
			const { text, truncated } = truncateForModel(formatted);
			let fullOutputPath: string | undefined;
			if (truncated) {
				try {
					fullOutputPath = await spillFullOutput(formatted);
				} catch {
					// Spill is best-effort; the truncated text still goes out.
				}
			}
			const textWithNote = truncated
				? `${text}\n\n[Output truncated. Full results saved to: ${fullOutputPath ?? "temp file unavailable"}]`
				: text;
			const details: WebSearchToolDetails = {
				provider: payload.provider,
				query: payload.query || params.query,
				results: payload.results,
				rawText: payload.rawText,
				bytes: Buffer.byteLength(textWithNote, "utf8"),
				fullOutputPath,
			};
			return {
				content: [{ type: "text", text: textWithNote }],
				details,
			};
		},
		renderCall(args, theme, context) {
			return new Text(webSearchCallText(args, theme, context.isPartial), 0, 0);
		},
		renderResult(result, options, theme) {
			const details = (result.details ?? {}) as WebSearchToolDetails;
			if (options.isPartial) {
				return new Text(theme.fg("warning", "⠸ searching the web…"), 0, 0);
			}
			if (details.error) {
				return new Text(theme.fg("error", `✗ ${details.error}`), 0, 0);
			}
			if (!options.expanded) {
				return new Text(webSearchCollapsedText(details, theme), 0, 0);
			}
			// Expanded view rebuilds from details — the session-persisted
			// state (title/url/snippet per result), not live memory.
			if (details.rawText !== undefined) {
				return new Text(theme.fg("toolOutput", truncateText(details.rawText, 400)), 0, 0);
			}
			const lines = webSearchExpandedLines(details.results ?? [], theme);
			return new Text(lines.join("\n") || theme.fg("muted", "No results."), 0, 0);
		},
	};
}

// web_fetch is registered only when the hosted MCP server actually offers a
// fetch tool (it does not as of 2026-09-08 — tools/list gates registration).
// The server-side contract is therefore still open (kata akyg); the Pi-side
// schema below is the minimal expected shape and is a passthrough.
const webFetchSchema = Type.Object({
	url: Type.String({ description: "URL to fetch" }),
});

export interface WebFetchToolDetails {
	url?: string;
	bytes?: number;
	fullOutputPath?: string;
	error?: string;
}

export function buildWebFetchTool(deps: WebToolBuildDeps): ToolDefinition<typeof webFetchSchema, WebFetchToolDetails> {
	return {
		name: "web_fetch",
		label: "Web Fetch",
		description: "Fetch a web page as text via LunaRoute.",
		promptSnippet: "Fetch a web page via LunaRoute",
		parameters: webFetchSchema,
		async execute(_toolCallId, params, signal, onUpdate) {
			onUpdate?.({ content: [{ type: "text", text: `Fetching ${params.url} via LunaRoute…` }], details: {} });
			const call = await deps.client.callTool(deps.mcpToolName, { url: params.url }, signal);
			const text = call.content?.map((c) => c.text ?? "").join("\n") ?? "";
			const { text: capped, truncated } = truncateForModel(text);
			let fullOutputPath: string | undefined;
			if (truncated) {
				try {
					fullOutputPath = await spillFullOutput(text);
				} catch {
					// Best-effort.
				}
			}
			const out = truncated
				? `${capped}\n\n[Output truncated. Full content saved to: ${fullOutputPath ?? "temp file unavailable"}]`
				: capped;
			return {
				content: [{ type: "text", text: out }],
				details: { url: params.url, bytes: Buffer.byteLength(out, "utf8"), fullOutputPath },
			};
		},
		renderCall(args, theme, context) {
			const label = theme.fg("toolTitle", theme.bold("web_fetch"));
			let out = `${label} ${theme.fg("dim", truncateText(args.url ?? "", 80))}`;
			if (context.isPartial) out += `  ${theme.fg("warning", "⠸ fetching…")}`;
			return new Text(out, 0, 0);
		},
		renderResult(result, options, theme) {
			const details = (result.details ?? {}) as WebFetchToolDetails;
			if (options.isPartial) {
				return new Text(theme.fg("warning", "⠸ fetching…"), 0, 0);
			}
			if (details.error) {
				return new Text(theme.fg("error", `✗ ${details.error}`), 0, 0);
			}
			const kb = details.bytes ? ` · ${(details.bytes / 1024).toFixed(1)} KB` : "";
			if (!options.expanded) {
				return new Text(
					`${theme.fg("success", "✓")}${theme.fg("muted", `${kb}`)} ${theme.fg("dim", `(${keyHint("app.tools.expand", "to expand")})`)}`,
					0,
					0,
				);
			}
			return new Text(
				[
					theme.fg("dim", details.url ?? ""),
					details.fullOutputPath ? theme.fg("muted", `full content: ${details.fullOutputPath}`) : "",
				]
					.filter(Boolean)
					.join("\n"),
				0,
				0,
			);
		},
	};
}

// ============================================================================
// Registration orchestrator
// ============================================================================

export const LUNAROUTE_ENV_WEB_TOOLS = "LUNAROUTE_WEB_TOOLS";
export const LUNAROUTE_ENV_MCP_WEB_SEARCH_TOOL = "LUNAROUTE_MCP_WEB_SEARCH_TOOL";
export const LUNAROUTE_ENV_MCP_WEB_FETCH_TOOL = "LUNAROUTE_MCP_WEB_FETCH_TOOL";

export type WebToolOutcome = "registered" | "skipped-existing" | "skipped-server" | "skipped-disabled";

export interface WebToolsRegistration {
	webSearch: WebToolOutcome;
	webFetch: WebToolOutcome;
	/** Non-fatal transport/registration error, for diagnostics. */
	error?: string;
}

export interface RegisterWebToolsDeps {
	key: string;
	env: NodeJS.ProcessEnv;
	version: string;
	sessionId: string;
	fetchImpl?: FetchLike;
}

function webToolsDisabled(env: NodeJS.ProcessEnv): boolean {
	const v = env[LUNAROUTE_ENV_WEB_TOOLS];
	return v === "off" || v === "0" || v === "false";
}

/** Pick the server-side MCP tool backing a Pi web tool: an explicit env
 * override wins (exact name), otherwise the first tools/list match. */
function pickServerTool(
	serverTools: string[],
	patterns: RegExp[],
	override: string | undefined,
): string | undefined {
	if (override) return serverTools.includes(override) ? override : undefined;
	return serverTools.find((n) => matchesAnyPattern(n, patterns));
}

/** Register first-class web tools when they are both missing locally and
 * offered by the hosted LunaRoute MCP server. Never throws — web tools are
 * optional, exactly like the MCP registration. */
export async function registerWebTools(
	pi: ExtensionAPI,
	deps: RegisterWebToolsDeps,
): Promise<WebToolsRegistration> {
	const disabled = webToolsDisabled(deps.env);
	if (disabled) {
		return { webSearch: "skipped-disabled", webFetch: "skipped-disabled" };
	}

	const presence = detectWebTools(pi.getAllTools().map((t) => t.name));
	const needSearch = !presence.hasWebSearch;
	const needFetch = !presence.hasWebFetch;
	if (!needSearch && !needFetch) {
		return { webSearch: "skipped-existing", webFetch: "skipped-existing" };
	}

	const client = createLunarouteMcpClient({
		url: resolveMcpUrl(deps.env),
		headers: {
			"LUNAROUTE-API-KEY": deps.key,
			...buildAttributionHeaders(deps.version, deps.sessionId),
		},
		fetchImpl: deps.fetchImpl ?? (fetch as FetchLike),
	});

	let serverTools: string[];
	try {
		serverTools = await client.listTools();
	} catch (err) {
		// Server unreachable / auth rejected: stay silent, try again on the
		// next session_start (reload, resume, fork all re-fire it).
		return {
			webSearch: "skipped-server",
			webFetch: "skipped-server",
			error: err instanceof Error ? err.message : String(err),
		};
	}

	const searchTool = pickServerTool(
		serverTools,
		WEB_SEARCH_TOOL_PATTERNS,
		deps.env[LUNAROUTE_ENV_MCP_WEB_SEARCH_TOOL],
	);
	const fetchTool = pickServerTool(
		serverTools,
		WEB_FETCH_TOOL_PATTERNS,
		deps.env[LUNAROUTE_ENV_MCP_WEB_FETCH_TOOL],
	);

	const outcome = (need: boolean, serverTool: string | undefined): WebToolOutcome =>
		!need ? "skipped-existing" : serverTool ? "registered" : "skipped-server";
	const registration: WebToolsRegistration = {
		webSearch: outcome(needSearch, searchTool),
		webFetch: outcome(needFetch, fetchTool),
	};

	const register = <TParams extends TSchema, TDetails, TState>(
		tool: ToolDefinition<TParams, TDetails, TState>,
	): void => {
		pi.registerTool(tool);
		// Tools registered after startup are refreshed immediately, but the
		// active set does not change on its own — merge ours in explicitly.
		const active = pi.getActiveTools();
		if (!active.includes(tool.name)) {
			pi.setActiveTools([...new Set([...active, tool.name])]);
		}
	};

	try {
		if (needSearch && searchTool) register(buildWebSearchTool({ client, mcpToolName: searchTool }));
		if (needFetch && fetchTool) register(buildWebFetchTool({ client, mcpToolName: fetchTool }));
	} catch (err) {
		return {
			...registration,
			error: err instanceof Error ? err.message : String(err),
		};
	}

	return registration;
}
