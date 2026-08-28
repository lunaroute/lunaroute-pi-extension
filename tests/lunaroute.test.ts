import { describe, expect, test } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_API_URL,
  DEFAULT_FRONT_URL,
  DEFAULT_MCP_URL,
  DEFAULT_ROUTING_URL,
  LUNAROUTE_ENV_API_URL,
  LUNAROUTE_ENV_FRONT_URL,
  LUNAROUTE_ENV_MCP_URL,
  LUNAROUTE_ENV_ROUTING_URL,
  LUNAROUTE_PROVIDER,
  buildAttributionHeaders,
  buildExchangeBody,
  buildPiAuthUrl,
  computePkceChallenge,
  generatePkceVerifier,
  generateSessionId,
  generateState,
  mapCatalogEntry,
  missingPiBlockWarning,
  parseCallbackQuery,
  resolveApiUrl,
  resolveCredentialKey,
  resolveFrontUrl,
  resolveMcpUrl,
  readPersistedModels,
  resolveRoutingUrl,
  firstRunHint,
} from "../src/lunaroute.js";

describe("lunaroute v2 helpers", () => {
  test("constants target the canonical provider, env vars, and defaults", () => {
    expect(LUNAROUTE_PROVIDER).toBe("lunaroute");
    expect(LUNAROUTE_ENV_ROUTING_URL).toBe("LUNAROUTE_ROUTING_URL");
    expect(LUNAROUTE_ENV_API_URL).toBe("LUNAROUTE_API_URL");
    expect(LUNAROUTE_ENV_FRONT_URL).toBe("LUNAROUTE_FRONT_URL");
    expect(LUNAROUTE_ENV_MCP_URL).toBe("LUNAROUTE_MCP_URL");
    expect(DEFAULT_ROUTING_URL).toBe("https://gw.lunaroute.com/v1");
    expect(DEFAULT_API_URL).toBe("https://api.lunaroute.com");
    expect(DEFAULT_FRONT_URL).toBe("https://app.lunaroute.com");
    expect(DEFAULT_MCP_URL).toBe("https://mcp.lunaroute.com/mcp");
  });

  test("URL resolvers prefer env vars, fall back to defaults", () => {
    expect(resolveRoutingUrl({})).toBe(DEFAULT_ROUTING_URL);
    expect(resolveRoutingUrl({ LUNAROUTE_ROUTING_URL: "http://localhost:8180/v1" })).toBe("http://localhost:8180/v1");
    expect(resolveApiUrl({})).toBe(DEFAULT_API_URL);
    expect(resolveApiUrl({ LUNAROUTE_API_URL: "http://localhost:8181" })).toBe("http://localhost:8181");
    expect(resolveFrontUrl({})).toBe(DEFAULT_FRONT_URL);
    expect(resolveFrontUrl({ LUNAROUTE_FRONT_URL: "http://localhost:3100" })).toBe("http://localhost:3100");
    expect(resolveMcpUrl({})).toBe(DEFAULT_MCP_URL);
    expect(resolveMcpUrl({ LUNAROUTE_MCP_URL: "http://localhost:9999/mcp" })).toBe("http://localhost:9999/mcp");
  });

  test("buildAttributionHeaders returns only the three v1 headers with a shared session id", () => {
    const headers = buildAttributionHeaders("0.84.1", "session-abc");
    expect(headers).toEqual({
      "lunaroute-agent": "pi/0.84.1",
      "x-lunaroute-session": "session-abc",
      "lunaroute-session-id": "session-abc",
    });
    expect(headers).not.toHaveProperty("User-Agent");
    expect(headers).not.toHaveProperty("user-agent");
  });

  test("generateSessionId uses randomUUID when available", () => {
    expect(generateSessionId(() => "11111111-1111-4111-8111-111111111111")).toBe("11111111-1111-4111-8111-111111111111");
  });

  test("generateSessionId falls back to a safe unique-looking string", () => {
    const id = generateSessionId(
      () => { throw new Error("unavailable"); },
      () => 1234567890,
      () => 0.5,
    );
    expect(id).toBe("lunaroute-pi-1234567890-i");
  });

  test("PKCE verifier and state are hex strings of the expected length", () => {
    expect(generatePkceVerifier()).toMatch(/^[0-9a-f]{64}$/);
    expect(generateState()).toMatch(/^[0-9a-f]{32}$/);
  });

  test("computePkceChallenge is the hex sha256 of the verifier (matches LunaRoute Go backend)", () => {
    expect(computePkceChallenge("verifier")).toBe(
      "88c9eae68eb300b2971a2bec9e5a26ff4179fd661d6b7d861e4c6557b9aaee14",
    );
  });

  test("buildPiAuthUrl assembles the pi-auth link with port, state, and challenge", () => {
    const url = buildPiAuthUrl("https://app.lunaroute.com", 34567, "the-state", "the-challenge");
    expect(url).toBe(
      "https://app.lunaroute.com/device-auth/pi?port=34567&state=the-state&challenge=the-challenge",
    );
  });

  test("parseCallbackQuery extracts code and state from a loopback callback URL", () => {
    expect(parseCallbackQuery("http://127.0.0.1:34567/callback?code=abc&state=xyz")).toEqual({ code: "abc", state: "xyz" });
    expect(parseCallbackQuery("/callback?code=only")).toEqual({ code: "only", state: "" });
    expect(parseCallbackQuery("/callback?state=no-code")).toEqual({ code: "", state: "no-code" });
  });

  test("buildExchangeBody serializes the exchange request as JSON", () => {
    const body = buildExchangeBody({ code: "c", verifier: "v", label: "host" });
    expect(JSON.parse(body)).toEqual({ code: "c", verifier: "v", label: "host" });
  });

  test("resolveCredentialKey reads access from an oauth credential and key from an api_key credential", () => {
    expect(resolveCredentialKey(undefined)).toBeUndefined();
    expect(resolveCredentialKey({ type: "oauth", access: "lr_abc", refresh: "", expires: 1 })).toBe("lr_abc");
    expect(resolveCredentialKey({ type: "api_key", key: "lr_xyz" })).toBe("lr_xyz");
    expect(resolveCredentialKey({ type: "api_key" })).toBeUndefined();
  });

  test("mapCatalogEntry maps a non-reasoning model with window/maxTokens/modality and zero cost", () => {
    const result = mapCatalogEntry({
      id: "chat-1",
      display_name: "Chat 1",
      context_window: 8192,
      max_output_tokens: 1024,
      capabilities: { tools: true, vision: false },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.model).toEqual({
      id: "chat-1",
      name: "Chat 1",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 8192,
      maxTokens: 1024,
    });
  });

  test("mapCatalogEntry maps vision capability to text+image input", () => {
    const result = mapCatalogEntry({ id: "v", capabilities: { vision: true } });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.model.input).toEqual(["text", "image"]);
  });

  test("mapCatalogEntry maps a reasoning model with the pi block (thinkingLevelMap + compat)", () => {
    const result = mapCatalogEntry({
      id: "glm-5.2",
      context_window: 1048576,
      max_output_tokens: 16384,
      capabilities: { reasoning: true, tools: true },
      pi: {
        thinkingLevelMap: { off: null, minimal: "high", low: "high", medium: "high", high: "high", xhigh: "max" },
        compat: { thinkingFormat: "zai", maxTokensField: "max_tokens", supportsReasoningEffort: false },
      },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.model.reasoning).toBe(true);
    expect(result.model.thinkingLevelMap).toEqual({ off: null, minimal: "high", low: "high", medium: "high", high: "high", xhigh: "max" });
    expect(result.model.compat).toEqual({ thinkingFormat: "zai", maxTokensField: "max_tokens", supportsReasoningEffort: false });
    expect(result.model.contextWindow).toBe(1048576);
    expect(result.model.maxTokens).toBe(16384);
  });

  test("mapCatalogEntry maps client_compat.pi reasoning fields", () => {
    const thinkingLevelMap = {
      off: null,
      minimal: "high",
      low: "high",
      medium: "high",
      high: "high",
      xhigh: "max",
    } as const;

    const result = mapCatalogEntry({
      id: "glm-5.2-vision",
      display_name: "GLM 5.2 Vision",
      context_window: 131_072,
      max_output_tokens: 65_536,
      capabilities: { reasoning: true, vision: true, tools: true },
      client_compat: {
        pi: {
          maxTokensField: "max_tokens",
          supportsReasoningEffort: true,
          thinkingFormat: "zai",
          thinkingLevelMap,
        },
      },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.model).toMatchObject({
      id: "glm-5.2-vision",
      name: "GLM 5.2 Vision",
      reasoning: true,
      input: ["text", "image"],
      contextWindow: 131_072,
      maxTokens: 65_536,
      thinkingLevelMap,
      compat: {
        maxTokensField: "max_tokens",
        supportsReasoningEffort: true,
        thinkingFormat: "zai",
      },
    });
  });

  test("mapCatalogEntry skips a reasoning model that is missing the pi block", () => {
    const result = mapCatalogEntry({ id: "broken-reasoner", capabilities: { reasoning: true } });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("reasoning_missing_pi_block");
    expect(result.id).toBe("broken-reasoner");
  });

  test("mapCatalogEntry skips glm-5.2-vision-flex when client_compat is null", () => {
    const result = mapCatalogEntry({
      id: "glm-5.2-vision-flex",
      capabilities: { reasoning: true, vision: true, tools: true },
      client_compat: null,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("reasoning_missing_pi_block");
    expect(result.id).toBe("glm-5.2-vision-flex");
  });

  test("mapCatalogEntry falls back to id for name when display_name is absent and defaults window/maxTokens to 0", () => {
    const result = mapCatalogEntry({ id: "bare" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.model.name).toBe("bare");
    expect(result.model.contextWindow).toBe(0);
    expect(result.model.maxTokens).toBe(0);
  });

  test("mapCatalogEntry does not attach pi block fields to a non-reasoning model", () => {
    const result = mapCatalogEntry({
      id: "chat-with-stray-pi",
      capabilities: { reasoning: false },
      pi: {
        thinkingLevelMap: { off: null, high: "high" },
        compat: { thinkingFormat: "zai", maxTokensField: "max_tokens", supportsReasoningEffort: false },
      },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.model.reasoning).toBe(false);
    expect(result.model.thinkingLevelMap).toBeUndefined();
    expect(result.model.compat).toBeUndefined();
  });

  test("warning text helpers do not leak secrets", () => {
    expect(missingPiBlockWarning("glm-x")).toContain("glm-x");
    expect(missingPiBlockWarning("glm-x")).not.toContain("lr_");
    expect(firstRunHint()).toContain("/login lunaroute");
  });
});

describe("readPersistedModels", () => {
  const storedModel = {
    id: "glm-5.3-flash-background",
    name: "glm-5.3-flash-background",
    api: "openai-completions",
    provider: "lunaroute",
    baseUrl: "https://gw.lunaroute.com/v1",
    reasoning: true,
    input: ["text", "image"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 524288,
    maxTokens: 131072,
  };

  test("reads the lunaroute snapshot from Pi's models-store.json under PI_CODING_AGENT_DIR", () => {
    const dir = mkdtempSync(join(tmpdir(), "lr-store-"));
    writeFileSync(join(dir, "models-store.json"), JSON.stringify({ lunaroute: { models: [storedModel], checkedAt: 1 } }));
    const models = readPersistedModels({ PI_CODING_AGENT_DIR: dir });
    expect(models).toHaveLength(1);
    expect(models[0].id).toBe("glm-5.3-flash-background");
    expect(models[0].api).toBe("openai-completions");
  });

  test("falls back to ~/.pi/agent when PI_CODING_AGENT_DIR is unset", () => {
    const models = readPersistedModels({});
    // The real agent dir may or may not have a snapshot; it must at least not throw.
    expect(Array.isArray(models)).toBe(true);
  });

  test("returns [] for a missing, corrupt, or empty store", () => {
    const dir = mkdtempSync(join(tmpdir(), "lr-store-"));
    expect(readPersistedModels({ PI_CODING_AGENT_DIR: dir })).toEqual([]);
    writeFileSync(join(dir, "models-store.json"), "not json{");
    expect(readPersistedModels({ PI_CODING_AGENT_DIR: dir })).toEqual([]);
    writeFileSync(join(dir, "models-store.json"), JSON.stringify({ lunaroute: { models: [] } }));
    expect(readPersistedModels({ PI_CODING_AGENT_DIR: dir })).toEqual([]);
    writeFileSync(join(dir, "models-store.json"), JSON.stringify({ lunaroute: { models: [{ nope: true }, storedModel] } }));
    expect(readPersistedModels({ PI_CODING_AGENT_DIR: dir })).toEqual([storedModel]);
  });
});
