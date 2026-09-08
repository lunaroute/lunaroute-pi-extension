import { initTheme, type ExtensionAPI, type Theme, type ThemeColor } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { describe, expect, test, vi } from "vitest";
import {
	buildWebFetchTool,
	buildWebSearchTool,
	createLunarouteMcpClient,
	detectWebTools,
	formatWebSearchForModel,
	parseSseData,
	parseWebSearchPayload,
	registerWebTools,
	spillFullOutput,
	truncateForModel,
	webSearchCallText,
	webSearchCollapsedText,
	webSearchExpandedLines,
	type FetchLike,
	type LunarouteMcpClient,
	type WebSearchPayload,
} from "../src/web-tools.js";

// ============================================================================
// Helpers
// ============================================================================

// keyHint reads pi's global theme — initialize it like the TUI host does.
initTheme("dark");

const theme = {
	fg: (_color: ThemeColor, text: string) => text,
	bold: (text: string) => `*${text}*`,
};

/** Renderers only use fg/bold — the stub satisfies that subset. */
const renderTheme = theme as unknown as Theme;

/** Render a component to plain text for assertions. */
function renderText(component: unknown, width = 200): string {
	return (component as Text).render(width).join("\n");
}

function jsonResponse(payload: unknown, status = 200): Response {
	return new Response(JSON.stringify(payload), {
		status,
		headers: { "content-type": "application/json" },
	});
}

function sseResponse(frames: unknown[], status = 200): Response {
	const body = frames.map((f) => `data: ${JSON.stringify(f)}\n\n`).join("");
	return new Response(body, {
		status,
		headers: { "content-type": "text/event-stream" },
	});
}

/** Scripted JSON-RPC server: routes by method, records requests. */
function mcpFetch(
	routes: Record<string, (body: { id: number; params?: unknown }) => unknown>,
	log?: { method: string; params?: unknown }[],
): FetchLike {
	return async (_url: string, init?: RequestInit) => {
		const body = JSON.parse(String(init?.body)) as { id: number; method: string; params?: unknown };
		log?.push({ method: body.method, params: body.params });
		const route = routes[body.method];
		if (!route) return jsonResponse({ jsonrpc: "2.0", id: body.id, error: { message: `no route: ${body.method}` } }, 404);
		return jsonResponse({ jsonrpc: "2.0", id: body.id, result: route(body) });
	};
}

const TOOLS_LIST_WITH_SEARCH = {
	tools: [{ name: "generate_image" }, { name: "web_search" }],
};

interface FakePiOptions {
	toolNames?: string[];
	activeTools?: string[];
}

function fakePi(options: FakePiOptions = {}) {
	const registered: { name: string; execute?: unknown; renderCall?: unknown; renderResult?: unknown }[] = [];
	const toolNames = [...(options.toolNames ?? [])];
	let active = [...(options.activeTools ?? ["read", "bash"])];
	const pi = {
		registerTool: vi.fn((tool: { name: string }) => {
			registered.push(tool);
			toolNames.push(tool.name);
		}),
		getAllTools: vi.fn(() => toolNames.map((name) => ({ name }))),
		getActiveTools: vi.fn(() => [...active]),
		setActiveTools: vi.fn((names: string[]) => {
			active = [...names];
		}),
	};
	return { pi: pi as unknown as ExtensionAPI, registered, toolNames, getActive: () => [...active] };
}

function fakeClient(
	callResultText: string,
	capture?: { name?: string; args?: Record<string, unknown> },
): LunarouteMcpClient {
	return {
		listTools: vi.fn(async () => ["web_search"]),
		callTool: vi.fn(async (name: string, args: Record<string, unknown>) => {
			if (capture) {
				capture.name = name;
				capture.args = args;
			}
			return { content: [{ type: "text", text: callResultText }] };
		}),
	};
}

const PAYLOAD_TEXT = JSON.stringify({
	query: "pi extension",
	provider: "brave",
	results: [
		{ title: "Pi extensions docs", url: "https://example.com/docs", snippet: "All about extensions.", published_date: null, score: 0.9 },
		{ title: "npm pi", url: "https://example.com/npm", snippet: null, published_date: "2026-08-01", score: null },
	],
});

// ============================================================================
// Detection
// ============================================================================

describe("detectWebTools", () => {
	test("no tools means both missing", () => {
		expect(detectWebTools(["read", "bash", "grep"])).toEqual({ hasWebSearch: false, hasWebFetch: false });
	});

	test("detects pi-web-access names (web_search, fetch_content)", () => {
		expect(detectWebTools(["read", "web_search", "fetch_content"])).toEqual({
			hasWebSearch: true,
			hasWebFetch: true,
		});
	});

	test("detects pi-web-search names (web_search, url_context)", () => {
		expect(detectWebTools(["url_context"])).toEqual({ hasWebSearch: false, hasWebFetch: true });
		expect(detectWebTools(["websearch"])).toEqual({ hasWebSearch: true, hasWebFetch: false });
	});

	test("detects reversed and prefixed forms (adapter directTools)", () => {
		expect(detectWebTools(["search_web"])).toEqual({ hasWebSearch: true, hasWebFetch: false });
		expect(detectWebTools(["lunaroute_web_search"])).toEqual({ hasWebSearch: true, hasWebFetch: false });
		expect(detectWebTools(["parallel_web_fetch"])).toEqual({ hasWebSearch: false, hasWebFetch: true });
	});

	test("unrelated tools with similar words do not match", () => {
		expect(detectWebTools(["webserver_status", "fetchmail_config", "context_builder"])).toEqual({
			hasWebSearch: false,
			hasWebFetch: false,
		});
	});
});

// ============================================================================
// MCP client
// ============================================================================

describe("createLunarouteMcpClient", () => {
	test("listTools sends initialize, initialized, then tools/list and returns names", async () => {
		const log: { method: string; params?: unknown }[] = [];
		const fetchImpl = mcpFetch(
			{
				initialize: () => ({ capabilities: { tools: {} } }),
				"notifications/initialized": () => undefined,
				"tools/list": () => TOOLS_LIST_WITH_SEARCH,
			},
			log,
		);
		const client = createLunarouteMcpClient({ url: "https://mcp.test/mcp", headers: {}, fetchImpl });
		const tools = await client.listTools();
		expect(tools).toEqual(["generate_image", "web_search"]);
		expect(log.map((l) => l.method)).toEqual(["initialize", "notifications/initialized", "tools/list"]);
		// Second call reuses the initialized session (no re-handshake).
		log.length = 0;
		await client.listTools();
		expect(log.map((l) => l.method)).toEqual(["tools/list"]);
	});

	test("callTool posts tools/call with name and arguments, returns the MCP result", async () => {
		const log: { method: string; params?: unknown }[] = [];
		const fetchImpl = mcpFetch(
			{
				initialize: () => ({}),
				"notifications/initialized": () => undefined,
				"tools/call": () => ({ content: [{ type: "text", text: PAYLOAD_TEXT }], isError: false }),
			},
			log,
		);
		const client = createLunarouteMcpClient({ url: "https://mcp.test/mcp", headers: {}, fetchImpl });
		const result = await client.callTool("web_search", { query: "pi extension" });
		expect(result.content[0]?.text).toBe(PAYLOAD_TEXT);
		const call = log.find((l) => l.method === "tools/call");
		expect(call?.params).toEqual({ name: "web_search", arguments: { query: "pi extension" } });
	});

	test("initialize failure is tolerated (stateless servers) and tools/call still works", async () => {
		const log: { method: string; params?: unknown }[] = [];
		const fetchImpl: FetchLike = async (_url, init) => {
			const body = JSON.parse(String(init?.body)) as { id: number; method: string };
			log.push({ method: body.method });
			if (body.method === "initialize") return jsonResponse({}, 500);
			if (body.method === "notifications/initialized") return jsonResponse({}, 202);
			return jsonResponse({
				jsonrpc: "2.0",
				id: body.id,
				result: { tools: [{ name: "web_search" }] },
			});
		};
		const client = createLunarouteMcpClient({ url: "https://mcp.test/mcp", headers: {}, fetchImpl });
		await expect(client.listTools()).resolves.toEqual(["web_search"]);
		const methods = log.map((l) => l.method);
		expect(methods).toContain("initialize");
		expect(methods).not.toContain("notifications/initialized");
	});

	test("SSE-framed responses are decoded", async () => {
		// Every request answers over SSE, leading with an unrelated
		// notification frame; the decoder must pick the frame matching the id.
		const fetchImpl: FetchLike = async (_url, init) => {
			const body = JSON.parse(String(init?.body)) as { id: number; method: string };
			return sseResponse([
				{ jsonrpc: "2.0", method: "notifications/message", params: { level: "info" } },
				{ jsonrpc: "2.0", id: body.id, result: { tools: [{ name: "web_search" }] } },
			]);
		};
		const client = createLunarouteMcpClient({ url: "https://mcp.test/mcp", headers: {}, fetchImpl });
		await expect(client.listTools()).resolves.toEqual(["web_search"]);
	});

	test("JSON-RPC errors throw with the server message", async () => {
		const fetchImpl: FetchLike = async () =>
			jsonResponse({ jsonrpc: "2.0", id: 1, error: { code: -32000, message: "org has no web tools" } });
		const client = createLunarouteMcpClient({ url: "https://mcp.test/mcp", headers: {}, fetchImpl });
		await expect(client.listTools()).rejects.toThrow("org has no web tools");
	});

	test("HTTP error statuses throw", async () => {
		const fetchImpl: FetchLike = async () => jsonResponse({}, 401);
		const client = createLunarouteMcpClient({ url: "https://mcp.test/mcp", headers: {}, fetchImpl });
		await expect(client.listTools()).rejects.toThrow("HTTP 401");
	});

	test("isError tool results throw with the tool text", async () => {
		const fetchImpl: FetchLike = async () =>
			jsonResponse({
				jsonrpc: "2.0",
				id: 1,
				result: { content: [{ type: "text", text: "search provider unavailable" }], isError: true },
			});
		const client = createLunarouteMcpClient({ url: "https://mcp.test/mcp", headers: {}, fetchImpl });
		await expect(client.callTool("web_search", { query: "x" })).rejects.toThrow("search provider unavailable");
	});
});

describe("parseSseData", () => {
	test("extracts data payloads in order, skipping junk", () => {
		const body = ": comment\ndata: {\"a\":1}\n\ndata: [DONE]\n\ndata: not-json\n";
		expect(parseSseData(body)).toEqual([{ a: 1 }]);
	});
});

// ============================================================================
// Payload parsing and formatting
// ============================================================================

describe("parseWebSearchPayload", () => {
	test("parses the normalized payload", () => {
		const payload = parseWebSearchPayload(PAYLOAD_TEXT);
		expect(payload.provider).toBe("brave");
		expect(payload.results).toHaveLength(2);
		expect(payload.results[0]?.title).toBe("Pi extensions docs");
	});

	test("non-JSON text is kept as rawText", () => {
		const payload = parseWebSearchPayload("plain text answer");
		expect(payload.rawText).toBe("plain text answer");
		expect(payload.results).toEqual([]);
	});

	test("missing fields default safely", () => {
		const payload = parseWebSearchPayload("{}");
		expect(payload).toEqual({ query: "", provider: "", results: [] });
	});
});

describe("formatWebSearchForModel", () => {
	test("formats numbered results with urls and snippets", () => {
		const payload = parseWebSearchPayload(PAYLOAD_TEXT);
		const text = formatWebSearchForModel(payload);
		expect(text).toContain('Web search for "pi extension" via brave — 2 result(s):');
		expect(text).toContain("1. Pi extensions docs");
		expect(text).toContain("https://example.com/docs");
		expect(text).toContain("All about extensions.");
		expect(text).toContain("published: 2026-08-01");
	});

	test("empty results produce an explicit no-results line", () => {
		const text = formatWebSearchForModel({ query: "nothing", provider: "brave", results: [] });
		expect(text).toBe('No results for "nothing" (provider: brave).');
	});

	test("rawText passes through untouched", () => {
		expect(formatWebSearchForModel({ query: "", provider: "", results: [], rawText: "raw" })).toBe("raw");
	});
});

describe("truncateForModel", () => {
	test("short text passes through", () => {
		expect(truncateForModel("hello")).toEqual({ text: "hello", truncated: false });
	});

	test("oversized text is truncated with the flag set", () => {
		const big = "line of search results\n".repeat(3000);
		const { text, truncated } = truncateForModel(big);
		expect(truncated).toBe(true);
		expect(text.length).toBeLessThan(big.length);
	});
});

describe("spillFullOutput", () => {
	test("writes the full text to a unique temp path", async () => {
		const writes: { path: string; data: string }[] = [];
		const path = await spillFullOutput("full content", {
			writeFile: async (p, d) => {
				writes.push({ path: p, data: d });
			},
			tmpdir: () => "/tmp",
			randomUUID: () => "fixed-id",
		});
		expect(path).toBe("/tmp/lunaroute-web-fixed-id.txt");
		expect(writes).toEqual([{ path, data: "full content" }]);
	});
});

// ============================================================================
// web_search tool
// ============================================================================

describe("buildWebSearchTool", () => {
	const deps = { client: fakeClient(PAYLOAD_TEXT), mcpToolName: "web_search" };

	test("definition shape: name, snippet, guidelines, parallel nudge", () => {
		const tool = buildWebSearchTool(deps);
		expect(tool.name).toBe("web_search");
		expect(tool.label).toBe("Web Search");
		expect(tool.promptSnippet).toBeTruthy();
		expect(tool.promptGuidelines?.[0]).toContain("parallel");
	});

	test("execute maps params to the MCP tool and formats the payload", async () => {
		const capture: { name?: string; args?: Record<string, unknown> } = {};
		const onUpdate = vi.fn();
		const tool = buildWebSearchTool({ client: fakeClient(PAYLOAD_TEXT, capture), mcpToolName: "web_search" });
		const result = await tool.execute("tc_1", { query: "pi extension", count: 5, provider: "brave" }, undefined, onUpdate, {} as never);
		expect(capture.name).toBe("web_search");
		expect(capture.args).toEqual({ query: "pi extension", count: 5, provider: "brave" });
		expect(onUpdate).toHaveBeenCalled();
		const text = result.content[0];
		expect(text && text.type === "text" ? text.text : "").toContain("Pi extensions docs");
		const details = result.details as { provider?: string; results?: unknown[] };
		expect(details.provider).toBe("brave");
		expect(details.results).toHaveLength(2);
	});

	test("execute with no results returns an explicit empty message", async () => {
		const tool = buildWebSearchTool({
			client: fakeClient(JSON.stringify({ query: "x", provider: "brave", results: [] })),
			mcpToolName: "web_search",
		});
		const result = await tool.execute("tc_2", { query: "x" }, undefined, undefined, {} as never);
		const text = result.content[0];
		expect(text && text.type === "text" ? text.text : "").toContain("No results");
	});

	test("execute propagates client errors (pi marks the call isError)", async () => {
		const failing: LunarouteMcpClient = {
			listTools: async () => [],
			callTool: async () => {
				throw new Error("provider unavailable");
			},
		};
		const tool = buildWebSearchTool({ client: failing, mcpToolName: "web_search" });
		await expect(tool.execute("tc_3", { query: "x" }, undefined, undefined, {} as never)).rejects.toThrow(
			"provider unavailable",
		);
	});

	test("renderCall shows the query, count, and a spinner while partial", () => {
		const tool = buildWebSearchTool(deps);
		const partial = tool.renderCall?.({ query: "pi extension", count: 5 }, renderTheme, { isPartial: true } as never) as Text;
		expect(renderText(partial)).toContain("*web_search*");
		expect(renderText(partial)).toContain('"pi extension"');
		expect(renderText(partial)).toContain("(5 results)");
		expect(renderText(partial)).toContain("searching");
		const done = tool.renderCall?.({ query: "q" }, renderTheme, { isPartial: false } as never) as Text;
		expect(renderText(done)).not.toContain("searching");
	});

	test("renderResult collapsed shows result count and provider", () => {
		const tool = buildWebSearchTool(deps);
		const component = tool.renderResult?.(
			{ content: [], details: { provider: "brave", results: [{ title: "t", url: "u" }] } } as never,
			{ expanded: false, isPartial: false },
			renderTheme,
			{} as never,
		) as Text;
		expect(renderText(component)).toContain("✓");
		expect(renderText(component)).toContain("1 result");
		expect(renderText(component)).toContain("brave");
		expect(renderText(component)).toContain("to expand");
	});

	test("renderResult expanded lists titles, urls, and snippets", () => {
		const tool = buildWebSearchTool(deps);
		const payload = parseWebSearchPayload(PAYLOAD_TEXT);
		const component = tool.renderResult?.(
			{ content: [], details: { provider: "brave", results: payload.results } } as never,
			{ expanded: true, isPartial: false },
			renderTheme,
			{} as never,
		) as Text;
		const text = renderText(component);
		expect(text).toContain("1. Pi extensions docs");
		expect(text).toContain("https://example.com/docs");
		expect(text).toContain("All about extensions.");
		expect(text).toContain("2. npm pi");
	});

	test("renderResult handles partial and error states", () => {
		const tool = buildWebSearchTool(deps);
		const partial = tool.renderResult?.({ content: [], details: {} } as never, { expanded: false, isPartial: true }, renderTheme, {} as never) as Text;
		expect(renderText(partial)).toContain("searching");
		const error = tool.renderResult?.(
			{ content: [], details: { error: "boom" } } as never,
			{ expanded: false, isPartial: false },
			renderTheme,
			{} as never,
		) as Text;
		expect(renderText(error)).toContain("✗ boom");
	});
});

// ============================================================================
// web_fetch tool
// ============================================================================

describe("buildWebFetchTool", () => {
	test("execute passes the url through and returns the text", async () => {
		const capture: { name?: string; args?: Record<string, unknown> } = {};
		const tool = buildWebFetchTool({ client: fakeClient("# Page content", capture), mcpToolName: "web_fetch" });
		const result = await tool.execute("tc_1", { url: "https://example.com" }, undefined, undefined, {} as never);
		expect(capture.name).toBe("web_fetch");
		expect(capture.args).toEqual({ url: "https://example.com" });
		const text = result.content[0];
		expect(text && text.type === "text" ? text.text : "").toBe("# Page content");
		expect((result.details as { url?: string }).url).toBe("https://example.com");
	});

	test("execute spills oversized output and tells the model where it is", async () => {
		const huge = "x".repeat(80 * 1024);
		const tool = buildWebFetchTool({ client: fakeClient(huge), mcpToolName: "web_fetch" });
		const result = await tool.execute("tc_2", { url: "https://example.com/big" }, undefined, undefined, {} as never);
		const text = result.content[0];
		const out = text && text.type === "text" ? text.text : "";
		expect(out).toContain("[Output truncated.");
		expect(out).toContain("Full content saved to:");
		expect((result.details as { fullOutputPath?: string }).fullOutputPath).toBeTruthy();
	});
});

// ============================================================================
// Renderer pure builders
// ============================================================================

describe("renderer builders", () => {
	test("webSearchCallText truncates long queries", () => {
		const out = webSearchCallText({ query: "a".repeat(100) }, theme, false);
		expect(out).toContain("…");
		expect(out).not.toContain("a".repeat(70));
	});

	test("webSearchCollapsedText pluralizes and omits provider when absent", () => {
		expect(webSearchCollapsedText({ results: [{}, {}] }, theme)).toContain("2 results");
		expect(webSearchCollapsedText({ results: [{}] }, theme)).toContain("1 result");
		expect(webSearchCollapsedText({ results: [] }, theme)).not.toContain("·");
	});

	test("webSearchExpandedLines handles empty results", () => {
		expect(webSearchExpandedLines([], theme)).toEqual(["No results."]);
	});
});

// ============================================================================
// Registration orchestrator
// ============================================================================

const REG_DEPS = {
	key: "lr_test_key",
	env: {} as NodeJS.ProcessEnv,
	version: "0.5.0-test",
	sessionId: "session-1",
};

describe("registerWebTools", () => {
	test("does nothing when disabled via LUNAROUTE_WEB_TOOLS", async () => {
		const { pi, registered } = fakePi();
		const fetchImpl = vi.fn();
		const result = await registerWebTools(pi, {
			...REG_DEPS,
			env: { LUNAROUTE_WEB_TOOLS: "off" },
			fetchImpl: fetchImpl as unknown as FetchLike,
		});
		expect(result).toEqual({ webSearch: "skipped-disabled", webFetch: "skipped-disabled" });
		expect(fetchImpl).not.toHaveBeenCalled();
		expect(registered).toHaveLength(0);
	});

	test("skips without any network call when both tools already exist locally", async () => {
		const { pi, registered } = fakePi({ toolNames: ["web_search", "fetch_content"] });
		const fetchImpl = vi.fn();
		const result = await registerWebTools(pi, { ...REG_DEPS, fetchImpl: fetchImpl as unknown as FetchLike });
		expect(result).toEqual({ webSearch: "skipped-existing", webFetch: "skipped-existing" });
		expect(fetchImpl).not.toHaveBeenCalled();
		expect(registered).toHaveLength(0);
	});

	test("registers web_search when the server offers it; web_fetch stays skipped (server has none)", async () => {
		const { pi, registered, getActive } = fakePi();
		const fetchImpl = mcpFetch({
			initialize: () => ({}),
			"notifications/initialized": () => undefined,
			"tools/list": () => TOOLS_LIST_WITH_SEARCH,
		});
		const result = await registerWebTools(pi, { ...REG_DEPS, fetchImpl });
		expect(result.webSearch).toBe("registered");
		expect(result.webFetch).toBe("skipped-server");
		expect(registered.map((t) => t.name)).toEqual(["web_search"]);
		expect(getActive()).toContain("web_search");
		expect(getActive()).toContain("read"); // existing actives preserved
	});

	test("registers web_fetch too when the server offers one", async () => {
		const { pi, registered } = fakePi();
		const fetchImpl = mcpFetch({
			initialize: () => ({}),
			"notifications/initialized": () => undefined,
			"tools/list": () => ({ tools: [{ name: "web_search" }, { name: "web_fetch" }] }),
		});
		const result = await registerWebTools(pi, { ...REG_DEPS, fetchImpl });
		expect(result).toEqual({ webSearch: "registered", webFetch: "registered" });
		expect(registered.map((t) => t.name)).toEqual(["web_search", "web_fetch"]);
	});

	test("skips only the tool that exists locally, registers the other", async () => {
		const { pi, registered } = fakePi({ toolNames: ["web_search"] });
		const fetchImpl = mcpFetch({
			initialize: () => ({}),
			"notifications/initialized": () => undefined,
			"tools/list": () => ({ tools: [{ name: "web_search" }, { name: "web_fetch" }] }),
		});
		const result = await registerWebTools(pi, { ...REG_DEPS, fetchImpl });
		expect(result.webSearch).toBe("skipped-existing");
		expect(result.webFetch).toBe("registered");
		expect(registered.map((t) => t.name)).toEqual(["web_fetch"]);
	});

	test("an unreachable server skips registration silently with an error recorded", async () => {
		const { pi, registered } = fakePi();
		const fetchImpl: FetchLike = async () => {
			throw new Error("network down");
		};
		const result = await registerWebTools(pi, { ...REG_DEPS, fetchImpl });
		expect(result.webSearch).toBe("skipped-server");
		expect(result.webFetch).toBe("skipped-server");
		expect(result.error).toContain("network down");
		expect(registered).toHaveLength(0);
	});

	test("env override pins the server tool name (exact match required)", async () => {
		const { pi, registered } = fakePi();
		const fetchImpl = mcpFetch({
			initialize: () => ({}),
			"notifications/initialized": () => undefined,
			"tools/list": () => ({ tools: [{ name: "custom_search" }] }),
		});
		const result = await registerWebTools(pi, {
			...REG_DEPS,
			env: { LUNAROUTE_MCP_WEB_SEARCH_TOOL: "custom_search" },
			fetchImpl,
		});
		// custom_search does not match the web-search patterns on its own;
		// the override makes it the backing tool for the web_search Pi tool.
		expect(result.webSearch).toBe("registered");
		expect(result.webFetch).toBe("skipped-server");
		expect(registered.map((t) => t.name)).toEqual(["web_search"]);
	});

	test("an override naming a tool the server does not have is ignored", async () => {
		const { pi, registered } = fakePi();
		const fetchImpl = mcpFetch({
			initialize: () => ({}),
			"notifications/initialized": () => undefined,
			"tools/list": () => ({ tools: [{ name: "web_search" }] }),
		});
		const result = await registerWebTools(pi, {
			...REG_DEPS,
			env: { LUNAROUTE_MCP_WEB_FETCH_TOOL: "not_there" },
			fetchImpl,
		});
		expect(result.webFetch).toBe("skipped-server");
		expect(registered.map((t) => t.name)).toEqual(["web_search"]);
	});

	test("second invocation is a no-op once our own tool is registered", async () => {
		const { pi } = fakePi();
		const fetchImpl = mcpFetch({
			initialize: () => ({}),
			"notifications/initialized": () => undefined,
			"tools/list": () => TOOLS_LIST_WITH_SEARCH,
		});
		await registerWebTools(pi, { ...REG_DEPS, fetchImpl });
		const again = await registerWebTools(pi, { ...REG_DEPS, fetchImpl });
		expect(again.webSearch).toBe("skipped-existing");
	});
});
