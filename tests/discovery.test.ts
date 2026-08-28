import { beforeEach, describe, expect, test, vi } from "vitest";
import type { Api, Model, RefreshModelsContext } from "@earendil-works/pi-ai";
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
          id: "glm-5.2-vision",
          context_window: 1048576,
          max_output_tokens: 16384,
          capabilities: { reasoning: true, vision: true, tools: true },
          client_compat: {
            pi: {
              thinkingLevelMap: { off: null, high: "high" },
              thinkingFormat: "zai",
              maxTokensField: "max_tokens",
              supportsReasoningEffort: true,
            },
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
    expect(models[1]).toMatchObject({ id: "glm-5.2-vision", reasoning: true, input: ["text", "image"] });
    expect(models[1].thinkingLevelMap).toEqual({ off: null, high: "high" });
    expect(models[1].compat).toEqual({ thinkingFormat: "zai", maxTokensField: "max_tokens", supportsReasoningEffort: true });
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

  test("skips reasoning models with missing or null Pi compatibility metadata", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      modelsResponse([
        { id: "ok-chat", capabilities: { tools: true } },
        { id: "broken-reasoner", capabilities: { reasoning: true } },
        {
          id: "glm-5.2-vision-flex",
          capabilities: { reasoning: true, vision: true, tools: true },
          client_compat: null,
        },
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

describe("lunaroute refreshModels persist + restore", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  const storedModel = (id: string): Model<Api> => ({
    id,
    name: id,
    api: "openai-completions",
    provider: "lunaroute",
    baseUrl: "http://gw/v1",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 8192,
    maxTokens: 1024,
  });

  test("offline phase restores the persisted catalog without fetching or publishing", async () => {
    const fetchMock = vi.fn();
    const publish = vi.fn(async () => true);
    vi.stubGlobal("fetch", fetchMock);
    const models = await createRefreshModels({ LUNAROUTE_ROUTING_URL: "http://gw/v1" })(
      fakeContext({ allowNetwork: false, stored: { models: [storedModel("cached-1")], checkedAt: 1 }, publish }),
    );
    expect(models.map((m) => m.id)).toEqual(["cached-1"]);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
  });

  test("network phase persists the fetched catalog via context.publish({persist})", async () => {
    const publish = vi.fn(async (_publication: unknown) => true);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        modelsResponse([
          { id: "chat-1", display_name: "Chat 1", context_window: 8192, max_output_tokens: 1024, capabilities: { tools: true } },
          {
            id: "glm-5.2-vision-background",
            context_window: 1048576,
            max_output_tokens: 16384,
            capabilities: { reasoning: true, vision: true, tools: true },
            client_compat: { pi: { thinkingLevelMap: { off: null, high: "high" } } },
          },
        ]),
      ),
    );
    await createRefreshModels({ LUNAROUTE_ROUTING_URL: "http://gw/v1" })(fakeContext({ publish }));
    expect(publish).toHaveBeenCalledTimes(1);
    const arg = publish.mock.calls[0][0] as { persist: { models: Model<Api>[]; checkedAt: number } };
    expect(arg.persist.models).toHaveLength(2);
    expect(arg.persist.models[0]).toMatchObject({
      id: "chat-1",
      provider: "lunaroute",
      api: "openai-completions",
      baseUrl: "http://gw/v1",
    });
    expect(arg.persist.checkedAt).toEqual(expect.any(Number));
  });

  test("retains the persisted catalog when the network fetch throws", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("offline"); }));
    const models = await createRefreshModels({ LUNAROUTE_ROUTING_URL: "http://gw/v1" })(
      fakeContext({ stored: { models: [storedModel("cached-1")], checkedAt: 1 } }),
    );
    expect(models.map((m) => m.id)).toEqual(["cached-1"]);
  });

  test("retains the persisted catalog on a non-2xx response", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 401 })));
    const models = await createRefreshModels({ LUNAROUTE_ROUTING_URL: "http://gw/v1" })(
      fakeContext({ stored: { models: [storedModel("cached-1")], checkedAt: 1 } }),
    );
    expect(models.map((m) => m.id)).toEqual(["cached-1"]);
  });

  test("invokes onCatalogRefreshed after a successful fetch, not on failure", async () => {
    const onCatalogRefreshed = vi.fn();
    vi.stubGlobal("fetch", vi.fn(async () => modelsResponse([{ id: "x" }])));
    await createRefreshModels({}, { onCatalogRefreshed })(fakeContext());
    expect(onCatalogRefreshed).toHaveBeenCalledTimes(1);
    expect((onCatalogRefreshed.mock.calls[0][0] as { id: string }[]).map((m) => m.id)).toEqual(["x"]);
  });

  test("does not persist or notify onCatalogRefreshed when there is no credential", async () => {
    const publish = vi.fn(async () => true);
    const onCatalogRefreshed = vi.fn();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const models = await createRefreshModels({}, { onCatalogRefreshed })(
      fakeContext({ credential: undefined, publish }),
    );
    expect(models).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
    expect(onCatalogRefreshed).not.toHaveBeenCalled();
  });
});
