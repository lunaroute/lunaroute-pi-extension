import type { ExtensionAPI, ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import type { Api, Model, OAuthLoginCallbacks, RefreshModelsContext } from "@earendil-works/pi-ai";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { LUNAROUTE_PROVIDER, firstRunHint } from "../src/lunaroute.js";
import { MCP_INSTALL_HINT, MCP_RUNTIME_REGISTER_EVENT, _resetMcpState, type McpRuntimeRegistrationRequest } from "../src/mcp.js";
import lunarouteExtension from "../src/index.js";

type SessionHandler = (event: unknown, ctx: FakeContext) => void | Promise<void>;

type FakeContext = {
  hasUI: boolean;
  model?: Model<Api> | undefined;
  modelRegistry: {
    getProviderAuthStatus: (provider: string) => { configured: boolean } | undefined;
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

/** Subscribe a fake pi-mcp-adapter listener that accepts registrations. */
function installFakeAdapter(bus: Bus) {
  const requests: McpRuntimeRegistrationRequest[] = [];
  const dispose = vi.fn().mockResolvedValue(undefined);
  bus.on(MCP_RUNTIME_REGISTER_EVENT, (raw) => {
    const req = raw as McpRuntimeRegistrationRequest;
    if (req.result !== undefined) return;
    requests.push(req);
    req.result = { ok: true, registration: { dispose } };
  });
  return { requests, dispose };
}

function fakePi() {
  const handlers = new Map<string, SessionHandler>();
  const registerProvider = vi.fn();
  const setModel = vi.fn(async (_model: unknown) => true);
  const events = fakeEventBus();
  const on = vi.fn((name: string, handler: SessionHandler) => handlers.set(name, handler));
  return { pi: { registerProvider, on, events, setModel } as unknown as ExtensionAPI, registerProvider, setModel, on, handlers, events };
}

function fakeContext(overrides: Partial<FakeContext> = {}): FakeContext {
  return {
    hasUI: true,
    modelRegistry: {
      getProviderAuthStatus: () => ({ configured: false }),
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
  beforeEach(() => {
    vi.unstubAllEnvs();
    _resetMcpState();
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

  test("registers a session_start and a session_shutdown handler", () => {
    const { pi, on, handlers } = fakePi();
    lunarouteExtension(pi);
    expect(on).toHaveBeenCalledWith("session_start", expect.any(Function));
    expect(on).toHaveBeenCalledWith("session_shutdown", expect.any(Function));
    expect(handlers.has("session_start")).toBe(true);
    expect(handlers.has("session_shutdown")).toBe(true);
  });

  test("session_start notifies the first-run hint when no credential is configured", async () => {
    const { pi, handlers } = fakePi();
    lunarouteExtension(pi);
    const ctx = fakeContext({ modelRegistry: { getProviderAuthStatus: () => ({ configured: false }), getApiKeyForProvider: () => Promise.resolve(undefined) } });
    await handlers.get("session_start")?.({}, ctx);
    expect(ctx.ui.notify).toHaveBeenCalledWith(firstRunHint(), "info");
  });

  test("session_start is silent when a credential is configured and the adapter is installed", async () => {
    const { pi, handlers, events } = fakePi();
    installFakeAdapter(events);
    lunarouteExtension(pi);
    const ctx = fakeContext({
      modelRegistry: { getProviderAuthStatus: () => ({ configured: true }), getApiKeyForProvider: () => Promise.resolve("lr_key") },
    });
    await handlers.get("session_start")?.({}, ctx);
    expect(ctx.ui.notify).not.toHaveBeenCalled();
  });

  test("session_start is silent when UI is unavailable", async () => {
    const { pi, handlers } = fakePi();
    lunarouteExtension(pi);
    const ctx = fakeContext({ hasUI: false, modelRegistry: { getProviderAuthStatus: () => ({ configured: false }), getApiKeyForProvider: () => Promise.resolve(undefined) } });
    await handlers.get("session_start")?.({}, ctx);
    expect(ctx.ui.notify).not.toHaveBeenCalled();
  });

  test("session_start registers the lunaroute MCP server when logged in and the adapter is installed", async () => {
    const { pi, handlers, events } = fakePi();
    const adapter = installFakeAdapter(events);
    lunarouteExtension(pi);
    const ctx = fakeContext({
      modelRegistry: { getProviderAuthStatus: () => ({ configured: true }), getApiKeyForProvider: () => Promise.resolve("lr_key") },
    });
    await handlers.get("session_start")?.({}, ctx);
    expect(adapter.requests).toHaveLength(1);
    expect(adapter.requests[0].name).toBe("lunaroute");
    expect(adapter.requests[0].definition.headers["LUNAROUTE-API-KEY"]).toBe("lr_key");
    expect(adapter.requests[0].result?.ok).toBe(true);
  });

  test("session_start shows the install hint exactly once when logged in but the adapter is absent", async () => {
    const { pi, handlers } = fakePi(); // no adapter installed
    lunarouteExtension(pi);
    const ctx = fakeContext({
      modelRegistry: { getProviderAuthStatus: () => ({ configured: true }), getApiKeyForProvider: () => Promise.resolve("lr_key") },
    });
    await handlers.get("session_start")?.({}, ctx);
    expect(ctx.ui.notify).toHaveBeenCalledWith(MCP_INSTALL_HINT, "info");
    // second session_start must not repeat the hint
    await handlers.get("session_start")?.({}, ctx);
    const mcpHints = (ctx.ui.notify.mock.calls as string[][]).filter((c) => c[0] === MCP_INSTALL_HINT);
    expect(mcpHints).toHaveLength(1);
  });

  test("session_start warns instead of hinting when the adapter rejects the registration", async () => {
    const { pi, handlers, events } = fakePi();
    events.on(MCP_RUNTIME_REGISTER_EVENT, (raw) => {
      const req = raw as McpRuntimeRegistrationRequest;
      req.result = { ok: false, error: new Error("duplicate name") };
    });
    lunarouteExtension(pi);
    const ctx = fakeContext({
      modelRegistry: { getProviderAuthStatus: () => ({ configured: true }), getApiKeyForProvider: () => Promise.resolve("lr_key") },
    });
    await handlers.get("session_start")?.({}, ctx);
    const calls = ctx.ui.notify.mock.calls as [string, string?][];
    expect(calls.some(([m, t]) => m.startsWith("LunaRoute MCP registration failed") && t === "warning")).toBe(true);
    expect(calls.some(([m]) => m === MCP_INSTALL_HINT)).toBe(false);
  });

  test("session_start does not hint or register when not logged in (no key)", async () => {
    const { pi, handlers, events } = fakePi();
    const adapter = installFakeAdapter(events);
    lunarouteExtension(pi);
    const ctx = fakeContext({
      modelRegistry: { getProviderAuthStatus: () => ({ configured: false }), getApiKeyForProvider: () => Promise.resolve(undefined) },
    });
    await handlers.get("session_start")?.({}, ctx);
    expect(adapter.requests).toHaveLength(0);
    const mcpHints = (ctx.ui.notify.mock.calls as string[][]).filter((c) => c[0] === MCP_INSTALL_HINT);
    expect(mcpHints).toHaveLength(0);
  });

  test("session_start is idempotent: a second start (no shutdown) is a no-op, not a duplicate", async () => {
    const { pi, handlers, events } = fakePi();
    const adapter = installFakeAdapter(events);
    lunarouteExtension(pi);
    const ctx = fakeContext({
      modelRegistry: { getProviderAuthStatus: () => ({ configured: true }), getApiKeyForProvider: () => Promise.resolve("lr_key") },
    });
    await handlers.get("session_start")?.({}, ctx);
    await handlers.get("session_start")?.({}, ctx); // no shutdown in between
    expect(adapter.requests).toHaveLength(1); // second start did not re-emit
    expect(adapter.dispose).not.toHaveBeenCalled();
    const failed = (ctx.ui.notify.mock.calls as [string, string?][]).filter(([m]) => m.startsWith("LunaRoute MCP registration failed"));
    expect(failed).toHaveLength(0);
  });

  test("session_shutdown disposes the MCP registration", async () => {
    const { pi, handlers, events } = fakePi();
    const adapter = installFakeAdapter(events);
    lunarouteExtension(pi);
    const ctx = fakeContext({
      modelRegistry: { getProviderAuthStatus: () => ({ configured: true }), getApiKeyForProvider: () => Promise.resolve("lr_key") },
    });
    await handlers.get("session_start")?.({}, ctx);
    await handlers.get("session_shutdown")?.({}, ctx);
    expect(adapter.dispose).toHaveBeenCalledTimes(1);
  });

  test("login re-registers MCP with the fresh key after disposing the prior registration", async () => {
    const { pi, handlers, events, registerProvider } = fakePi();
    const adapter = installFakeAdapter(events);
    lunarouteExtension(pi);
    const ctx = fakeContext({
      modelRegistry: { getProviderAuthStatus: () => ({ configured: true }), getApiKeyForProvider: () => Promise.resolve("lr_old") },
    });
    await handlers.get("session_start")?.({}, ctx);
    expect(adapter.requests).toHaveLength(1);
    expect(adapter.requests[0].definition.headers["LUNAROUTE-API-KEY"]).toBe("lr_old");

    const config = registerProvider.mock.calls[0]?.[1] as Record<string, unknown>;
    const oauth = config.oauth as { login(c: OAuthLoginCallbacks): Promise<unknown> };
    const creds = await oauth.login(pasteCallbacks("lr_new"));
    expect((creds as { access: string }).access).toBe("lr_new");

    expect(adapter.dispose).toHaveBeenCalledTimes(1);
    expect(adapter.requests).toHaveLength(2);
    expect(adapter.requests[1].definition.headers["LUNAROUTE-API-KEY"]).toBe("lr_new");
  });

  test("login surfaces the install hint via onProgress when the adapter is absent", async () => {
    const { pi, registerProvider } = fakePi(); // no adapter installed
    lunarouteExtension(pi);
    const config = registerProvider.mock.calls[0]?.[1] as Record<string, unknown>;
    const oauth = config.oauth as { login(c: OAuthLoginCallbacks): Promise<unknown> };
    const callbacks = pasteCallbacks("lr_new");
    await oauth.login(callbacks);
    expect(callbacks.onProgress).toHaveBeenCalledWith(MCP_INSTALL_HINT);
  });

  test("login does not surface the install hint when the adapter is installed", async () => {
    const { pi, events, registerProvider } = fakePi();
    installFakeAdapter(events);
    lunarouteExtension(pi);
    const config = registerProvider.mock.calls[0]?.[1] as Record<string, unknown>;
    const oauth = config.oauth as { login(c: OAuthLoginCallbacks): Promise<unknown> };
    const callbacks = pasteCallbacks("lr_new");
    await oauth.login(callbacks);
    expect(callbacks.onProgress).not.toHaveBeenCalledWith(MCP_INSTALL_HINT);
  });

  test("login surfaces the hint only once across two logins when the adapter stays absent", async () => {
    const { pi, registerProvider } = fakePi();
    lunarouteExtension(pi);
    const config = registerProvider.mock.calls[0]?.[1] as Record<string, unknown>;
    const oauth = config.oauth as { login(c: OAuthLoginCallbacks): Promise<unknown> };
    const first = pasteCallbacks("lr_one");
    await oauth.login(first);
    const second = pasteCallbacks("lr_two");
    await oauth.login(second);
    expect(first.onProgress).toHaveBeenCalledWith(MCP_INSTALL_HINT);
    expect(second.onProgress).not.toHaveBeenCalled();
  });
});

describe("model persistence and auto-select", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    _resetMcpState();
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
    vi.stubGlobal("fetch", vi.fn(async () => modelsResponse([{ id: "glm-5.2", display_name: "GLM" }])));
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
    vi.stubGlobal("fetch", vi.fn(async () => modelsResponse([{ id: "glm-5.2" }])));
    lunarouteExtension(pi);
    fireModelSelect(handlers, { id: "other", name: "other", api: "anthropic-messages", provider: "anthropic", baseUrl: "", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 0, maxTokens: 0 });
    await refreshModelsOf(registerProvider)(fakeRefreshContext());
    expect(setModel).not.toHaveBeenCalled();
  });

  test("auto-selects when the current model is the 'unknown' sentinel (first login)", async () => {
    const { pi, registerProvider, setModel, handlers } = fakePi();
    vi.stubEnv("LUNAROUTE_ROUTING_URL", "http://gw/v1");
    vi.stubGlobal("fetch", vi.fn(async () => modelsResponse([{ id: "glm-5.2" }])));
    lunarouteExtension(pi);
    fireModelSelect(handlers, { id: "unknown", name: "unknown", api: "unknown", provider: "unknown", baseUrl: "", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 0, maxTokens: 0 });
    await refreshModelsOf(registerProvider)(fakeRefreshContext());
    expect(setModel).toHaveBeenCalledTimes(1);
  });

  test("session_start tracks the current model from ctx.model (no auto-select afterwards)", async () => {
    const { pi, registerProvider, setModel, handlers, events } = fakePi();
    installFakeAdapter(events);
    vi.stubEnv("LUNAROUTE_ROUTING_URL", "http://gw/v1");
    vi.stubGlobal("fetch", vi.fn(async () => modelsResponse([{ id: "glm-5.2" }])));
    lunarouteExtension(pi);
    const ctx = fakeContext({
      model: { id: "existing", name: "existing", api: "anthropic-messages", provider: "anthropic", baseUrl: "", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 0, maxTokens: 0 } as unknown as Model<Api>,
      modelRegistry: { getProviderAuthStatus: () => ({ configured: true }), getApiKeyForProvider: () => Promise.resolve("lr_key") },
    });
    await handlers.get("session_start")?.({}, ctx);
    await refreshModelsOf(registerProvider)(fakeRefreshContext());
    expect(setModel).not.toHaveBeenCalled();
  });

  test("does not auto-select when the catalog fetch fails", async () => {
    const { pi, registerProvider, setModel } = fakePi();
    vi.stubEnv("LUNAROUTE_ROUTING_URL", "http://gw/v1");
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("offline"); }));
    lunarouteExtension(pi);
    await refreshModelsOf(registerProvider)(fakeRefreshContext());
    expect(setModel).not.toHaveBeenCalled();
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
