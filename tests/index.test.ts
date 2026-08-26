import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { OAuthLoginCallbacks } from "@earendil-works/pi-ai";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { LUNAROUTE_PROVIDER, firstRunHint } from "../src/lunaroute.js";
import { MCP_INSTALL_HINT, MCP_RUNTIME_REGISTER_EVENT, _resetMcpState, type McpRuntimeRegistrationRequest } from "../src/mcp.js";
import lunarouteExtension from "../src/index.js";

type SessionHandler = (event: unknown, ctx: FakeContext) => void | Promise<void>;

type FakeContext = {
  hasUI: boolean;
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
  const events = fakeEventBus();
  const on = vi.fn((name: string, handler: SessionHandler) => handlers.set(name, handler));
  return { pi: { registerProvider, on, events } as unknown as ExtensionAPI, registerProvider, on, handlers, events };
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

  test("registers the lunaroute provider with identity, auth, headers, refreshModels, and empty models", () => {
    const { pi, registerProvider } = fakePi();
    vi.stubEnv("LUNAROUTE_ROUTING_URL", "http://gw/v1");

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
});
