import { beforeEach, describe, expect, test, vi } from "vitest";
import type { RefreshModelsContext } from "@earendil-works/pi-ai";
import { createRefreshModels } from "../src/discovery.js";

function fakeContext(overrides: Partial<RefreshModelsContext> = {}): RefreshModelsContext {
  return {
    credential: { type: "oauth", access: "lr_test", refresh: "", expires: 1 },
    stored: undefined,
    publish: vi.fn(async () => true),
    allowNetwork: true,
    signal: new AbortController().signal,
    ...overrides,
  };
}

function modelsResponse(data: unknown[]): Response {
  return new Response(JSON.stringify({ object: "list", data }), { status: 200 });
}

describe("lunaroute refreshModels", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  test("fetches {baseUrl}/models with Authorization: Bearer <key> and signal, maps entries", async () => {
    const fetchMock = vi.fn(async () =>
      modelsResponse([
        {
          id: "chat-1",
          display_name: "Chat 1",
          context_window: 8192,
          max_output_tokens: 1024,
          capabilities: { tools: true },
        },
        {
          id: "glm-5.2",
          context_window: 1048576,
          max_output_tokens: 16384,
          capabilities: { reasoning: true, tools: true },
          pi: {
            thinkingLevelMap: { off: null, high: "high" },
            compat: { thinkingFormat: "zai", maxTokensField: "max_tokens", supportsReasoningEffort: false },
          },
        },
      ]),
    );
    vi.stubGlobal("fetch", fetchMock);

    const ctx = fakeContext();
    const models = await createRefreshModels({ LUNAROUTE_ROUTING_URL: "http://gw/v1" })(ctx);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://gw/v1/models");
    expect(init.headers).toEqual({ Authorization: "Bearer lr_test" });
    expect(init.signal).toBe(ctx.signal);

    expect(models).toHaveLength(2);
    expect(models[0]).toMatchObject({ id: "chat-1", name: "Chat 1", reasoning: false, contextWindow: 8192, maxTokens: 1024 });
    expect(models[1]).toMatchObject({ id: "glm-5.2", reasoning: true });
    expect(models[1].thinkingLevelMap).toEqual({ off: null, high: "high" });
    expect(models[1].compat).toEqual({ thinkingFormat: "zai", maxTokensField: "max_tokens", supportsReasoningEffort: false });
  });

  test("returns [] and does not fetch when allowNetwork is false", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const models = await createRefreshModels({})(fakeContext({ allowNetwork: false }));
    expect(models).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("returns [] and does not fetch when no credential is stored", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const models = await createRefreshModels({})(fakeContext({ credential: undefined }));
    expect(models).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("returns [] on network error without throwing", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("offline"); }));
    const models = await createRefreshModels({})(fakeContext());
    expect(models).toEqual([]);
  });

  test("returns [] on 401 without throwing", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 401 })));
    const models = await createRefreshModels({})(fakeContext());
    expect(models).toEqual([]);
  });

  test("returns [] on 5xx without throwing", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 503 })));
    const models = await createRefreshModels({})(fakeContext());
    expect(models).toEqual([]);
  });

  test("skips a reasoning model missing the pi block (not in the returned list)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      modelsResponse([
        { id: "ok-chat", capabilities: { tools: true } },
        { id: "broken-reasoner", capabilities: { reasoning: true } },
      ]),
    ));
    const models = await createRefreshModels({})(fakeContext());
    expect(models.map((m) => m.id)).toEqual(["ok-chat"]);
  });

  test("uses an injected fetch when provided (no global fetch needed)", async () => {
    const injected = vi.fn(async () => modelsResponse([{ id: "x" }]));
    const models = await createRefreshModels({}, { fetch: injected })(fakeContext());
    expect(models.map((m) => m.id)).toEqual(["x"]);
    expect(injected).toHaveBeenCalled();
  });
});
