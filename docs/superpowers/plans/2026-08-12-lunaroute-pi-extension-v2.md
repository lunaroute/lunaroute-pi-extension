# LunaRoute Pi Extension v2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the v1 header-only override with a complete Pi provider that the user enables by logging in (`/login lunaroute`) and that auto-syncs its model list from LunaRoute's `/v1/models` catalog with correct reasoning configuration.

**Architecture:** The extension registers a single `lunaroute` provider via `pi.registerProvider("lunaroute", ProviderConfig)` on Pi >= 0.84.1. The provider owns identity (baseUrl, `openai-completions`), auth (an `oauth` block offering browser or paste-an-API-key login; the `lr_` key is stored in `~/.pi/agent/auth.json`, never in `models.json`), models (a `refreshModels(context)` that fetches `GET {baseUrl}/models` with the resolved key and maps entries to Pi models), and the three LunaRoute attribution headers. Pure helpers live in `lunaroute.ts`; IO-bearing login orchestration in `login.ts`; discovery in `discovery.ts`; wiring in `index.ts`.

**Tech Stack:** TypeScript, Node.js 22+, Pi extension API (`@earendil-works/pi-coding-agent` >= 0.84.1, `@earendil-works/pi-ai` >= 0.84.1), Vitest, npm.

**Spec:** `docs/superpowers/specs/2026-08-12-lunaroute-pi-extension-v2-design.md`

## Global Constraints

- Target Pi **>= 0.84.1**; declare `@earendil-works/pi-coding-agent` and `@earendil-works/pi-ai` as peer deps `>= 0.84.1` and dev deps `^0.84.1`.
- **Never** write the API key or models to `~/.pi/agent/models.json`. The key lives in `~/.pi/agent/auth.json` (Pi-managed); models live in Pi's runtime registry via `refreshModels`.
- v1 was never deployed, so v2 has **no migration path**: delete v1's wiring; carry forward only `buildAttributionHeaders` and `generateSessionId`.
- v2 is **blocked on** `lunaroute-saas` kata issue `vkd3` (the gateway `/v1/models` must return the `pi` compat block for reasoning models). The extension code is complete without it, but reasoning models are skipped until `vkd3` ships.
- Target only provider name `lunaroute`. Do not target `lunaroute11111` or other test providers.
- Do not modify the HTTP `User-Agent` header.
- PKCE uses **hex-encoded SHA-256** (not base64url S256) to match LunaRoute's Go backend (`sha256hexStr`) and the existing `lunaroute-cli`. The exchange endpoint is `POST {apiUrl}/v1/auth/exchange` (the neutral pi-plugin alias, not `/v1/auth/cli/exchange`).
- Production default URLs (`https://gw.lunaroute.com/v1`, `https://api.lunaroute.com`, `https://app.lunaroute.com`) are best-known values; confirm against the deployed LunaRoute environment before release. All three are overridable via `LUNAROUTE_ROUTING_URL` / `LUNAROUTE_API_URL` / `LUNAROUTE_FRONT_URL`.
- `refreshModels` has no UI channel in `RefreshModelsContext`; it returns `[]` on failure and does not throw. User-facing unconfigured-state messaging comes from the `session_start` handler only.
- The paste-an-API-key path uses `OAuthLoginCallbacks.onPrompt`, which Pi renders as **plain (unmasked) text** (`provider-composer.js` maps it to `prompt({type:"text"})`). This is an accepted consequence of the `oauth` form choice (needed for credential-aware `refreshModels`). The browser path is unaffected.

---

## File Structure

- `package.json` — manifest; version 0.2.0; Pi + pi-ai peer/dev deps; `open` is NOT a dependency (Pi opens the browser on `onAuth`).
- `src/lunaroute.ts` — pure helpers: constants, URL resolvers, attribution headers, session ID, PKCE, auth-URL builder, callback parser, exchange-body builder, credential-key resolver, catalog mapper, warning text.
- `src/login.ts` — `oauth` implementation: `lunarouteLogin` orchestrator (browser/paste), `loginWithBrowser`, `loginWithPaste`, real `startLoopbackServer` (`node:http`), real `exchangeCode` (`fetch`), and the exported `lunarouteOAuth` block.
- `src/discovery.ts` — `createRefreshModels(env, deps?)` returning a `refreshModels(context)` that fetches `/v1/models` and maps to `ProviderModelConfig[]`.
- `src/index.ts` — extension entrypoint: `registerProvider("lunaroute", …)` + `session_start` first-run hint.
- `tests/lunaroute.test.ts` — pure-helper unit tests.
- `tests/login.test.ts` — login orchestrator unit tests (injected loopback/exchange; no real network/ports).
- `tests/discovery.test.ts` — `refreshModels` unit tests (injected fetch; fake `RefreshModelsContext`).
- `tests/index.test.ts` — registration wiring tests with a fake `pi` + fake context.
- `README.md` — v2 install/login/usage docs + manual smoke test.

---

### Task 1: Bump Pi to v2, add pi-ai peer dep, remove v1 wiring

**Files:**
- Modify: `package.json`
- Delete: `src/index.ts` (v1 wiring, replaced in Task 5)
- Delete: `tests/index.test.ts` (v1 wiring tests, replaced in Task 5)

**Interfaces:**
- Consumes: nothing.
- Produces: a package manifest on Pi ^0.84.1 + pi-ai ^0.84.1; `src/lunaroute.ts` and `tests/lunaroute.test.ts` continue to pass (v1 helpers remain temporarily as unused exports; they are rewritten in Task 2).

Note: After this task `package.json` still references `./src/index.ts` in `pi.extensions`, which no longer exists. `npm run check` (tsc + vitest) does not load the extension entrypoint, so it stays green; the entrypoint is restored in Task 5. Do not run `pi -e .` between Task 1 and Task 5.

- [ ] **Step 1: Update `package.json`**

Replace the `version`, `description`, `peerDependencies`, and `devDependencies` blocks so the file reads (keep `name`, `type`, `keywords`, `license`, `publishConfig`, `files`, `scripts`, `pi` exactly as v1 except the fields shown):

```json
{
  "name": "@lunaroute/pi-extension",
  "version": "0.2.0",
  "description": "Pi extension for LunaRoute: login, model sync, and request attribution.",
  "type": "module",
  "keywords": [
    "pi-package",
    "lunaroute",
    "pi-extension"
  ],
  "license": "MIT",
  "publishConfig": {
    "access": "restricted"
  },
  "files": [
    "src",
    "README.md",
    "LICENSE"
  ],
  "scripts": {
    "typecheck": "tsc --noEmit",
    "test": "vitest run",
    "check": "npm run typecheck && npm test"
  },
  "pi": {
    "extensions": [
      "./src/index.ts"
    ]
  },
  "peerDependencies": {
    "@earendil-works/pi-coding-agent": ">=0.84.1",
    "@earendil-works/pi-ai": ">=0.84.1"
  },
  "devDependencies": {
    "@earendil-works/pi-coding-agent": "^0.84.1",
    "@earendil-works/pi-ai": "^0.84.1",
    "@types/node": "^24.0.0",
    "typescript": "^5.9.0",
    "vitest": "^4.1.0"
  }
}
```

- [ ] **Step 2: Install the new dev deps**

Run: `npm install`
Expected: `package-lock.json` updates to pull `@earendil-works/pi-ai@0.84.1` (transitively already present under pi-coding-agent; now also a direct dev dep) and `@earendil-works/pi-coding-agent@0.84.1`. npm exits 0.

- [ ] **Step 3: Delete v1 wiring (replaced in Task 5)**

Run:
```bash
git rm src/index.ts tests/index.test.ts
```
Expected: both files removed.

- [ ] **Step 4: Verify the helper tests still pass against the new types**

Run: `npm run check`
Expected: `tsc --noEmit` passes (v1 `src/lunaroute.ts` exports are now unused but that is not an error; `tests/lunaroute.test.ts` only imports from `./lunaroute.js` and still passes — 8 tests). `npm run check` exits 0.

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore: bump to pi v2 (pi ^0.84.1, pi-ai peer dep); remove v1 wiring"
```
Expected: commit succeeds.

---

### Task 2: v2 pure helpers (`src/lunaroute.ts`)

**Files:**
- Rewrite: `src/lunaroute.ts`
- Rewrite: `tests/lunaroute.test.ts`

**Interfaces:**
- Consumes: `node:crypto` (`randomUUID`, `randomBytes`, `createHash`), `node:os` (`hostname`), types from `@earendil-works/pi-ai` (`Credential`, `OpenAICompletionsCompat`, `ThinkingLevelMap`), `ProviderModelConfig` from `@earendil-works/pi-coding-agent`.
- Produces (exported, used by later tasks):
  - `LUNAROUTE_PROVIDER`, `LUNAROUTE_ENV_ROUTING_URL`, `LUNAROUTE_ENV_API_URL`, `LUNAROUTE_ENV_FRONT_URL`, `DEFAULT_ROUTING_URL`, `DEFAULT_API_URL`, `DEFAULT_FRONT_URL`
  - `resolveRoutingUrl(env): string`, `resolveApiUrl(env): string`, `resolveFrontUrl(env): string`
  - `buildAttributionHeaders(version: string, sessionId: string): Record<string, string>`
  - `generateSessionId(randomUuid?, now?, random?): string`
  - `generatePkceVerifier(): string`, `computePkceChallenge(verifier: string): string`, `generateState(): string`
  - `buildPiAuthUrl(frontUrl: string, port: number, state: string, challenge: string): string`
  - `parseCallbackQuery(callbackUrl: string): { code: string; state: string }`
  - `buildExchangeBody(req: ExchangeRequest): string` and types `ExchangeRequest`, `ExchangeResponse`
  - `resolveCredentialKey(credential: Credential | undefined): string | undefined`
  - `mapCatalogEntry(entry: GatewayModelObject): CatalogMappingResult` and types `GatewayModelObject`, `GatewayPiBlock`, `CatalogMappingResult`
  - `missingPiBlockWarning(id: string): string`, `firstRunHint(): string`

- [ ] **Step 1: Write the failing helper tests**

Create `tests/lunaroute.test.ts` with this exact content:

```ts
import { describe, expect, test } from "vitest";
import {
  DEFAULT_API_URL,
  DEFAULT_FRONT_URL,
  DEFAULT_ROUTING_URL,
  LUNAROUTE_ENV_API_URL,
  LUNAROUTE_ENV_FRONT_URL,
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
  resolveRoutingUrl,
  firstRunHint,
} from "../src/lunaroute.js";

describe("lunaroute v2 helpers", () => {
  test("constants target the canonical provider, env vars, and defaults", () => {
    expect(LUNAROUTE_PROVIDER).toBe("lunaroute");
    expect(LUNAROUTE_ENV_ROUTING_URL).toBe("LUNAROUTE_ROUTING_URL");
    expect(LUNAROUTE_ENV_API_URL).toBe("LUNAROUTE_API_URL");
    expect(LUNAROUTE_ENV_FRONT_URL).toBe("LUNAROUTE_FRONT_URL");
    expect(DEFAULT_ROUTING_URL).toBe("https://gw.lunaroute.com/v1");
    expect(DEFAULT_API_URL).toBe("https://api.lunaroute.com");
    expect(DEFAULT_FRONT_URL).toBe("https://app.lunaroute.com");
  });

  test("URL resolvers prefer env vars, fall back to defaults", () => {
    expect(resolveRoutingUrl({})).toBe(DEFAULT_ROUTING_URL);
    expect(resolveRoutingUrl({ LUNAROUTE_ROUTING_URL: "http://localhost:8180/v1" })).toBe("http://localhost:8180/v1");
    expect(resolveApiUrl({})).toBe(DEFAULT_API_URL);
    expect(resolveApiUrl({ LUNAROUTE_API_URL: "http://localhost:8181" })).toBe("http://localhost:8181");
    expect(resolveFrontUrl({})).toBe(DEFAULT_FRONT_URL);
    expect(resolveFrontUrl({ LUNAROUTE_FRONT_URL: "http://localhost:3100" })).toBe("http://localhost:3100");
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
      "https://app.lunaroute.com/pi-auth?port=34567&state=the-state&challenge=the-challenge",
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

  test("mapCatalogEntry skips a reasoning model that is missing the pi block", () => {
    const result = mapCatalogEntry({ id: "broken-reasoner", capabilities: { reasoning: true } });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("reasoning_missing_pi_block");
    expect(result.id).toBe("broken-reasoner");
  });

  test("mapCatalogEntry falls back to id for name when display_name is absent and defaults window/maxTokens to 0", () => {
    const result = mapCatalogEntry({ id: "bare" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.model.name).toBe("bare");
    expect(result.model.contextWindow).toBe(0);
    expect(result.model.maxTokens).toBe(0);
  });

  test("warning text helpers do not leak secrets", () => {
    expect(missingPiBlockWarning("glm-x")).toContain("glm-x");
    expect(missingPiBlockWarning("glm-x")).not.toContain("lr_");
    expect(firstRunHint()).toContain("/login lunaroute");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- tests/lunaroute.test.ts`
Expected: FAIL — the v2 exports do not exist yet (v1 `lunaroute.ts` does not export `resolveRoutingUrl`, `generatePkceVerifier`, `mapCatalogEntry`, etc.).

- [ ] **Step 3: Implement the v2 pure helpers**

Rewrite `src/lunaroute.ts` with this exact content:

```ts
import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { Credential, OpenAICompletionsCompat, ThinkingLevelMap } from "@earendil-works/pi-ai";
import type { ProviderModelConfig } from "@earendil-works/pi-coding-agent";

export const LUNAROUTE_PROVIDER = "lunaroute";
export const LUNAROUTE_ENV_ROUTING_URL = "LUNAROUTE_ROUTING_URL";
export const LUNAROUTE_ENV_API_URL = "LUNAROUTE_API_URL";
export const LUNAROUTE_ENV_FRONT_URL = "LUNAROUTE_FRONT_URL";

// Production defaults — confirm against the deployed LunaRoute environment before release.
export const DEFAULT_ROUTING_URL = "https://gw.lunaroute.com/v1";
export const DEFAULT_API_URL = "https://api.lunaroute.com";
export const DEFAULT_FRONT_URL = "https://app.lunaroute.com";

export function resolveRoutingUrl(env: NodeJS.ProcessEnv): string {
  return env[LUNAROUTE_ENV_ROUTING_URL] || DEFAULT_ROUTING_URL;
}
export function resolveApiUrl(env: NodeJS.ProcessEnv): string {
  return env[LUNAROUTE_ENV_API_URL] || DEFAULT_API_URL;
}
export function resolveFrontUrl(env: NodeJS.ProcessEnv): string {
  return env[LUNAROUTE_ENV_FRONT_URL] || DEFAULT_FRONT_URL;
}

export function buildAttributionHeaders(version: string, sessionId: string): Record<string, string> {
  return {
    "lunaroute-agent": `pi/${version}`,
    "x-lunaroute-session": sessionId,
    "lunaroute-session-id": sessionId,
  };
}

export function generateSessionId(
  randomUuid: () => string = randomUUID,
  now: () => number = Date.now,
  random: () => number = Math.random,
): string {
  try {
    return randomUuid();
  } catch {
    return `lunaroute-pi-${now()}-${random().toString(36).slice(2, 10)}`;
  }
}

// PKCE — hex sha256 to match LunaRoute's Go backend (sha256hexStr) and lunaroute-cli.
export function generatePkceVerifier(): string {
  return randomBytes(32).toString("hex");
}
export function computePkceChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("hex");
}
export function generateState(): string {
  return randomBytes(16).toString("hex");
}

export function buildPiAuthUrl(frontUrl: string, port: number, state: string, challenge: string): string {
  const params = new URLSearchParams({ port: String(port), state, challenge });
  return `${frontUrl}/pi-auth?${params.toString()}`;
}

export function parseCallbackQuery(callbackUrl: string): { code: string; state: string } {
  const url = new URL(callbackUrl, "http://127.0.0.1");
  return { code: url.searchParams.get("code") ?? "", state: url.searchParams.get("state") ?? "" };
}

export type ExchangeRequest = { code: string; verifier: string; label: string };
export type ExchangeResponse = {
  full_key: string;
  org_id: string;
  user_email: string;
  routing_url?: string;
  api_url?: string;
};

export function buildExchangeBody(req: ExchangeRequest): string {
  return JSON.stringify(req);
}

export function resolveCredentialKey(credential: Credential | undefined): string | undefined {
  if (!credential) return undefined;
  if (credential.type === "oauth") return credential.access;
  if (credential.type === "api_key") return credential.key;
  return undefined;
}

export type GatewayPiBlock = {
  thinkingLevelMap?: ThinkingLevelMap;
  compat?: Pick<OpenAICompletionsCompat, "thinkingFormat" | "maxTokensField" | "supportsReasoningEffort">;
};

export type GatewayModelObject = {
  id: string;
  display_name?: string;
  context_window?: number;
  max_output_tokens?: number;
  capabilities?: Record<string, boolean>;
  pi?: GatewayPiBlock;
};

export type CatalogMappingResult =
  | { ok: true; model: ProviderModelConfig }
  | { ok: false; reason: "reasoning_missing_pi_block"; id: string };

export function mapCatalogEntry(entry: GatewayModelObject): CatalogMappingResult {
  const reasoning = entry.capabilities?.reasoning === true;
  const input: ("text" | "image")[] = entry.capabilities?.vision === true ? ["text", "image"] : ["text"];

  if (reasoning && !entry.pi) {
    return { ok: false, reason: "reasoning_missing_pi_block", id: entry.id };
  }

  const model: ProviderModelConfig = {
    id: entry.id,
    name: entry.display_name ?? entry.id,
    reasoning,
    input,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: entry.context_window ?? 0,
    maxTokens: entry.max_output_tokens ?? 0,
  };
  if (entry.pi?.thinkingLevelMap) model.thinkingLevelMap = entry.pi.thinkingLevelMap;
  if (entry.pi?.compat) model.compat = entry.pi.compat;
  return { ok: true, model };
}

export function missingPiBlockWarning(id: string): string {
  return `LunaRoute model "${id}" supports reasoning but the catalog did not include Pi compatibility metadata. Skipping it. (Requires LunaRoute server issue vkd3.)`;
}

export function firstRunHint(): string {
  return "Run `/login lunaroute` to start using LunaRoute.";
}
```

- [ ] **Step 4: Run helper tests to verify they pass**

Run: `npm test -- tests/lunaroute.test.ts`
Expected: PASS — all tests in `tests/lunaroute.test.ts` pass.

- [ ] **Step 5: Run typecheck**

Run: `npm run typecheck`
Expected: PASS with no TypeScript errors.

- [ ] **Step 6: Commit**

```bash
git add src/lunaroute.ts tests/lunaroute.test.ts
git commit -m "feat: add v2 pure helpers (headers, pkce, url builders, catalog mapper)"
```
Expected: commit succeeds.

---

### Task 3: Login flow (`src/login.ts`)

**Files:**
- Create: `src/login.ts`
- Create: `tests/login.test.ts`

**Interfaces:**
- Consumes from Task 2: `resolveFrontUrl`, `resolveApiUrl`, `generatePkceVerifier`, `computePkceChallenge`, `generateState`, `buildPiAuthUrl`, `parseCallbackQuery`, `buildExchangeBody`, types `ExchangeRequest`, `ExchangeResponse`.
- Consumes from pi-ai: `OAuthLoginCallbacks`, `OAuthCredentials`.
- Consumes from Node: `node:http`, `node:os` (`hostname`), global `fetch`.
- Produces (exported, used by Task 5):
  - `lunarouteOAuth: { name: string; login(cb: OAuthLoginCallbacks): Promise<OAuthCredentials>; refreshToken(c, signal): Promise<OAuthCredentials>; getApiKey(c): string }`
  - `lunarouteLogin(callbacks, env, deps?): Promise<string>` (testable orchestrator)
  - `loginWithBrowser(callbacks, env, deps?): Promise<string>`
  - `loginWithPaste(callbacks): Promise<string>`
  - `startLoopbackServer(): Promise<LoopbackServer>` (real `node:http`)
  - `exchangeCode(apiUrl, req, signal?): Promise<ExchangeResponse>` (real `fetch`)
  - type `LoopbackServer = { port: number; waitForCallback(): Promise<{ code: string; state: string }>; close(): void }`

- [ ] **Step 1: Write the failing login tests**

Create `tests/login.test.ts` with this exact content:

```ts
import { beforeEach, describe, expect, test, vi } from "vitest";
import type { OAuthLoginCallbacks, OAuthCredentials } from "@earendil-works/pi-ai";
import {
  exchangeCode,
  loginWithBrowser,
  loginWithPaste,
  lunarouteLogin,
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

describe("lunaroute login", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

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
      url: expect.stringMatching(/^http:\/\/front\/pi-auth\?port=39999&state=the-state&challenge=/),
      instructions: "Complete login in your browser.",
    });
    expect(exchange).toHaveBeenCalledWith("http://api", {
      code: "the-code",
      verifier: "the-verifier",
      label: expect.any(String),
    });
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- tests/login.test.ts`
Expected: FAIL — `src/login.ts` does not exist.

- [ ] **Step 3: Implement the login flow**

Create `src/login.ts` with this exact content:

```ts
import { createServer, type Server } from "node:http";
import { hostname } from "node:os";
import type { OAuthCredentials, OAuthLoginCallbacks } from "@earendil-works/pi-ai";
import {
  buildExchangeBody,
  buildPiAuthUrl,
  computePkceChallenge,
  generatePkceVerifier,
  generateState,
  parseCallbackQuery,
  resolveApiUrl,
  resolveFrontUrl,
  type ExchangeRequest,
  type ExchangeResponse,
} from "./lunaroute.js";

const LOGIN_TIMEOUT_MS = 3 * 60_000;
const FAR_FUTURE_MS = 10 * 365 * 24 * 60 * 60 * 1000;

export type LoopbackServer = {
  port: number;
  waitForCallback(): Promise<{ code: string; state: string }>;
  close(): void;
};

/** Real loopback server on 127.0.0.1:0 listening for /callback?code=&state=. */
export async function startLoopbackServer(): Promise<LoopbackServer> {
  let resolveCb: (r: { code: string; state: string }) => void;
  const cbPromise = new Promise<{ code: string; state: string }>((r) => (resolveCb = r));
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname !== "/callback") {
      res.statusCode = 404;
      res.end("not found");
      return;
    }
    const { code, state } = parseCallbackQuery(url.toString());
    res.statusCode = 200;
    res.setHeader("Content-Type", "text/html");
    res.end("<html><body><h2>LunaRoute authorized.</h2><p>You can close this tab and return to pi.</p></body></html>");
    resolveCb({ code, state });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  return { port, waitForCallback: () => cbPromise, close: () => server.close() };
}

/** Real exchange: POST {apiUrl}/v1/auth/exchange. */
export async function exchangeCode(
  apiUrl: string,
  req: ExchangeRequest,
  _signal?: AbortSignal,
): Promise<ExchangeResponse> {
  const res = await fetch(`${apiUrl}/v1/auth/exchange`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: buildExchangeBody(req),
  });
  if (!res.ok) {
    let detail = `HTTP ${res.status}`;
    try {
      const body = (await res.json()) as { error?: { code?: string; message?: string } };
      const code = body?.error?.code;
      const message = body?.error?.message;
      if (code && message) detail = `${code}: ${message}`;
      else if (code) detail = code;
      else if (message) detail = message;
    } catch {
      /* ignore */
    }
    throw new Error(`exchange failed: ${detail}`);
  }
  return (await res.json()) as ExchangeResponse;
}

export type LoginDeps = {
  startLoopback?: () => Promise<LoopbackServer>;
  exchange?: (apiUrl: string, req: ExchangeRequest, signal?: AbortSignal) => Promise<ExchangeResponse>;
  state?: () => string;
  verifier?: () => string;
};

const defaultDeps: LoginDeps = {
  startLoopback: startLoopbackServer,
  exchange: exchangeCode,
  state: generateState,
  verifier: generatePkceVerifier,
};

export async function loginWithBrowser(
  callbacks: OAuthLoginCallbacks,
  env: NodeJS.ProcessEnv,
  deps: LoginDeps = defaultDeps,
): Promise<string> {
  const d = { ...defaultDeps, ...deps };
  const verifier = d.verifier!();
  const challenge = computePkceChallenge(verifier);
  const state = d.state!();

  const server = await d.startLoopback!();
  try {
    const url = buildPiAuthUrl(resolveFrontUrl(env), server.port, state, challenge);
    callbacks.onAuth({ url, instructions: "Complete login in your browser." });

    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("timed out waiting for browser authorization")), LOGIN_TIMEOUT_MS);
    });
    try {
      const cb = await Promise.race([server.waitForCallback(), timeout]);
      if (cb.state !== state) throw new Error("state mismatch");
      const result = await d.exchange!(resolveApiUrl(env), {
        code: cb.code,
        verifier,
        label: hostname(),
      });
      return result.full_key;
    } finally {
      if (timer) clearTimeout(timer);
    }
  } finally {
    server.close();
  }
}

export async function loginWithPaste(callbacks: OAuthLoginCallbacks): Promise<string> {
  const key = (await callbacks.onPrompt({ message: "Paste your LunaRoute API key (lr_...)" })).trim();
  return key;
}

export async function lunarouteLogin(
  callbacks: OAuthLoginCallbacks,
  env: NodeJS.ProcessEnv,
  deps: LoginDeps = defaultDeps,
): Promise<OAuthCredentials> {
  const method = await callbacks.onSelect({
    message: "Log in to LunaRoute",
    options: [
      { id: "browser", label: "Log in with browser" },
      { id: "paste", label: "Paste an API key" },
    ],
  });
  if (!method) throw new Error("Login cancelled");

  let key: string;
  if (method === "browser") {
    key = await loginWithBrowser(callbacks, env, deps);
  } else if (method === "paste") {
    key = await loginWithPaste(callbacks);
  } else {
    throw new Error(`Unknown login method: ${method}`);
  }
  if (!key) throw new Error("No API key provided");
  return { access: key, refresh: "", expires: Date.now() + FAR_FUTURE_MS };
}

export const lunarouteOAuth = {
  name: "LunaRoute",
  async login(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
    return lunarouteLogin(callbacks, process.env);
  },
  async refreshToken(creds: OAuthCredentials, _signal: AbortSignal): Promise<OAuthCredentials> {
    return creds;
  },
  getApiKey(creds: OAuthCredentials): string {
    return creds.access;
  },
};
```

- [ ] **Step 4: Run login tests to verify they pass**

Run: `npm test -- tests/login.test.ts`
Expected: PASS — all login tests pass.

- [ ] **Step 5: Run typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/login.ts tests/login.test.ts
git commit -m "feat: add lunaroute login (browser + paste) and exchange"
```
Expected: commit succeeds.

---

### Task 4: Discovery (`src/discovery.ts`)

**Files:**
- Create: `src/discovery.ts`
- Create: `tests/discovery.test.ts`

**Interfaces:**
- Consumes from Task 2: `resolveRoutingUrl`, `resolveCredentialKey`, `mapCatalogEntry`, `missingPiBlockWarning`, types `GatewayModelObject`, `CatalogMappingResult`.
- Consumes from pi-ai: `RefreshModelsContext`, `Credential`, `OAuthCredentials`.
- Consumes from pi-coding-agent: `ProviderModelConfig`.
- Produces (exported, used by Task 5): `createRefreshModels(env, deps?): (context: RefreshModelsContext) => Promise<ProviderModelConfig[]>`.

- [ ] **Step 1: Write the failing discovery tests**

Create `tests/discovery.test.ts` with this exact content:

```ts
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
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- tests/discovery.test.ts`
Expected: FAIL — `src/discovery.ts` does not exist.

- [ ] **Step 3: Implement discovery**

Create `src/discovery.ts` with this exact content:

```ts
import type { ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import type { RefreshModelsContext } from "@earendil-works/pi-ai";
import {
  mapCatalogEntry,
  resolveCredentialKey,
  resolveRoutingUrl,
  type GatewayModelObject,
} from "./lunaroute.js";

export type DiscoveryDeps = {
  fetch?: typeof fetch;
};

export function createRefreshModels(
  env: NodeJS.ProcessEnv,
  deps: DiscoveryDeps = {},
): (context: RefreshModelsContext) => Promise<ProviderModelConfig[]> {
  const doFetch = deps.fetch ?? fetch;
  return async (context) => {
    if (!context.allowNetwork) return [];
    const key = resolveCredentialKey(context.credential);
    if (!key) return [];

    const baseUrl = resolveRoutingUrl(env);
    try {
      const res = await doFetch(`${baseUrl}/models`, {
        signal: context.signal,
        headers: { Authorization: `Bearer ${key}` },
      });
      if (!res.ok) return [];
      const body = (await res.json()) as { data?: GatewayModelObject[] };
      const entries = body.data ?? [];

      const models: ProviderModelConfig[] = [];
      for (const entry of entries) {
        const result = mapCatalogEntry(entry);
        if (result.ok) models.push(result.model);
      }
      return models;
    } catch {
      return [];
    }
  };
}
```

- [ ] **Step 4: Run discovery tests to verify they pass**

Run: `npm test -- tests/discovery.test.ts`
Expected: PASS — all discovery tests pass.

- [ ] **Step 5: Run typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/discovery.ts tests/discovery.test.ts
git commit -m "feat: add lunaroute model discovery from /v1/models"
```
Expected: commit succeeds.

---

### Task 5: Extension wiring (`src/index.ts`)

**Files:**
- Create: `src/index.ts` (v2 entrypoint; restores the entrypoint removed in Task 1)
- Create: `tests/index.test.ts` (v2 wiring tests)

**Interfaces:**
- Consumes from Task 2: `LUNAROUTE_PROVIDER`, `buildAttributionHeaders`, `generateSessionId`, `resolveRoutingUrl`, `firstRunHint`.
- Consumes from Task 3: `lunarouteOAuth`.
- Consumes from Task 4: `createRefreshModels`.
- Consumes from pi-coding-agent: `VERSION`, `ExtensionAPI`.
- Produces: default export `function lunarouteExtension(pi: ExtensionAPI): void`.

- [ ] **Step 1: Write the failing wiring tests**

Create `tests/index.test.ts` with this exact content:

```ts
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- tests/index.test.ts`
Expected: FAIL — `src/index.ts` does not exist.

- [ ] **Step 3: Implement the entrypoint**

Create `src/index.ts` with this exact content:

```ts
import { VERSION, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  LUNAROUTE_PROVIDER,
  buildAttributionHeaders,
  firstRunHint,
  generateSessionId,
  resolveRoutingUrl,
} from "./lunaroute.js";
import { lunarouteOAuth } from "./login.js";
import { createRefreshModels } from "./discovery.js";

export default function lunarouteExtension(pi: ExtensionAPI): void {
  const sessionId = generateSessionId();

  pi.registerProvider(LUNAROUTE_PROVIDER, {
    name: "LunaRoute",
    baseUrl: resolveRoutingUrl(process.env),
    api: "openai-completions",
    authHeader: true,
    headers: buildAttributionHeaders(VERSION, sessionId),
    oauth: lunarouteOAuth,
    refreshModels: createRefreshModels(process.env),
    models: [],
  });

  pi.on("session_start", (_event, ctx) => {
    if (!ctx.hasUI) return;
    const status = ctx.modelRegistry.getProviderAuthStatus(LUNAROUTE_PROVIDER);
    if (!status?.configured) {
      ctx.ui.notify(firstRunHint(), "info");
    }
  });
}
```

- [ ] **Step 4: Run wiring tests to verify they pass**

Run: `npm test -- tests/index.test.ts`
Expected: PASS — all wiring tests pass.

- [ ] **Step 5: Run all checks**

Run: `npm run check`
Expected: typecheck passes; all 4 test files pass.

- [ ] **Step 6: Commit**

```bash
git add src/index.ts tests/index.test.ts
git commit -m "feat: wire v2 lunaroute provider (register + session_start hint)"
```
Expected: commit succeeds.

---

### Task 6: README and final verification

**Files:**
- Rewrite: `README.md`

**Interfaces:**
- Consumes: the v2 behavior from Tasks 2–5.

- [ ] **Step 1: Rewrite the README**

Replace `README.md` with this exact content:

```md
# LunaRoute for Pi

A Pi extension that makes LunaRoute easy to use from Pi: log in, and your
LunaRoute models appear automatically with the right context window, max
tokens, reasoning, and reasoning-effort configuration. No `~/.pi/agent/models.json`
editing, and your API key is stored in `~/.pi/agent/auth.json` — never in any
models file.

## Requirements

- Pi **>= 0.84.1**.
- A LunaRoute account with access to at least one organization.
- A LunaRoute gateway that exposes the Pi compatibility block on `GET /v1/models`
  (LunaRoute server issue `vkd3` or later).

## Quick start

```bash
pi install npm:@lunaroute/pi-extension
```

Then in Pi:

```
/login lunaroute
```

Choose **Log in with browser** (a browser opens to LunaRoute; after you approve,
an API key is issued and stored) or **Paste an API key** (paste an existing
`lr_...` key). After login, run `/model` and pick a `lunaroute/*` model.

## What it does

- Registers a `lunaroute` provider with Pi.
- Offers browser-based login (PKCE + loopback) or pasting an API key. The
  `lr_` key is stored in `~/.pi/agent/auth.json` keyed by `lunaroute`.
- Syncs the model list from `GET {gateway}/v1/models` and maps each entry to a
  Pi model: `context_window` → `contextWindow`, `max_output_tokens` →
  `maxTokens`, `capabilities.reasoning` → `reasoning`, `capabilities.vision` →
  `input: ["text","image"]`, and the server-provided `pi` block
  (`thinkingLevelMap`, `compat`).
- Adds attribution headers to every LunaRoute request:
  ```http
  lunaroute-agent: pi/<pi-version>
  x-lunaroute-session: <session-uuid>
  lunaroute-session-id: <session-uuid>
  ```
  One session UUID per Pi runtime, shared by both session headers.

## What it does not do

- It does not write your API key or models to `~/.pi/agent/models.json`.
- It does not modify the HTTP `User-Agent` header.
- It does not target `lunaroute11111` or other test providers.
- It does not persist the model catalog across restarts (it re-fetches on
  refresh).

## Configuration

The gateway, API, and front URLs default to production and are overridable for
dev/staging via environment variables before starting Pi:

| Variable | Default | Purpose |
|---|---|---|
| `LUNAROUTE_ROUTING_URL` | `https://gw.lunaroute.com/v1` | Gateway base URL (provider `baseUrl` + `/models`) |
| `LUNAROUTE_API_URL` | `https://api.lunaroute.com` | API host for `/v1/auth/exchange` |
| `LUNAROUTE_FRONT_URL` | `https://app.lunaroute.com` | Web app host for `/pi-auth` browser login |

## Troubleshooting

- **No models appear after login**: the gateway may be unreachable, or the key
  may be stale. Re-run `/login lunaroute`. Reasoning models without a server
  `pi` block are skipped (requires LunaRoute server issue `vkd3`).
- **First-run hint**: if you have not logged in, `session_start` shows
  `Run /login lunaroute to start using LunaRoute.`

## Development

```bash
npm install
npm run check
pi -e .
```

Manual smoke test:

1. On Pi >= 0.84.1 against a `vkd3`-patched LunaRoute, run `pi -e .`.
2. `/login lunaroute`, pick browser, complete the flow.
3. Confirm a reasoning model (e.g. `glm-5.2`) appears in `/model`.
4. Send a request; confirm LunaRoute receives the three attribution headers.
5. Repeat with the paste path.
6. On a fresh profile with no key, confirm the first-run hint appears and no
   error is thrown.

Package dry run:

```bash
npm pack --dry-run
```

## License

MIT License. See [LICENSE](./LICENSE).
```

- [ ] **Step 2: Run full verification**

Run:
```bash
npm run check
npm pack --dry-run
git status --short
```
Expected:
- `npm run check` passes (typecheck + all tests across 4 files).
- `npm pack --dry-run` lists `package.json`, `README.md`, `LICENSE`, `src/index.ts`, `src/lunaroute.ts`, `src/login.ts`, `src/discovery.ts` (test files are excluded by the `files` allowlist).
- `git status --short` shows only `README.md` as modified.

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: document v2 (login, model sync, configuration, smoke test)"
```
Expected: commit succeeds.

---

## Final Verification

- [ ] Run:
```bash
npm run check
git log --oneline -7
```
Expected:
- TypeScript check passes; Vitest reports 4 test files passing.
- Recent commits include:
  - `chore: bump to pi v2 (pi ^0.84.1, pi-ai peer dep); remove v1 wiring`
  - `feat: add v2 pure helpers (headers, pkce, url builders, catalog mapper)`
  - `feat: add lunaroute login (browser + paste) and exchange`
  - `feat: add lunaroute model discovery from /v1/models`
  - `feat: wire v2 lunaroute provider (register + session_start hint)`
  - `docs: document v2 (login, model sync, configuration, smoke test)`

## Self-Review Notes

Spec coverage:
- Provider ownership via `ProviderConfig` (Task 5), identity + `openai-completions` + `authHeader` (Task 5), attribution headers (Task 2 headers, Task 5 wiring), and `models: []` populated by `refreshModels` (Task 4) — covered.
- Browser + paste login selector with the `lr_` key stored as a far-future-expiry `OAuthCredential` (Task 3), never written to `models.json` (Global Constraints + Task 5 uses `oauth`, not `apiKey`) — covered.
- `refreshModels` fetches `/v1/models` with the resolved key and maps fields incl. the `pi` block; reasoning models missing the block are skipped (Task 4 + Task 2 mapper) — covered.
- `session_start` first-run hint, no missing-provider/missing-auth warnings, no models.json conflict detection (Task 5) — covered.
- Error handling: login throws; `refreshModels` returns `[]` on network/401/5xx without throwing; `allowNetwork:false` and no-credential return `[]` without fetch (Task 4 tests) — covered.
- No catalog persistence (`context.publish` unused) (Task 4) — covered.
- Pi >= 0.84.1 peer/dev dep + pi-ai peer dep (Task 1) — covered.

Placeholder scan: no placeholders remain. The `computePkceChallenge("verifier")` test asserts the real `sha256("verifier")` hex (`88c9eae6...ee14`). No code placeholders, no "TBD", no "add error handling" stubs.

Type consistency: `LoginDeps` (Task 3) and `DiscoveryDeps` (Task 4) are defined where used. `LoopbackServer`, `ExchangeRequest`, `ExchangeResponse`, `GatewayModelObject`, `CatalogMappingResult`, `GatewayPiBlock` are defined in the tasks that produce them and imported unchanged by consumers. `lunarouteOAuth`, `createRefreshModels`, `lunarouteLogin` names match across producer (Tasks 3/4) and consumer (Task 5). `firstRunHint`/`missingPiBlockWarning` defined in Task 2, used in Tasks 4 (indirectly via mapper) / 5.

Refinement note (flagged for review): the spec's `{ code, verifier, label: "pi" }` is implemented as `label: hostname()` in Task 3 to match `lunaroute-cli`'s convention and produce more useful key names in the LunaRoute dashboard (`lunaroute-pi <hostname>` instead of `lunaroute-pi pi`). This is a minor, reversible refinement of the approved spec.
