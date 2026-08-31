import { beforeEach, describe, expect, test, vi } from "vitest";
import type { OAuthLoginCallbacks, OAuthCredentials } from "@earendil-works/pi-ai";
import {
  exchangeCode,
  loginWithBrowser,
  loginWithPaste,
  lunarouteLogin,
  startLoopbackServer,
  type LoopbackServer,
} from "../src/login.js";

function fakeCallbacks(overrides: Partial<OAuthLoginCallbacks> = {}): OAuthLoginCallbacks {
  return {
    onAuth: vi.fn(),
    onDeviceCode: vi.fn(),
    onPrompt: vi.fn(async () => "lr_pasted"),
    onProgress: vi.fn(),
    onSelect: vi.fn(async () => "browser"),
    signal: undefined,
    ...overrides,
  };
}

function fakeLoopback(code: string, state: string): LoopbackServer {
  return {
    port: 39999,
    waitForCallback: async () => ({ code, state }),
    close: vi.fn(),
  };
}

function fakeLoopbackNever(): LoopbackServer {
  return { port: 39999, waitForCallback: () => new Promise(() => {}), close: vi.fn() };
}

beforeEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("lunaroute login", () => {

  test("paste path prompts for a secret (plain text) and returns the key", async () => {
    const cb = fakeCallbacks({ onSelect: vi.fn(async () => "paste"), onPrompt: vi.fn(async () => "lr_secret") });
    const key = await loginWithPaste(cb);
    expect(cb.onPrompt).toHaveBeenCalledWith({ message: "Paste your LunaRoute API key (lr_...)" });
    expect(key).toBe("lr_secret");
  });

  test("paste path trims whitespace", async () => {
    const cb = fakeCallbacks({ onSelect: vi.fn(async () => "paste"), onPrompt: vi.fn(async () => "  lr_trim  ") });
    expect(await loginWithPaste(cb)).toBe("lr_trim");
  });

  test("browser path: onSelect -> onAuth -> verify state -> exchange -> return full_key", async () => {
    const state = "the-state";
    const onAuth = vi.fn();
    const cb = fakeCallbacks({
      onSelect: vi.fn(async () => "browser"),
      onAuth,
    });
    const exchange = vi.fn(async () => ({
      full_key: "lr_from_exchange",
      org_id: "o",
      user_email: "u@example.com",
    }));

    const key = await loginWithBrowser(cb, { LUNAROUTE_FRONT_URL: "http://front", LUNAROUTE_API_URL: "http://api" }, {
      startLoopback: async () => fakeLoopback("the-code", state),
      exchange,
      state: () => state,
      verifier: () => "the-verifier",
    });

    expect(key).toBe("lr_from_exchange");
    expect(onAuth).toHaveBeenCalledWith({
      url: expect.stringMatching(/^http:\/\/front\/device-auth\/pi\?port=39999&state=the-state&challenge=/),
      instructions: "Complete login in your browser.",
    });
    expect(exchange).toHaveBeenCalledWith("http://api", {
      code: "the-code",
      verifier: "the-verifier",
      label: expect.any(String),
    });
  });

  test("browser path: after loopback timeout, accepts a pasted callback URL and exchanges it", async () => {
    const onPrompt = vi.fn(async () => "http://127.0.0.1:39999/callback?code=pasted-code&state=the-state");
    const cb = fakeCallbacks({ onSelect: vi.fn(async () => "browser"), onPrompt });
    const exchange = vi.fn(async () => ({ full_key: "lr_pasted_key", org_id: "o", user_email: "u" }));
    const key = await loginWithBrowser(cb, { LUNAROUTE_FRONT_URL: "http://front", LUNAROUTE_API_URL: "http://api" }, {
      startLoopback: async () => fakeLoopbackNever(),
      exchange,
      state: () => "the-state",
      verifier: () => "the-verifier",
      timeoutMs: 10,
    });
    expect(key).toBe("lr_pasted_key");
    expect(onPrompt).toHaveBeenCalled();
    expect(exchange).toHaveBeenCalledWith("http://api", {
      code: "pasted-code",
      verifier: "the-verifier",
      label: expect.any(String),
    });
  });

  test("browser path rejects a pasted callback URL with a mismatched state", async () => {
    const cb = fakeCallbacks({
      onSelect: vi.fn(async () => "browser"),
      onPrompt: vi.fn(async () => "http://127.0.0.1:39999/callback?code=c&state=wrong"),
    });
    const exchange = vi.fn(async () => ({ full_key: "lr_x", org_id: "o", user_email: "u" }));
    await expect(
      loginWithBrowser(cb, { LUNAROUTE_FRONT_URL: "http://front", LUNAROUTE_API_URL: "http://api" }, {
        startLoopback: async () => fakeLoopbackNever(),
        exchange,
        state: () => "right-state",
        verifier: () => "v",
        timeoutMs: 10,
      }),
    ).rejects.toThrow("state mismatch");
    expect(exchange).not.toHaveBeenCalled();
  });

  test("browser path aborts on state mismatch", async () => {
    const cb = fakeCallbacks({ onSelect: vi.fn(async () => "browser") });
    const exchange = vi.fn(async () => ({ full_key: "lr_x", org_id: "o", user_email: "u" }));
    await expect(
      loginWithBrowser(cb, { LUNAROUTE_FRONT_URL: "http://front", LUNAROUTE_API_URL: "http://api" }, {
        startLoopback: async () => fakeLoopback("code", "wrong-state"),
        exchange,
        state: () => "right-state",
        verifier: () => "v",
      }),
    ).rejects.toThrow("state mismatch");
    expect(exchange).not.toHaveBeenCalled();
  });

  test("lunarouteLogin returns an OAuthCredentials with far-future expiry for browser", async () => {
    const cb = fakeCallbacks({ onSelect: vi.fn(async () => "browser") });
    const creds = await lunarouteLogin(cb, { LUNAROUTE_FRONT_URL: "http://front", LUNAROUTE_API_URL: "http://api" }, {
      startLoopback: async () => fakeLoopback("c", "s"),
      exchange: vi.fn(async () => ({ full_key: "lr_k", org_id: "o", user_email: "u" })),
      state: () => "s",
      verifier: () => "v",
    });
    expect(creds.access).toBe("lr_k");
    expect(creds.refresh).toBe("");
    expect(creds.expires).toBeGreaterThan(Date.now() + 9 * 365 * 24 * 60 * 60 * 1000);
  });

  test("lunarouteLogin returns OAuthCredentials for paste", async () => {
    const cb = fakeCallbacks({ onSelect: vi.fn(async () => "paste"), onPrompt: vi.fn(async () => "lr_p") });
    const creds = await lunarouteLogin(cb, {});
    expect(creds.access).toBe("lr_p");
    expect(creds.refresh).toBe("");
  });

  test("lunarouteLogin throws if the user cancels the method select", async () => {
    const cb = fakeCallbacks({ onSelect: vi.fn(async () => undefined) });
    await expect(lunarouteLogin(cb, {})).rejects.toThrow("Login cancelled");
  });

  test("lunarouteLogin throws on an empty pasted key", async () => {
    const cb = fakeCallbacks({ onSelect: vi.fn(async () => "paste"), onPrompt: vi.fn(async () => "   ") });
    await expect(lunarouteLogin(cb, {})).rejects.toThrow("No API key provided");
  });

  test("exchangeCode posts to /v1/auth/exchange and parses the response", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ full_key: "lr_ok", org_id: "o", user_email: "u@e" }),
    }));
    vi.stubGlobal("fetch", fetchMock);
    const res = await exchangeCode("http://api", { code: "c", verifier: "v", label: "h" });
    expect(res.full_key).toBe("lr_ok");
    expect(fetchMock).toHaveBeenCalledWith("http://api/v1/auth/exchange", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: "c", verifier: "v", label: "h" }),
    });
  });

  test("exchangeCode throws a clear error on a non-OK response", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: false,
      status: 401,
      json: async () => ({ error: { code: "INVALID_CODE", message: "bad code" } }),
    })));
    await expect(exchangeCode("http://api", { code: "c", verifier: "v", label: "h" })).rejects.toThrow(/INVALID_CODE/);
  });
});

describe("startLoopbackServer (real node:http)", () => {
  test("resolves /callback?code=&state= and returns the success HTML", async () => {
    const server = await startLoopbackServer();
    try {
      const res = await fetch(`http://127.0.0.1:${server.port}/callback?code=abc&state=xyz`);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("text/html");
      const body = await res.text();
      expect(body).toContain("LunaRoute authorized.");
      await expect(server.waitForCallback()).resolves.toEqual({ code: "abc", state: "xyz" });
    } finally {
      server.close();
    }
  });

  test("returns 404 for a non-/callback path", async () => {
    const server = await startLoopbackServer();
    try {
      const res = await fetch(`http://127.0.0.1:${server.port}/favicon.ico`);
      expect(res.status).toBe(404);
    } finally {
      server.close();
    }
  });
});
