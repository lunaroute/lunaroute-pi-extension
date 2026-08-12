import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { LUNAROUTE_PROVIDER, firstRunHint } from "../src/lunaroute.js";
import lunarouteExtension from "../src/index.js";

type SessionStartHandler = (event: unknown, ctx: FakeContext) => void | Promise<void>;

type FakeContext = {
  hasUI: boolean;
  modelRegistry: {
    getProviderAuthStatus: (provider: string) => { configured: boolean } | undefined;
  };
  ui: { notify: ReturnType<typeof vi.fn> };
};

function fakePi() {
  const handlers = new Map<string, SessionStartHandler>();
  const registerProvider = vi.fn();
  const on = vi.fn((name: string, handler: SessionStartHandler) => handlers.set(name, handler));
  return { pi: { registerProvider, on } as unknown as ExtensionAPI, registerProvider, on, handlers };
}

function fakeContext(overrides: Partial<FakeContext> = {}): FakeContext {
  return {
    hasUI: true,
    modelRegistry: { getProviderAuthStatus: () => ({ configured: false }) },
    ui: { notify: vi.fn() },
    ...overrides,
  };
}

describe("pi extension v2 wiring", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
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

  test("registers a session_start handler", () => {
    const { pi, on, handlers } = fakePi();
    lunarouteExtension(pi);
    expect(on).toHaveBeenCalledWith("session_start", expect.any(Function));
    expect(handlers.has("session_start")).toBe(true);
  });

  test("session_start notifies the first-run hint when no credential is configured", async () => {
    const { pi, handlers } = fakePi();
    lunarouteExtension(pi);
    const ctx = fakeContext({ modelRegistry: { getProviderAuthStatus: () => ({ configured: false }) } });
    await handlers.get("session_start")?.({}, ctx);
    expect(ctx.ui.notify).toHaveBeenCalledWith(firstRunHint(), "info");
  });

  test("session_start is silent when a credential is configured", async () => {
    const { pi, handlers } = fakePi();
    lunarouteExtension(pi);
    const ctx = fakeContext({ modelRegistry: { getProviderAuthStatus: () => ({ configured: true }) } });
    await handlers.get("session_start")?.({}, ctx);
    expect(ctx.ui.notify).not.toHaveBeenCalled();
  });

  test("session_start is silent when UI is unavailable", async () => {
    const { pi, handlers } = fakePi();
    lunarouteExtension(pi);
    const ctx = fakeContext({ hasUI: false, modelRegistry: { getProviderAuthStatus: () => ({ configured: false }) } });
    await handlers.get("session_start")?.({}, ctx);
    expect(ctx.ui.notify).not.toHaveBeenCalled();
  });
});
