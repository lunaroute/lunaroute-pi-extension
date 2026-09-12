import type { ExtensionAPI, ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import type { Api, Model, OAuthLoginCallbacks, RefreshModelsContext } from "@earendil-works/pi-ai";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { LUNAROUTE_PROVIDER, firstRunHint } from "../src/lunaroute.js";
import { _resetImageToolsState } from "../src/image-tools.js";
import { _resetConvertToolsState } from "../src/convert-tools.js";
import { _resetAdapterNoticeState, _setAdapterInstalledOverride, ADAPTER_MIGRATION_NOTICE } from "../src/index.js";
import lunarouteExtension from "../src/index.js";

type SessionHandler = (event: unknown, ctx: FakeContext) => void | Promise<void>;

type FakeContext = {
  hasUI: boolean;
  model?: Model<Api> | undefined;
  modelRegistry: {
    getApiKeyForProvider: (provider: string) => Promise<string | undefined>;
  };
  ui: { notify: ReturnType<typeof vi.fn> };
};

type Bus = {
  emit(channel: string, data: unknown): void;
  on(channel: string, handler: (data: unknown) => void): () => void;
};

function fakeEventBus(): Bus {
  const handlers = new Map<string, Set<(data: unknown) => void>>();
  return {
    emit(channel: string, data: unknown) {
      handlers.get(channel)?.forEach((h) => h(data));
    },
    on(channel: string, handler: (data: unknown) => void) {
      let set = handlers.get(channel);
      if (!set) {
        set = new Set();
        handlers.set(channel, set);
      }
      set.add(handler);
      return () => set!.delete(handler);
    },
  };
}

function fakePi(options: { toolNames?: string[] } = {}) {
  const handlers = new Map<string, SessionHandler>();
  const registerProvider = vi.fn();
  const setModel = vi.fn(async (_model: unknown) => true);
  const events = fakeEventBus();
  const on = vi.fn((name: string, handler: SessionHandler) => handlers.set(name, handler));
  const registeredTools: { name: string }[] = [];
  const toolNames = [...(options.toolNames ?? [])];
  let activeTools = ["read", "bash"];
  const registerTool = vi.fn((tool: { name: string }) => {
    registeredTools.push(tool);
    toolNames.push(tool.name);
  });
  const registerCommand = vi.fn();
  const getAllTools = vi.fn(() => toolNames.map((name) => ({ name })));
  const getActiveTools = vi.fn(() => [...activeTools]);
  const setActiveTools = vi.fn((names: string[]) => {
    activeTools = [...names];
  });
  const pi = {
    registerProvider,
    on,
    events,
    setModel,
    registerTool,
    registerCommand,
    getAllTools,
    getActiveTools,
    setActiveTools,
  } as unknown as ExtensionAPI;
  return { pi, registerProvider, setModel, on, handlers, events, registeredTools, toolNames, registerCommand, getActiveTools: () => [...activeTools] };
}

function fakeContext(overrides: Partial<FakeContext> = {}): FakeContext {
  return {
    hasUI: true,
    modelRegistry: {
      getApiKeyForProvider: () => Promise.resolve(undefined),
    },
    ui: { notify: vi.fn() },
    ...overrides,
  };
}

function pasteCallbacks(key: string): OAuthLoginCallbacks {
  return {
    onAuth: vi.fn(),
    onDeviceCode: vi.fn(),
    onPrompt: vi.fn(async () => key),
    onProgress: vi.fn(),
    onSelect: vi.fn(async () => "paste"),
    signal: undefined,
  } as unknown as OAuthLoginCallbacks;
}

describe("pi extension v2 wiring", () => {
  let agentDir: string;
  beforeEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    _resetAdapterNoticeState();
    // Hermetic agent dir (kata bjy9): readSettings in session_start must
    // never see the developer's real ~/.pi/agent/lunaroute.json.
    agentDir = mkdtempSync(join(tmpdir(), "lr-agent-"));
    vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
    // The hosted MCP server endpoint for first-class web tools (kata akyg):
    // default to an empty tools/list so keyed session_start tests stay hermetic.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { tools: [] } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })),
    );
  });

  test("registers the lunaroute provider with identity, auth, headers, refreshModels, and store-seeded models", () => {
    const { pi, registerProvider } = fakePi();
    vi.stubEnv("LUNAROUTE_ROUTING_URL", "http://gw/v1");
    vi.stubEnv("PI_CODING_AGENT_DIR", mkdtempSync(join(tmpdir(), "lr-store-")));

    lunarouteExtension(pi);

    expect(registerProvider).toHaveBeenCalledTimes(1);
    expect(registerProvider).toHaveBeenCalledWith(LUNAROUTE_PROVIDER, expect.any(Object));
    const [, config] = registerProvider.mock.calls[0] as [string, Record<string, unknown>];
    expect(config.name).toBe("LunaRoute");
    expect(config.baseUrl).toBe("http://gw/v1");
    expect(config.api).toBe("openai-completions");
    expect(config.authHeader).toBe(true);
    expect(config.models).toEqual([]);
    expect(config.oauth).toBeDefined();
    expect(typeof config.refreshModels).toBe("function");
  });

  test("seeds registration models from the persisted snapshot when present", () => {
    const { pi, registerProvider } = fakePi();
    const dir = mkdtempSync(join(tmpdir(), "lr-seed-"));
    const stored = { id: "glm-5.3-flash-background", api: "openai-completions", provider: "lunaroute", baseUrl: "https://gw/v1", reasoning: true, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
    writeFileSync(join(dir, "models-store.json"), JSON.stringify({ lunaroute: { models: [stored], checkedAt: 1 } }));
    vi.stubEnv("PI_CODING_AGENT_DIR", dir);

    lunarouteExtension(pi);
    const [, config] = registerProvider.mock.calls[0] as [string, Record<string, unknown>];
    expect(config.models).toEqual([stored]);
  });

  test("attribution headers share one session id and omit User-Agent", () => {
    const { pi, registerProvider } = fakePi();
    lunarouteExtension(pi);
    const config = registerProvider.mock.calls[0]?.[1] as Record<string, unknown>;
    const headers = config.headers as Record<string, string>;
    expect(headers["lunaroute-agent"]).toEqual(expect.stringMatching(/^pi\/\S+$/));
    expect(headers["x-lunaroute-session"]).toBe(headers["lunaroute-session-id"]);
    expect(headers["x-lunaroute-session"]).not.toBe("");
    expect(headers).not.toHaveProperty("User-Agent");
    expect(headers).not.toHaveProperty("user-agent");
  });

  test("registers session_start and model_select, and no session_shutdown (kata 4ws9)", () => {
    const { pi, on, handlers } = fakePi();
    lunarouteExtension(pi);
    expect(on).toHaveBeenCalledWith("session_start", expect.any(Function));
    expect(on).toHaveBeenCalledWith("model_select", expect.any(Function));
    expect(handlers.has("session_start")).toBe(true);
    // No adapter registration means nothing to dispose on shutdown.
    expect(handlers.has("session_shutdown")).toBe(false);
  });

  test("session_start notifies the first-run hint when no credential is configured", async () => {
    const { pi, handlers } = fakePi();
    lunarouteExtension(pi);
    const ctx = fakeContext({ modelRegistry: { getApiKeyForProvider: () => Promise.resolve(undefined) } });
    await handlers.get("session_start")?.({}, ctx);
    expect(ctx.ui.notify).toHaveBeenCalledWith(firstRunHint(), "info");
  });

  test("session_start is silent when logged in and the server offers nothing", async () => {
    const { pi, handlers } = fakePi();
    lunarouteExtension(pi);
    const ctx = fakeContext({
      modelRegistry: { getApiKeyForProvider: () => Promise.resolve("lr_key") },
    });
    await handlers.get("session_start")?.({}, ctx);
    expect(ctx.ui.notify).not.toHaveBeenCalled();
  });

  test("session_start is silent when UI is unavailable", async () => {
    const { pi, handlers } = fakePi();
    lunarouteExtension(pi);
    const ctx = fakeContext({ hasUI: false, modelRegistry: { getApiKeyForProvider: () => Promise.resolve(undefined) } });
    await handlers.get("session_start")?.({}, ctx);
    expect(ctx.ui.notify).not.toHaveBeenCalled();
  });

  test("session_start shows the adapter migration notice once when pi-mcp-adapter is installed (kata 4ws9)", async () => {
    _setAdapterInstalledOverride(() => true);
    const { pi, handlers } = fakePi();
    lunarouteExtension(pi);
    const ctx = fakeContext({
      modelRegistry: { getApiKeyForProvider: () => Promise.resolve("lr_key") },
    });
    await handlers.get("session_start")?.({}, ctx);
    expect(ctx.ui.notify).toHaveBeenCalledWith(ADAPTER_MIGRATION_NOTICE, "info");
    // second session_start must not repeat the notice
    await handlers.get("session_start")?.({}, ctx);
    const notices = (ctx.ui.notify.mock.calls as string[][]).filter((c) => c[0] === ADAPTER_MIGRATION_NOTICE);
    expect(notices).toHaveLength(1);
  });

  test("session_start stays silent about the adapter when it is not installed", async () => {
    _setAdapterInstalledOverride(() => false);
    const { pi, handlers } = fakePi();
    lunarouteExtension(pi);
    const ctx = fakeContext({
      modelRegistry: { getApiKeyForProvider: () => Promise.resolve("lr_key") },
    });
    await handlers.get("session_start")?.({}, ctx);
    const notices = (ctx.ui.notify.mock.calls as string[][]).filter((c) => c[0] === ADAPTER_MIGRATION_NOTICE);
    expect(notices).toHaveLength(0);
  });

  test("session_start does not hint or register when not logged in (no key)", async () => {
    const { pi, handlers, registeredTools } = fakePi();
    lunarouteExtension(pi);
    const ctx = fakeContext({
      modelRegistry: { getApiKeyForProvider: () => Promise.resolve(undefined) },
    });
    await handlers.get("session_start")?.({}, ctx);
    expect(registeredTools).toHaveLength(0);
    // Only the first-run hint — never a migration or MCP notice.
    const notices = (ctx.ui.notify.mock.calls as string[][]).filter((c) => c[0] !== firstRunHint());
    expect(notices).toHaveLength(0);
  });

  test("session_start registers a first-class web_search tool when the hosted MCP server offers one", async () => {
    const { pi, handlers, registeredTools, getActiveTools } = fakePi();
    lunarouteExtension(pi);
    // Server offers web_search (and nothing else web-ish).
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            result: { tools: [{ name: "web_search" }] },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        )),
    );
    const ctx = fakeContext({
      modelRegistry: { getApiKeyForProvider: () => Promise.resolve("lr_key") },
    });
    await handlers.get("session_start")?.({}, ctx);
    expect(registeredTools.map((t) => t.name)).toEqual(["web_search"]);
    expect(getActiveTools()).toContain("web_search");
    expect(getActiveTools()).toContain("read"); // existing actives preserved
    expect(ctx.ui.notify).not.toHaveBeenCalled(); // silent, like MCP registration
  });

  test("session_start leaves web tools alone when they already exist locally", async () => {
    const { pi, handlers, registeredTools } = fakePi({ toolNames: ["web_search", "fetch_content"] });
    lunarouteExtension(pi);
    // Image tools (kata e30g) have no local detection by design: their
    // availability is discovered from the server, so session_start now makes
    // an image-tools tools/list roundtrip even when web tools exist locally.
    // Web tools themselves must still not register or fetch for detection.
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => {
      throw new Error("image tools discovery failure");
    });
    vi.stubGlobal("fetch", fetchMock);
    const ctx = fakeContext({
      modelRegistry: { getApiKeyForProvider: () => Promise.resolve("lr_key") },
    });
    await handlers.get("session_start")?.({}, ctx);
    expect(registeredTools).toHaveLength(0);
    // The only server traffic is the image-tools discovery (initialize +
    // tools/list), never a web-tools registration attempt.
    const methods = fetchMock.mock.calls.map(([, init]) => (JSON.parse(String(init?.body)) as { method: string }).method);
    expect(methods).toEqual(["initialize", "tools/list", "initialize", "tools/list"]);
    expect(methods.filter((m) => m === "tools/call")).toHaveLength(0);
  });

  // ========================================================================
  // Settings (kata bjy9): /lunaroute TUI, file-backed, threaded everywhere.
  // ========================================================================

  test("registers the /lunaroute settings command", () => {
    const { pi, registerCommand } = fakePi();
    lunarouteExtension(pi);
    expect(registerCommand).toHaveBeenCalledWith(
      "lunaroute",
      expect.objectContaining({ description: expect.stringContaining("settings") }),
    );
  });

  test("mcp master switch off blocks every first-class family (kata 4ws9)", async () => {
    writeFileSync(join(agentDir, "lunaroute.json"), JSON.stringify({ mcp: "off" }));
    const { pi, handlers, registeredTools } = fakePi();
    lunarouteExtension(pi);
    const fetchMock = vi.fn(async () => {
      throw new Error("master off must make no server calls");
    });
    vi.stubGlobal("fetch", fetchMock);
    const ctx = fakeContext({
      modelRegistry: { getApiKeyForProvider: () => Promise.resolve("lr_key") },
    });
    await handlers.get("session_start")?.({}, ctx);
    expect(registeredTools).toHaveLength(0);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(ctx.ui.notify).not.toHaveBeenCalled(); // silent skip
  });

  test("webTools off skips web registration; image/convert families still discover (kata 4ws9)", async () => {
    writeFileSync(join(agentDir, "lunaroute.json"), JSON.stringify({ webTools: "off" }));
    const { pi, handlers, registeredTools } = fakePi();
    lunarouteExtension(pi);
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      throw new Error("family discovery failure");
    });
    vi.stubGlobal("fetch", fetchMock);
    const ctx = fakeContext({
      modelRegistry: { getApiKeyForProvider: () => Promise.resolve("lr_key") },
    });
    await handlers.get("session_start")?.({}, ctx);
    expect(registeredTools).toHaveLength(0);
    // mcp master is on, so the image and convert families still run their
    // discovery roundtrips (web tools never do — their family toggle is off).
    const methods = fetchMock.mock.calls.map(([, init]) => (JSON.parse(String(init?.body)) as { method: string }).method);
    expect(methods).toEqual(["initialize", "tools/list", "initialize", "tools/list"]);
  });

  test("login registers nothing when the mcp master switch is off (kata 4ws9)", async () => {
    writeFileSync(join(agentDir, "lunaroute.json"), JSON.stringify({ mcp: "off" }));
    const { pi, registerProvider } = fakePi();
    const fetchMock = vi.fn(async () => {
      throw new Error("master off must make no server calls");
    });
    vi.stubGlobal("fetch", fetchMock);
    lunarouteExtension(pi);
    const config = registerProvider.mock.calls[0]?.[1] as Record<string, unknown>;
    const oauth = config.oauth as { login(c: OAuthLoginCallbacks): Promise<unknown> };
    const creds = await oauth.login(pasteCallbacks("lr_new"));
    expect((creds as { access: string }).access).toBe("lr_new");
    // Registration is fire-and-forget; a tick lets any misplaced call surface.
    await new Promise((r) => setTimeout(r, 0));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("session_start is idempotent: a second start (no shutdown) does not duplicate tools", async () => {
    const { pi, handlers, registeredTools } = fakePi();
    lunarouteExtension(pi);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({ jsonrpc: "2.0", id: 1, result: { tools: [{ name: "web_search" }] } }),
          { status: 200, headers: { "content-type": "application/json" } },
        )),
    );
    const ctx = fakeContext({
      modelRegistry: { getApiKeyForProvider: () => Promise.resolve("lr_key") },
    });
    await handlers.get("session_start")?.({}, ctx);
    await handlers.get("session_start")?.({}, ctx); // no shutdown in between
    expect(registeredTools).toHaveLength(1); // presence detection skips re-registration
    expect(registeredTools.map((t) => t.name)).toEqual(["web_search"]);
  });

  test("login swaps in the fresh key for already-registered first-class tools (kata 4ws9)", async () => {
    const { pi, handlers, registerProvider, registeredTools } = fakePi();
    const seenKeys: (string | undefined)[] = [];
    lunarouteExtension(pi);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as { id: number; method: string };
        if (body.method === "tools/call") {
          seenKeys.push(new Headers(init?.headers).get("lunaroute-api-key") ?? undefined);
          return new Response(
            JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { content: [{ type: "text", text: "ok" }], isError: false } }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        return new Response(
          JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { tools: [{ name: "web_search" }] } }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }),
    );
    const ctx = fakeContext({
      modelRegistry: { getApiKeyForProvider: () => Promise.resolve("lr_old") },
    });
    await handlers.get("session_start")?.({}, ctx);
    expect(registeredTools.map((t) => t.name)).toEqual(["web_search"]);

    const config = registerProvider.mock.calls[0]?.[1] as Record<string, unknown>;
    const oauth = config.oauth as { login(c: OAuthLoginCallbacks): Promise<unknown> };
    const creds = await oauth.login(pasteCallbacks("lr_new"));
    expect((creds as { access: string }).access).toBe("lr_new");

    // The tool's captured facade now routes through the fresh-key client.
    const tool = registeredTools[0] as unknown as { execute: (id: string, params: unknown) => Promise<unknown> };
    await tool.execute("call-1", { query: "q" });
    expect(seenKeys.at(-1)).toBe("lr_new");
  });

});

describe("model persistence and auto-select", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    _resetAdapterNoticeState();
  });

  function modelsResponse(data: unknown[]): Response {
    return new Response(JSON.stringify({ object: "list", data }), { status: 200 });
  }

  function fakeRefreshContext(overrides: Partial<RefreshModelsContext> = {}): RefreshModelsContext {
    return {
      credential: { type: "oauth", access: "lr_test", refresh: "", expires: 1 },
      stored: undefined,
      publish: vi.fn(async () => true),
      allowNetwork: true,
      signal: new AbortController().signal,
      ...overrides,
    };
  }

  function refreshModelsOf(registerProvider: ReturnType<typeof vi.fn>) {
    const config = registerProvider.mock.calls[0]?.[1] as Record<string, unknown>;
    return config.refreshModels as (ctx: RefreshModelsContext) => Promise<ProviderModelConfig[]>;
  }

  function fireModelSelect(handlers: Map<string, SessionHandler>, model: Model<Api>) {
    handlers.get("model_select")?.({ type: "model_select", model, previousModel: undefined, source: "set" }, fakeContext());
  }

  test("registers a model_select handler", () => {
    const { pi, on } = fakePi();
    lunarouteExtension(pi);
    expect(on).toHaveBeenCalledWith("model_select", expect.any(Function));
  });

  test("auto-selects the first lunaroute model after a network refresh when no model is selected", async () => {
    const { pi, registerProvider, setModel } = fakePi();
    vi.stubEnv("LUNAROUTE_ROUTING_URL", "http://gw/v1");
    vi.stubGlobal("fetch", vi.fn(async () => modelsResponse([{ id: "glm-5.2", display_name: "GLM", context_window: 8192, max_output_tokens: 1024 }])));
    lunarouteExtension(pi);
    await refreshModelsOf(registerProvider)(fakeRefreshContext());
    expect(setModel).toHaveBeenCalledTimes(1);
    expect(setModel.mock.calls[0][0]).toMatchObject({
      id: "glm-5.2",
      provider: LUNAROUTE_PROVIDER,
      api: "openai-completions",
      baseUrl: "http://gw/v1",
    });
  });

  test("does not auto-select when the user already has a non-unknown model", async () => {
    const { pi, registerProvider, setModel, handlers } = fakePi();
    vi.stubEnv("LUNAROUTE_ROUTING_URL", "http://gw/v1");
    vi.stubGlobal("fetch", vi.fn(async () => modelsResponse([{ id: "glm-5.2", context_window: 8192, max_output_tokens: 1024 }])));
    lunarouteExtension(pi);
    fireModelSelect(handlers, { id: "other", name: "other", api: "anthropic-messages", provider: "anthropic", baseUrl: "", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 0, maxTokens: 0 });
    await refreshModelsOf(registerProvider)(fakeRefreshContext());
    expect(setModel).not.toHaveBeenCalled();
  });

  test("auto-selects when the current model is the 'unknown' sentinel (first login)", async () => {
    const { pi, registerProvider, setModel, handlers } = fakePi();
    vi.stubEnv("LUNAROUTE_ROUTING_URL", "http://gw/v1");
    vi.stubGlobal("fetch", vi.fn(async () => modelsResponse([{ id: "glm-5.2", context_window: 8192, max_output_tokens: 1024 }])));
    lunarouteExtension(pi);
    fireModelSelect(handlers, { id: "unknown", name: "unknown", api: "unknown", provider: "unknown", baseUrl: "", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 0, maxTokens: 0 });
    await refreshModelsOf(registerProvider)(fakeRefreshContext());
    expect(setModel).toHaveBeenCalledTimes(1);
  });

  test("session_start tracks the current model from ctx.model (no auto-select afterwards)", async () => {
    const { pi, registerProvider, setModel, handlers } = fakePi();
    vi.stubEnv("LUNAROUTE_ROUTING_URL", "http://gw/v1");
    vi.stubGlobal("fetch", vi.fn(async () => modelsResponse([{ id: "glm-5.2", context_window: 8192, max_output_tokens: 1024 }])));
    lunarouteExtension(pi);
    const ctx = fakeContext({
      model: { id: "existing", name: "existing", api: "anthropic-messages", provider: "anthropic", baseUrl: "", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 0, maxTokens: 0 } as unknown as Model<Api>,
      modelRegistry: { getApiKeyForProvider: () => Promise.resolve("lr_key") },
    });
    await handlers.get("session_start")?.({}, ctx);
    await refreshModelsOf(registerProvider)(fakeRefreshContext());
    expect(setModel).not.toHaveBeenCalled();
  });

  test("does not auto-select when the catalog fetch fails and no catalog is persisted", async () => {
    const { pi, registerProvider, setModel } = fakePi();
    vi.stubEnv("LUNAROUTE_ROUTING_URL", "http://gw/v1");
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("offline"); }));
    lunarouteExtension(pi);
    await refreshModelsOf(registerProvider)(fakeRefreshContext());
    expect(setModel).not.toHaveBeenCalled();
  });

  test("auto-picks the first persisted model when the fetch fails but a catalog is stored", async () => {
    const { pi, registerProvider, setModel, handlers } = fakePi();
    vi.stubEnv("LUNAROUTE_ROUTING_URL", "http://gw/v1");
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("offline"); }));
    lunarouteExtension(pi);
    fireModelSelect(handlers, { id: "unknown", name: "unknown", api: "unknown", provider: "unknown", baseUrl: "", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 0, maxTokens: 0 });
    const stored: Model<Api> = {
      id: "cached-1",
      name: "Cached 1",
      api: "openai-completions",
      provider: "lunaroute",
      baseUrl: "http://gw/v1",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 8192,
      maxTokens: 1024,
    };
    await refreshModelsOf(registerProvider)(fakeRefreshContext({ stored: { models: [stored], checkedAt: 1 } }));
    expect(setModel).toHaveBeenCalledTimes(1);
    expect(setModel.mock.calls[0][0]).toMatchObject({
      id: "cached-1",
      provider: LUNAROUTE_PROVIDER,
      api: "openai-completions",
      baseUrl: "http://gw/v1",
    });
  });

  test("notifies the user after auto-picking the default model", async () => {
    const { pi, registerProvider, setModel, handlers } = fakePi();
    vi.stubEnv("LUNAROUTE_ROUTING_URL", "http://gw/v1");
    vi.stubGlobal("fetch", vi.fn(async () => modelsResponse([{ id: "glm-5.2", display_name: "GLM", context_window: 8192, max_output_tokens: 1024 }])));
    lunarouteExtension(pi);
    const ctx = fakeContext({ modelRegistry: { getApiKeyForProvider: () => Promise.resolve(undefined) } });
    await handlers.get("session_start")?.({}, ctx);
    await refreshModelsOf(registerProvider)(fakeRefreshContext());
    expect(setModel).toHaveBeenCalledTimes(1);
    // The setModel result chain settles in microtasks after the refresh.
    await vi.waitFor(() =>
      expect(ctx.ui.notify).toHaveBeenCalledWith("LunaRoute: set GLM as default model (change with /model)", "info"),
    );
  });

  test("does not notify when setModel reports the provider is not authenticated", async () => {
    const { pi, registerProvider, setModel, handlers } = fakePi();
    vi.stubEnv("LUNAROUTE_ROUTING_URL", "http://gw/v1");
    vi.stubGlobal("fetch", vi.fn(async () => modelsResponse([{ id: "glm-5.2", display_name: "GLM", context_window: 8192, max_output_tokens: 1024 }])));
    setModel.mockResolvedValue(false);
    lunarouteExtension(pi);
    const ctx = fakeContext({ modelRegistry: { getApiKeyForProvider: () => Promise.resolve(undefined) } });
    await handlers.get("session_start")?.({}, ctx);
    await refreshModelsOf(registerProvider)(fakeRefreshContext());
    // The setModel result chain settles in microtasks after the refresh.
    await vi.waitFor(() => expect(setModel).toHaveBeenCalledTimes(1));
    await Promise.resolve();
    const messages = ctx.ui.notify.mock.calls.map((call) => String(call[0]));
    expect(messages.some((m) => m.includes("as default model"))).toBe(false);
  });

  test("surfaces a warning when setModel rejects", async () => {
    const { pi, registerProvider, setModel, handlers } = fakePi();
    vi.stubEnv("LUNAROUTE_ROUTING_URL", "http://gw/v1");
    vi.stubGlobal("fetch", vi.fn(async () => modelsResponse([{ id: "glm-5.2", display_name: "GLM", context_window: 8192, max_output_tokens: 1024 }])));
    setModel.mockRejectedValue(new Error("no API key for lunaroute/glm-5.2"));
    lunarouteExtension(pi);
    const ctx = fakeContext({ modelRegistry: { getApiKeyForProvider: () => Promise.resolve(undefined) } });
    await handlers.get("session_start")?.({}, ctx);
    await refreshModelsOf(registerProvider)(fakeRefreshContext());
    expect(setModel).toHaveBeenCalledTimes(1);
    // The setModel result chain settles in microtasks after the refresh.
    await vi.waitFor(() =>
      expect(ctx.ui.notify).toHaveBeenCalledWith(
        "LunaRoute: could not auto-select a default model: no API key for lunaroute/glm-5.2",
        "warning",
      ),
    );
  });

  test("falls back to console.warn when no ui is captured and setModel rejects", async () => {
    const { pi, registerProvider, setModel } = fakePi();
    vi.stubEnv("LUNAROUTE_ROUTING_URL", "http://gw/v1");
    vi.stubGlobal("fetch", vi.fn(async () => modelsResponse([{ id: "glm-5.2", display_name: "GLM", context_window: 8192, max_output_tokens: 1024 }])));
    setModel.mockRejectedValue(new Error("no API key for lunaroute/glm-5.2"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      lunarouteExtension(pi);
      await refreshModelsOf(registerProvider)(fakeRefreshContext());
      expect(setModel).toHaveBeenCalledTimes(1);
      // The setModel result chain settles in microtasks after the refresh.
      await vi.waitFor(() =>
        expect(warn).toHaveBeenCalledWith("LunaRoute: could not auto-select a default model: no API key for lunaroute/glm-5.2"),
      );
    } finally {
      warn.mockRestore();
    }
  });

  test("session_start registers image tools when the server offers them", async () => {
    const { pi, registerProvider, handlers, registeredTools } = fakePi();
    vi.stubEnv("LUNAROUTE_ROUTING_URL", "http://gw/v1");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            result: {
              tools: [
                { name: "generate_image", inputSchema: { type: "object", properties: { model: { type: "string", enum: ["flux-2-klein"] } } } },
                { name: "edit_image" },
                { name: "upload_image" },
              ],
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      ),
    );
    lunarouteExtension(pi);
    void registerProvider;
    const ctx = fakeContext({ modelRegistry: { getApiKeyForProvider: () => Promise.resolve("lr_key") } });
    await handlers.get("session_start")?.({}, ctx);
    const names = registeredTools.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(["generate_image", "edit_image", "upload_image"]));
  });

  test("does not auto-select when the catalog is empty", async () => {
    const { pi, registerProvider, setModel } = fakePi();
    vi.stubEnv("LUNAROUTE_ROUTING_URL", "http://gw/v1");
    vi.stubGlobal("fetch", vi.fn(async () => modelsResponse([])));
    lunarouteExtension(pi);
    await refreshModelsOf(registerProvider)(fakeRefreshContext());
    expect(setModel).not.toHaveBeenCalled();
  });
});

  test("a /lunaroute toggle landing during the key lookup is not bypassed (roborev job 1670)", async () => {
    _resetImageToolsState(); // module state from earlier tests must not mask the regression (roborev job 1694)
    const { pi, registerProvider, handlers, registeredTools } = fakePi();
    vi.stubEnv("LUNAROUTE_ROUTING_URL", "http://gw/v1");
    const dir = mkdtempSync(join(tmpdir(), "lr-toggle-"));
    vi.stubEnv("PI_CODING_AGENT_DIR", dir);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({ jsonrpc: "2.0", id: 1, result: { tools: [{ name: "generate_image" }, { name: "upload_image" }] } }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      ),
    );
    lunarouteExtension(pi);
    void registerProvider;
    // The key lookup parks; the user toggles image tools off while it does.
    let resolveKey!: (key: string | undefined) => void;
    const keyPromise = new Promise<string | undefined>((resolve) => {
      resolveKey = resolve;
    });
    const ctx = fakeContext({ modelRegistry: { getApiKeyForProvider: () => keyPromise } });
    const started = handlers.get("session_start")?.({}, ctx);
    writeFileSync(join(dir, "lunaroute.json"), JSON.stringify({ mcp: "on", webTools: "on", searchProvider: "server", imageTools: "off" }));
    resolveKey("lr_key");
    await started;
    expect(registeredTools.filter((t) => t.name === "generate_image" || t.name === "upload_image")).toHaveLength(0);
  });

  test("session_start registers convert_document when the server offers it (kata zpzt)", async () => {
    _resetConvertToolsState();
    const { pi, registerProvider, handlers, registeredTools } = fakePi();
    vi.stubEnv("LUNAROUTE_ROUTING_URL", "http://gw/v1");
    vi.stubEnv("PI_CODING_AGENT_DIR", mkdtempSync(join(tmpdir(), "lr-convert-")));
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({ jsonrpc: "2.0", id: 1, result: { tools: [{ name: "convert_document" }] } }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      ),
    );
    lunarouteExtension(pi);
    void registerProvider;
    const ctx = fakeContext({ modelRegistry: { getApiKeyForProvider: () => Promise.resolve("lr_key") } });
    await handlers.get("session_start")?.({}, ctx);
    expect(registeredTools.map((t) => t.name)).toContain("convert_document");
  });

describe("rotated-key reprompt (kata azhv)", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    // Keep registration and any incidental call off the network.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { tools: [] } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })),
    );
  });

  function fireAgentEnd(
    handlers: Map<string, SessionHandler>,
    ctx: FakeContext,
    message: Record<string, unknown> = {},
  ) {
    const assistant = {
      role: "assistant",
      provider: LUNAROUTE_PROVIDER,
      stopReason: "error",
      errorMessage: '401: {"code":"INVALID_API_KEY","message":"Invalid or revoked API key"}',
      ...message,
    };
    handlers.get("agent_end")?.({ type: "agent_end", messages: [assistant] }, ctx);
  }

  function setup() {
    const { pi, handlers } = fakePi();
    lunarouteExtension(pi);
    return handlers;
  }

  test("a 401 on a lunaroute response warns once and names /login lunaroute", () => {
    const handlers = setup();
    const ctx = fakeContext();
    fireAgentEnd(handlers, ctx);
    fireAgentEnd(handlers, ctx); // a retry storm must not spam
    expect(ctx.ui.notify).toHaveBeenCalledTimes(1);
    const [message, type] = (ctx.ui.notify as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(message).toContain("/login lunaroute");
    expect(message).toContain("401");
    expect(type).toBe("warning");
  });

  test("a 401 from another provider stays silent", () => {
    const handlers = setup();
    const ctx = fakeContext();
    fireAgentEnd(handlers, ctx, { provider: "anthropic" });
    expect(ctx.ui.notify).not.toHaveBeenCalled();
  });

  test("successes and non-401 failures stay silent", () => {
    const handlers = setup();
    const ctx = fakeContext();
    fireAgentEnd(handlers, ctx, { stopReason: "stop", errorMessage: undefined });
    fireAgentEnd(handlers, ctx, { errorMessage: "503: upstream unavailable" });
    fireAgentEnd(handlers, ctx, { errorMessage: "request failed" });
    expect(ctx.ui.notify).not.toHaveBeenCalled();
  });

  test("a new session re-arms the warning", async () => {
    const handlers = setup();
    const first = fakeContext();
    fireAgentEnd(handlers, first);
    expect(first.ui.notify).toHaveBeenCalledTimes(1);
    await handlers.get("session_start")?.({}, fakeContext({
      model: { provider: LUNAROUTE_PROVIDER, id: "glm-5.3" } as unknown as Model<Api>,
      modelRegistry: { getApiKeyForProvider: () => Promise.resolve("lr_key") },
    }));
    const second = fakeContext();
    fireAgentEnd(handlers, second);
    expect(second.ui.notify).toHaveBeenCalledTimes(1);
  });

  test("without a UI it falls back to console.warn", () => {
    const handlers = setup();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    fireAgentEnd(handlers, fakeContext({ hasUI: false }));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("/login lunaroute"));
    warn.mockRestore();
  });
});
