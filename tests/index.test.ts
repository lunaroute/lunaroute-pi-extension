import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { LUNAROUTE_PROVIDER, missingApiKeyWarning, missingProviderWarning } from "../src/lunaroute.js";
import { registerLunarouteExtension } from "../src/index.js";

type SessionStartHandler = (event: unknown, ctx: FakeContext) => void | Promise<void>;

type FakeContext = {
  hasUI: boolean;
  modelRegistry: {
    getAll: () => Array<{ provider: string; id: string }>;
    getProviderAuthStatus: (provider: string) => { configured: boolean };
  };
  ui: {
    notify: ReturnType<typeof vi.fn>;
  };
};

function fakePi() {
  const handlers = new Map<string, SessionStartHandler>();
  const registerProvider = vi.fn();
  const on = vi.fn((eventName: string, handler: SessionStartHandler) => {
    handlers.set(eventName, handler);
  });

  return {
    pi: { registerProvider, on } as unknown as ExtensionAPI,
    registerProvider,
    on,
    handlers,
  };
}

function fakeContext(overrides: Partial<FakeContext> = {}): FakeContext {
  return {
    hasUI: true,
    modelRegistry: {
      getAll: () => [{ provider: LUNAROUTE_PROVIDER, id: "glm-5.2" }],
      getProviderAuthStatus: () => ({ configured: true }),
    },
    ui: {
      notify: vi.fn(),
    },
    ...overrides,
  };
}

describe("Pi extension wiring", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
  });

  test("registers an override for provider lunaroute with standardized env auth and headers", () => {
    const { pi, registerProvider } = fakePi();

    registerLunarouteExtension(pi, "0.80.3", {}, "session-123");

    expect(registerProvider).toHaveBeenCalledWith("lunaroute", {
      apiKey: "$LUNAROUTE_API_KEY",
      headers: {
        "lunaroute-agent": "pi/0.80.3",
        "x-lunaroute-session": "session-123",
        "lunaroute-session-id": "session-123",
      },
    });
  });

  test("does not register models or User-Agent", () => {
    const { pi, registerProvider } = fakePi();

    registerLunarouteExtension(pi, "0.80.3", {}, "session-123");

    const config = registerProvider.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(config).not.toHaveProperty("models");
    expect(config.headers).not.toHaveProperty("User-Agent");
    expect(config.headers).not.toHaveProperty("user-agent");
  });

  test("registers a session_start handler", () => {
    const { pi, on, handlers } = fakePi();

    registerLunarouteExtension(pi, "0.80.3", {}, "session-123");

    expect(on).toHaveBeenCalledWith("session_start", expect.any(Function));
    expect(handlers.has("session_start")).toBe(true);
  });

  test("warns when provider lunaroute is missing", async () => {
    const { pi, handlers } = fakePi();
    registerLunarouteExtension(pi, "0.80.3", {}, "session-123");
    const ctx = fakeContext({
      modelRegistry: {
        getAll: () => [{ provider: "lunaroute11111", id: "test" }],
        getProviderAuthStatus: () => ({ configured: false }),
      },
    });

    await handlers.get("session_start")?.({}, ctx);

    expect(ctx.ui.notify).toHaveBeenCalledWith(missingProviderWarning(), "warning");
    expect(ctx.ui.notify).toHaveBeenCalledTimes(1);
  });

  test("warns when provider exists but auth is missing", async () => {
    const { pi, handlers } = fakePi();
    registerLunarouteExtension(pi, "0.80.3", {}, "session-123");
    const ctx = fakeContext({
      modelRegistry: {
        getAll: () => [{ provider: "lunaroute", id: "glm-5.2" }],
        getProviderAuthStatus: () => ({ configured: false }),
      },
    });

    await handlers.get("session_start")?.({}, ctx);

    expect(ctx.ui.notify).toHaveBeenCalledWith(missingApiKeyWarning(), "warning");
    expect(ctx.ui.notify).toHaveBeenCalledTimes(1);
  });

  test("does not warn for missing auth when LUNAROUTE_API_KEY env var exists", async () => {
    const { pi, handlers } = fakePi();
    registerLunarouteExtension(pi, "0.80.3", { LUNAROUTE_API_KEY: "lr_secret" }, "session-123");
    const ctx = fakeContext({
      modelRegistry: {
        getAll: () => [{ provider: "lunaroute", id: "glm-5.2" }],
        getProviderAuthStatus: () => ({ configured: false }),
      },
    });

    await handlers.get("session_start")?.({}, ctx);

    expect(ctx.ui.notify).not.toHaveBeenCalled();
  });

  test("does not warn for missing auth when Pi auth status is configured", async () => {
    const { pi, handlers } = fakePi();
    registerLunarouteExtension(pi, "0.80.3", {}, "session-123");
    const ctx = fakeContext({
      modelRegistry: {
        getAll: () => [{ provider: "lunaroute", id: "glm-5.2" }],
        getProviderAuthStatus: () => ({ configured: true }),
      },
    });

    await handlers.get("session_start")?.({}, ctx);

    expect(ctx.ui.notify).not.toHaveBeenCalled();
  });

  test("does not notify when UI is unavailable", async () => {
    const { pi, handlers } = fakePi();
    registerLunarouteExtension(pi, "0.80.3", {}, "session-123");
    const ctx = fakeContext({
      hasUI: false,
      modelRegistry: {
        getAll: () => [],
        getProviderAuthStatus: () => ({ configured: false }),
      },
    });

    await handlers.get("session_start")?.({}, ctx);

    expect(ctx.ui.notify).not.toHaveBeenCalled();
  });
});
