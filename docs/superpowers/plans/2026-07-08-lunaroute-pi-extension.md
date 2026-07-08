# LunaRoute Pi Extension Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a closed-source-compatible Pi package that adds LunaRoute attribution and session headers to only the `lunaroute` provider, with non-blocking setup warnings.

**Architecture:** The extension is a standalone TypeScript Pi package. Pure helper functions build headers, generate session IDs, and decide whether warnings are needed; `src/index.ts` wires those helpers into Pi with `pi.registerProvider("lunaroute", { apiKey: "$LUNAROUTE_API_KEY", headers })` and a `session_start` warning check. The package does not create or discover models and does not change `User-Agent`.

**Tech Stack:** TypeScript, Node.js 22+, Pi extension API (`@earendil-works/pi-coding-agent`), Vitest, npm.

## Global Constraints

- Target only provider name `lunaroute`; do not target `lunaroute11111` or arbitrary OpenAI-compatible providers.
- Do not modify the HTTP `User-Agent` header in v1.
- Do not register or discover LunaRoute models in v1.
- Generate one session ID per extension runtime and send it as both `x-lunaroute-session` and `lunaroute-session-id`.
- Send `lunaroute-agent` as `pi/<pi-version>` using `VERSION` from `@earendil-works/pi-coding-agent`.
- Warn non-blockingly when provider `lunaroute` is missing.
- Warn non-blockingly when provider `lunaroute` exists but neither `LUNAROUTE_API_KEY` nor Pi provider auth appears configured.
- Standardize v1 request auth to Pi stored auth for provider `lunaroute` or `apiKey: "$LUNAROUTE_API_KEY"`; arbitrary existing `models.json` `apiKey` values for `lunaroute` do not need to be preserved.
- Never read, print, log, or store API key values.
- Package may be closed-source; use restricted npm publishing metadata, not `"private": true`.

---

## File Structure

- `package.json` — npm/Pi package manifest, scripts, dependencies, private publishing metadata.
- `tsconfig.json` — strict TypeScript config for source and tests.
- `src/lunaroute.ts` — pure helpers for headers, session IDs, provider/auth checks, warning text.
- `src/index.ts` — Pi extension entrypoint; registers provider header override and startup warnings.
- `tests/lunaroute.test.ts` — unit tests for pure helpers.
- `tests/index.test.ts` — unit tests for Pi extension wiring with a fake Pi API/context.
- `README.md` — installation, configuration, warning behavior, private publishing notes.

---

### Task 1: Scaffold package and pure helpers

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `src/lunaroute.ts`
- Create: `tests/lunaroute.test.ts`

**Interfaces:**
- Produces: `LUNAROUTE_PROVIDER = "lunaroute"`
- Produces: `LUNAROUTE_ENV_VAR = "LUNAROUTE_API_KEY"`
- Produces: `buildLunarouteHeaders(version: string, sessionId: string): Record<string, string>`
- Produces: `generateSessionId(randomUuid?: () => string, now?: () => number, random?: () => number): string`
- Produces: `hasLunarouteProvider(models: Array<{ provider?: string }>): boolean`
- Produces: `hasLunarouteAuth(env: NodeJS.ProcessEnv, authStatus: { configured?: boolean }): boolean`
- Produces: `missingProviderWarning(): string`
- Produces: `missingApiKeyWarning(): string`
- Consumes: Node.js `node:crypto` `randomUUID`.

- [ ] **Step 1: Create `package.json`**

Create `package.json` with this exact content:

```json
{
  "name": "@lunaroute/pi-extension",
  "version": "0.1.0",
  "description": "Pi extension for LunaRoute request attribution and session headers.",
  "type": "module",
  "keywords": [
    "pi-package",
    "lunaroute",
    "pi-extension"
  ],
  "license": "UNLICENSED",
  "publishConfig": {
    "access": "restricted"
  },
  "files": [
    "src",
    "README.md"
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
    "@earendil-works/pi-coding-agent": "*"
  },
  "devDependencies": {
    "@earendil-works/pi-coding-agent": "*",
    "@types/node": "^24.0.0",
    "typescript": "^5.9.0",
    "vitest": "^4.1.0"
  }
}
```

- [ ] **Step 2: Create `tsconfig.json`**

Create `tsconfig.json` with this exact content:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "esModuleInterop": true,
    "forceConsistentCasingInFileNames": true,
    "skipLibCheck": true,
    "types": ["node", "vitest/globals"],
    "noEmit": true
  },
  "include": ["src/**/*.ts", "tests/**/*.ts"]
}
```

- [ ] **Step 3: Install dependencies**

Run:

```bash
npm install
```

Expected: `package-lock.json` is created and npm exits successfully.

- [ ] **Step 4: Write failing helper tests**

Create `tests/lunaroute.test.ts` with this exact content:

```ts
import { describe, expect, test } from "vitest";
import {
  LUNAROUTE_ENV_VAR,
  LUNAROUTE_PROVIDER,
  buildLunarouteHeaders,
  generateSessionId,
  hasLunarouteAuth,
  hasLunarouteProvider,
  missingApiKeyWarning,
  missingProviderWarning,
} from "../src/lunaroute.js";

describe("lunaroute helpers", () => {
  test("constants target only the canonical lunaroute provider and env var", () => {
    expect(LUNAROUTE_PROVIDER).toBe("lunaroute");
    expect(LUNAROUTE_ENV_VAR).toBe("LUNAROUTE_API_KEY");
  });

  test("buildLunarouteHeaders returns only LunaRoute v1 headers", () => {
    const headers = buildLunarouteHeaders("0.80.3", "session-123");

    expect(headers).toEqual({
      "lunaroute-agent": "pi/0.80.3",
      "x-lunaroute-session": "session-123",
      "lunaroute-session-id": "session-123",
    });
    expect(headers).not.toHaveProperty("User-Agent");
    expect(headers).not.toHaveProperty("user-agent");
  });

  test("generateSessionId uses randomUUID when available", () => {
    const id = generateSessionId(() => "11111111-1111-4111-8111-111111111111");
    expect(id).toBe("11111111-1111-4111-8111-111111111111");
  });

  test("generateSessionId falls back to a safe unique-looking string", () => {
    const id = generateSessionId(
      () => {
        throw new Error("randomUUID unavailable");
      },
      () => 1234567890,
      () => 0.5,
    );

    expect(id).toBe("lunaroute-pi-1234567890-i");
  });

  test("hasLunarouteProvider requires provider exactly named lunaroute", () => {
    expect(hasLunarouteProvider([])).toBe(false);
    expect(hasLunarouteProvider([{ provider: "lunaroute11111" }])).toBe(false);
    expect(hasLunarouteProvider([{ provider: "openai" }, { provider: "lunaroute" }])).toBe(true);
  });

  test("hasLunarouteAuth accepts env var or Pi provider auth status", () => {
    expect(hasLunarouteAuth({}, { configured: false })).toBe(false);
    expect(hasLunarouteAuth({ LUNAROUTE_API_KEY: "lr_test" }, { configured: false })).toBe(true);
    expect(hasLunarouteAuth({}, { configured: true })).toBe(true);
  });

  test("warning text explains missing provider without secrets", () => {
    expect(missingProviderWarning()).toContain("no provider named `lunaroute`");
    expect(missingProviderWarning()).not.toContain("lr_");
  });

  test("warning text explains auth setup without secrets", () => {
    const warning = missingApiKeyWarning();

    expect(warning).toContain("no API key was found");
    expect(warning).toContain("export LUNAROUTE_API_KEY=lr_...");
    expect(warning).toContain("\"apiKey\": \"$LUNAROUTE_API_KEY\"");
    expect(warning).toContain("Stored Pi credential");
    expect(warning).not.toContain("lr_test");
  });
});
```

- [ ] **Step 5: Run tests to verify they fail**

Run:

```bash
npm test -- tests/lunaroute.test.ts
```

Expected: FAIL because `src/lunaroute.ts` does not exist yet.

- [ ] **Step 6: Implement pure helpers**

Create `src/lunaroute.ts` with this exact content:

```ts
import { randomUUID } from "node:crypto";

export const LUNAROUTE_PROVIDER = "lunaroute";
export const LUNAROUTE_ENV_VAR = "LUNAROUTE_API_KEY";

export type MinimalModel = {
  provider?: string;
};

export type MinimalAuthStatus = {
  configured?: boolean;
};

export function buildLunarouteHeaders(version: string, sessionId: string): Record<string, string> {
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

export function hasLunarouteProvider(models: MinimalModel[]): boolean {
  return models.some((model) => model.provider === LUNAROUTE_PROVIDER);
}

export function hasLunarouteAuth(env: NodeJS.ProcessEnv, authStatus: MinimalAuthStatus): boolean {
  return Boolean(env[LUNAROUTE_ENV_VAR]) || authStatus.configured === true;
}

export function missingProviderWarning(): string {
  return "LunaRoute Pi extension loaded, but no provider named `lunaroute` is configured.";
}

export function missingApiKeyWarning(): string {
  return [
    "LunaRoute provider is configured, but no API key was found.",
    "",
    "Set one of:",
    "1. Environment variable: export LUNAROUTE_API_KEY=lr_...",
    "   and in ~/.pi/agent/models.json use \"apiKey\": \"$LUNAROUTE_API_KEY\".",
    "2. Stored Pi credential for provider \"lunaroute\".",
  ].join("\n");
}
```

- [ ] **Step 7: Run helper tests to verify they pass**

Run:

```bash
npm test -- tests/lunaroute.test.ts
```

Expected: PASS for all tests in `tests/lunaroute.test.ts`.

- [ ] **Step 8: Run typecheck**

Run:

```bash
npm run typecheck
```

Expected: PASS with no TypeScript errors.

- [ ] **Step 9: Commit Task 1**

Run:

```bash
git add package.json package-lock.json tsconfig.json src/lunaroute.ts tests/lunaroute.test.ts
git commit -m "feat: add lunaroute extension helpers"
```

Expected: commit succeeds.

---

### Task 2: Wire Pi extension provider override and warnings

**Files:**
- Create: `src/index.ts`
- Create: `tests/index.test.ts`

**Interfaces:**
- Consumes from Task 1: `buildLunarouteHeaders`, `generateSessionId`, `hasLunarouteAuth`, `hasLunarouteProvider`, `missingApiKeyWarning`, `missingProviderWarning`, `LUNAROUTE_PROVIDER`.
- Consumes from Pi: `VERSION`, `ExtensionAPI`.
- Produces: default export `function lunarouteExtension(pi: ExtensionAPI): void`.
- Produces: `registerLunarouteExtension(pi: ExtensionAPI, version: string, env: NodeJS.ProcessEnv, sessionId?: string): void` for testable wiring.

- [ ] **Step 1: Write failing extension wiring tests**

Create `tests/index.test.ts` with this exact content:

```ts
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
```

- [ ] **Step 2: Run extension tests to verify they fail**

Run:

```bash
npm test -- tests/index.test.ts
```

Expected: FAIL because `src/index.ts` does not exist yet.

- [ ] **Step 3: Implement Pi extension entrypoint**

Create `src/index.ts` with this exact content:

```ts
import { VERSION, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  LUNAROUTE_PROVIDER,
  buildLunarouteHeaders,
  generateSessionId,
  hasLunarouteAuth,
  hasLunarouteProvider,
  missingApiKeyWarning,
  missingProviderWarning,
} from "./lunaroute.js";

export function registerLunarouteExtension(
  pi: ExtensionAPI,
  version: string,
  env: NodeJS.ProcessEnv,
  sessionId = generateSessionId(),
): void {
  pi.registerProvider(LUNAROUTE_PROVIDER, {
    apiKey: "$LUNAROUTE_API_KEY",
    headers: buildLunarouteHeaders(version, sessionId),
  });

  pi.on("session_start", (_event, ctx) => {
    const hasProvider = hasLunarouteProvider(ctx.modelRegistry.getAll());

    if (!hasProvider) {
      if (ctx.hasUI) {
        ctx.ui.notify(missingProviderWarning(), "warning");
      }
      return;
    }

    const authStatus = ctx.modelRegistry.getProviderAuthStatus(LUNAROUTE_PROVIDER);
    if (!hasLunarouteAuth(env, authStatus) && ctx.hasUI) {
      ctx.ui.notify(missingApiKeyWarning(), "warning");
    }
  });
}

export default function lunarouteExtension(pi: ExtensionAPI): void {
  registerLunarouteExtension(pi, VERSION, process.env);
}
```

- [ ] **Step 4: Run extension tests to verify they pass**

Run:

```bash
npm test -- tests/index.test.ts
```

Expected: PASS for all tests in `tests/index.test.ts`.

- [ ] **Step 5: Run all checks**

Run:

```bash
npm run check
```

Expected: typecheck and all tests pass.

- [ ] **Step 6: Commit Task 2**

Run:

```bash
git add src/index.ts tests/index.test.ts
git commit -m "feat: register lunaroute provider headers"
```

Expected: commit succeeds.

---

### Task 3: Add user documentation and final package verification

**Files:**
- Create: `README.md`
- Modify: `package.json`

**Interfaces:**
- Consumes: extension behavior from Task 2.
- Produces: user-facing install/configuration docs.
- Produces: package metadata suitable for private npm publication.

- [ ] **Step 1: Write README**

Create `README.md` with this exact content:

```md
# LunaRoute Pi Extension

Pi extension for LunaRoute request attribution and session affinity.

## What it does

When loaded in Pi, this extension targets only the provider named `lunaroute` and adds these headers to provider requests:

```http
lunaroute-agent: pi/<pi-version>
x-lunaroute-session: <session-uuid>
lunaroute-session-id: <session-uuid>
```

The same generated session UUID is used for both session headers during one extension runtime.

## What it does not do

- It does not change `User-Agent`.
- It does not target `lunaroute11111` or any other test provider.
- It does not create or discover LunaRoute models.
- It does not read, print, log, or store API key values.

## Requirements

Configure a Pi provider named exactly `lunaroute`, usually in `~/.pi/agent/models.json`.

Example:

```json
{
  "providers": {
    "lunaroute": {
      "baseUrl": "https://gw.lunaroute.com/v1",
      "api": "openai-completions",
      "apiKey": "$LUNAROUTE_API_KEY",
      "models": [
        {
          "id": "glm-5.2",
          "input": ["text"],
          "contextWindow": 1048576,
          "reasoning": true,
          "thinkingLevelMap": {
            "off": null,
            "minimal": "high",
            "low": "high",
            "medium": "high",
            "high": "high",
            "xhigh": "max"
          },
          "compat": {
            "thinkingFormat": "zai",
            "maxTokensField": "max_tokens",
            "supportsReasoningEffort": false
          }
        }
      ]
    }
  }
}
```

## API key setup

Preferred environment-variable setup:

```bash
export LUNAROUTE_API_KEY=lr_...
```

Then reference it from `~/.pi/agent/models.json`:

```json
"apiKey": "$LUNAROUTE_API_KEY"
```

Alternatively, store a Pi credential for provider `lunaroute`. V1 standardizes request auth to Pi stored auth or `LUNAROUTE_API_KEY`; arbitrary existing direct `apiKey` values in the `lunaroute` `models.json` provider config are not preserved by the extension override.

## Warnings

On session start, the extension shows non-blocking warnings when:

- no provider named `lunaroute` is configured, or
- provider `lunaroute` exists but neither `LUNAROUTE_API_KEY` nor Pi provider auth appears configured.

Warnings do not block Pi startup or requests.

## Local development

```bash
npm install
npm run check
pi -e .
```

## Private publishing

This package is intended to be publishable as a closed/private npm package.

Use restricted scoped npm publishing:

```bash
npm publish --access restricted
```

Do not set `"private": true` if publishing to npm; that flag prevents publishing.
```

- [ ] **Step 2: Ensure package metadata still allows publishing**

Open `package.json` and verify all of these are true:

```json
{
  "name": "@lunaroute/pi-extension",
  "license": "UNLICENSED",
  "publishConfig": {
    "access": "restricted"
  },
  "pi": {
    "extensions": ["./src/index.ts"]
  }
}
```

Expected: `package.json` does not contain `"private": true`.

- [ ] **Step 3: Run full verification**

Run:

```bash
npm run check
npm pack --dry-run
```

Expected:

- `npm run check` passes.
- `npm pack --dry-run` lists at least `package.json`, `README.md`, `src/index.ts`, and `src/lunaroute.ts`.
- The packed file list does not include test files unless npm includes them due to local npm behavior; if tests appear, update `files` in `package.json` to keep only `src` and `README.md`, then rerun `npm pack --dry-run`.

- [ ] **Step 4: Optional local smoke test**

Run:

```bash
pi -e . --list-models
```

Expected:

- Pi starts with the extension loaded.
- If provider `lunaroute` is configured, no missing-provider warning appears.
- If auth is configured, no missing-API-key warning appears.

If interactive smoke testing is preferred, run:

```bash
pi -e .
```

Expected: Pi opens normally. The extension is silent when `lunaroute` and auth are configured.

- [ ] **Step 5: Commit Task 3**

Run:

```bash
git add README.md package.json
git commit -m "docs: document lunaroute pi extension"
```

Expected: commit succeeds.

---

## Final Verification

- [ ] Run all checks:

```bash
npm run check
npm pack --dry-run
git status --short
```

Expected:

- TypeScript check passes.
- Vitest tests pass.
- Dry-run package includes the expected runtime files.
- `git status --short` is clean.

- [ ] Confirm git history includes the spec and implementation commits:

```bash
git log --oneline -5
```

Expected: recent commits include:

- `docs(spec): design lunaroute pi extension`
- `feat: add lunaroute extension helpers`
- `feat: register lunaroute provider headers`
- `docs: document lunaroute pi extension`

## Self-Review Notes

Spec coverage:

- Provider-only scope is covered by `LUNAROUTE_PROVIDER`, helper tests, and extension wiring tests.
- Header behavior is covered by `buildLunarouteHeaders` tests and extension registration tests.
- No `User-Agent` behavior is covered by helper and extension tests.
- Missing provider and missing auth warnings are covered by `tests/index.test.ts` and README.
- Closed-source/private npm publishing is covered by `package.json` metadata and README.
- Out-of-scope server-side/model-discovery/session-persistence items remain unimplemented by design.

Placeholder scan: no placeholder markers or unspecified implementation steps are intended in this plan.

Type consistency: helper names and signatures are defined in Task 1 and reused unchanged in Task 2.
