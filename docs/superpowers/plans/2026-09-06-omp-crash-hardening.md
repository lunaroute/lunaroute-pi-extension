# omp (oh-my-pi) Crash-Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop `@lunaroute/pi-extension` from crashing on oh-my-pi (omp) hosts by replacing the two mainline-only API calls with equivalents that exist on both mainline pi and omp.

**Architecture:** Two surgical substitutions, no host detection and no omp-specific code paths: (1) the session_start first-run hint derives from the `getApiKeyForProvider` result instead of `getProviderAuthStatus`; (2) the login method menu feature-detects `callbacks.onSelect` and defaults to the browser flow when the host doesn't provide one (omp's `OAuthController`). On mainline pi both changes are semantically identical to today's behavior; on omp they turn hard crashes into working flows.

**Tech Stack:** TypeScript, vitest, `@earendil-works/pi-coding-agent` types only (no omp imports — omp compatibility comes solely from using APIs present on both hosts).

**Spec:** kata `npw2` (issue ledger, project `lunaroute-pi-extension`) — body + four comments contain the validated compatibility matrix, the reviewed implementation plan, and the scope decision. This plan implements **posture B** from that kata: P1 + P2 only. P3 (`fetchDynamicModels` adapter), P4 (`model_select` quirk), and P5 (display name) are deliberately out of scope.

## Global Constraints

- Posture B: crash-hardening only. No `fetchDynamicModels`, no omp imports, no host detection, no changes to `registerProvider` config.
- Mainline pi remains the only *supported* host: `peerDependencies` floor `>=0.84.1` is unchanged; no dependency changes at all.
- omp compatibility must come only from substituting APIs that exist on both hosts or runtime `typeof` feature-detects that are dead code on mainline.
- Everything must typecheck against `@earendil-works/pi-coding-agent` types (`npm run typecheck`); the test fakes simulate the omp runtime shape via casts, never via new production types.
- Gate for every task: `npm run check` (typecheck + all tests) exits 0.
- Reference evidence (from kata npw2, verified against omp `main` and mainline 0.84.1/0.85.0):
  - omp `ModelRegistry` has `getApiKeyForProvider(provider): Promise<string|undefined>` but no `getProviderAuthStatus` (mainline has both: model-registry.d.ts:31/36 at 0.84.1 and 0.85.0).
  - omp `AuthStorage.login` passes exactly `{onAuth, onProgress, onPrompt, onManualCodeInput, signal, fetch}` to a provider's `login()` — `onSelect` is never passed; `onAuth`/`onPrompt` are always provided.
  - Mainline `resolveProviderAuth` consults the stored OAuth credential first, then ambient apiKey resolution — so for our oauth-registered provider (no `apiKey` in config), "no resolvable key" ≡ "not configured", making the hint semantics equivalent.

---

### Task 1: session_start hint from the key lookup (P1)

**Files:**
- Modify: `src/index.ts:64-72` (the `session_start` handler)
- Test: `tests/index.test.ts` (fake host becomes omp-shaped)

**Interfaces:**
- Consumes: `ctx.modelRegistry.getApiKeyForProvider(provider: string): Promise<string | undefined>` (exists on mainline pi >= 0.84.1 and omp).
- Produces: no interface change — the `session_start` handler's observable behavior (hint iff no key && hasUI; MCP registration iff key) is preserved; only the crash on `getProviderAuthStatus`-less hosts disappears.

- [ ] **Step 1: Make the test fake host omp-shaped and write the failing assertion**

In `tests/index.test.ts`:

1a. Change the `FakeContext` type — remove `getProviderAuthStatus` from `modelRegistry`:

```ts
type FakeContext = {
  hasUI: boolean;
  model?: Model<Api> | undefined;
  modelRegistry: {
    getApiKeyForProvider: (provider: string) => Promise<string | undefined>;
  };
  ui: { notify: ReturnType<typeof vi.fn> };
};
```

1b. Change the `fakeContext` default registry accordingly:

```ts
    modelRegistry: {
      getApiKeyForProvider: () => Promise.resolve(undefined),
    },
```

1c. Strip `getProviderAuthStatus: () => ({ configured: ... }),` from every per-test `modelRegistry` override (tests "session_start notifies the first-run hint…", "…silent when a credential is configured…", "…silent when UI is unavailable", "…registers the lunaroute MCP server…", "…shows the install hint exactly once…", "…warns instead of hinting…", "…does not hint or register when not logged in…", "…idempotent…", "…disposes the MCP registration…", "login re-registers MCP…", and the "session_start tracks the current model" test in the second describe block). Each override keeps only its `getApiKeyForProvider` line. Example — this:

```ts
    const ctx = fakeContext({
      modelRegistry: { getProviderAuthStatus: () => ({ configured: false }), getApiKeyForProvider: () => Promise.resolve(undefined) },
    });
```

becomes:

```ts
    const ctx = fakeContext({
      modelRegistry: { getApiKeyForProvider: () => Promise.resolve(undefined) },
    });
```

(The fake registry now matches omp's runtime shape — no `getProviderAuthStatus` anywhere.)

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/index.test.ts`
Expected: the session_start tests FAIL with `TypeError: ctx.modelRegistry.getProviderAuthStatus is not a function` — the exact error from the omp field report. This red run is the regression proof.

- [ ] **Step 3: Implement P1**

In `src/index.ts`, replace the top of the `session_start` handler:

```ts
  pi.on("session_start", async (_event, ctx) => {
    currentModel = ctx.model;
    if (ctx.hasUI) {
      const status = ctx.modelRegistry.getProviderAuthStatus(LUNAROUTE_PROVIDER);
      if (!status?.configured) {
        ctx.ui.notify(firstRunHint(), "info");
      }
    }
    const key = await ctx.modelRegistry.getApiKeyForProvider(LUNAROUTE_PROVIDER);
    if (!key) return; // not logged in — silent, no MCP registration
```

with:

```ts
  pi.on("session_start", async (_event, ctx) => {
    currentModel = ctx.model;
    const key = await ctx.modelRegistry.getApiKeyForProvider(LUNAROUTE_PROVIDER);
    // Hint derives from the key lookup (works on hosts without
    // getProviderAuthStatus, e.g. oh-my-pi): a resolvable key — stored OAuth
    // or ambient apiKey — means the user is configured.
    if (ctx.hasUI && !key) {
      ctx.ui.notify(firstRunHint(), "info");
    }
    if (!key) return; // not logged in — silent, no MCP registration
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/index.test.ts`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add src/index.ts tests/index.test.ts
git commit -m "fix(session_start): derive first-run hint from getApiKeyForProvider (kata npw2 P1)

Removes the only getProviderAuthStatus call, which crashes hosts whose
ModelRegistry lacks it (oh-my-pi). getApiKeyForProvider exists on both
mainline pi (>=0.84.1) and omp; hint semantics are unchanged."
```

### Task 2: feature-detect the login method menu (P2)

**Files:**
- Modify: `src/login.ts:152-159` (`lunarouteLogin`'s method selection)
- Test: `tests/login.test.ts`

**Interfaces:**
- Consumes: `callbacks.onSelect(prompt): Promise<string | undefined>` (mainline-only, now optional at runtime); `callbacks.onAuth`, `callbacks.onPrompt` (both hosts).
- Produces: no signature change — `lunarouteLogin(callbacks, env, deps): Promise<OAuthCredentials>` behaves identically when `onSelect` is present, and defaults to the browser flow when absent.

- [ ] **Step 1: Write the failing test**

In `tests/login.test.ts`, inside the `describe("lunaroute login", ...)` block, add after the "lunarouteLogin returns OAuthCredentials for paste" test:

```ts
  test("host without onSelect (omp-shaped) defaults to the browser flow", async () => {
    const { onSelect: _omitted, onAuth, ...rest } = fakeCallbacks();
    const cb = rest as unknown as OAuthLoginCallbacks; // no onSelect key, like omp's OAuthController
    const creds = await lunarouteLogin(cb, { LUNAROUTE_FRONT_URL: "http://front", LUNAROUTE_API_URL: "http://api" }, {
      startLoopback: async () => fakeLoopback("the-code", "the-state"),
      exchange: vi.fn(async () => ({ full_key: "lr_omp", org_id: "o", user_email: "u" })),
      state: () => "the-state",
      verifier: () => "the-verifier",
    });
    expect(creds.access).toBe("lr_omp");
    expect(onAuth).toHaveBeenCalled();
  });
```

(The `_omitted` underscore is the sanctioned way to drop a property via rest-destructuring; TS's `noUnusedLocals` does not flag it.)

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/login.test.ts -t "omp-shaped"`
Expected: FAIL with `TypeError: callbacks.onSelect is not a function` — the second omp crash, reproduced.

- [ ] **Step 3: Implement the guard**

In `src/login.ts`, replace the method selection in `lunarouteLogin`:

```ts
  const method = await callbacks.onSelect({
    message: "Log in to LunaRoute",
    options: [
      { id: "browser", label: "Log in with browser" },
      { id: "paste", label: "Paste an API key" },
    ],
  });
  if (!method) throw new Error("Login cancelled");
```

with:

```ts
  // Hosts whose login UI has no method menu (oh-my-pi's OAuthController passes
  // no onSelect) get the browser flow directly; paste stays reachable via the
  // loopback-timeout fallback in loginWithBrowser.
  const method = typeof callbacks.onSelect === "function"
    ? await callbacks.onSelect({
        message: "Log in to LunaRoute",
        options: [
          { id: "browser", label: "Log in with browser" },
          { id: "paste", label: "Paste an API key" },
        ],
      })
    : "browser";
  if (!method) throw new Error("Login cancelled");
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/login.test.ts`
Expected: all PASS (the new test plus the existing onSelect/menu tests, which keep covering the mainline path).

- [ ] **Step 5: Commit**

```bash
git add src/login.ts tests/login.test.ts
git commit -m "fix(login): default to browser flow when the host provides no onSelect (kata npw2 P2)

oh-my-pi's AuthStorage.login never passes onSelect; the guard is dead
code on mainline pi where onSelect is always present."
```

### Task 3: README host-compatibility note + full gate

**Files:**
- Modify: `README.md:25-28` (Requirements section)

**Interfaces:** none (documentation).

- [ ] **Step 1: Add the note**

In `README.md`, extend the Requirements section:

```markdown
## Requirements

- Pi **>= 0.84.1**.
- A LunaRoute account with access to at least one organization.

**Host compatibility:** mainline pi (`@earendil-works/pi-coding-agent`)
is the supported host. The [omp](https://github.com/can1357/oh-my-pi) fork
works on a best-effort, untested basis as of this release: login and startup
no longer crash on it, but the live model-catalog refresh is mainline-only —
on omp the model list comes from the persisted store (re-login or first
`/login lunaroute` on mainline refreshes it). Report omp-specific issues at
<https://github.com/lunaroute/lunaroute-pi-extension/issues>.
```

- [ ] **Step 2: Run the full gate**

Run: `npm run check`
Expected: typecheck clean, all tests pass (85 existing + 1 new login test = 86).

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: host compatibility — mainline pi supported, omp best-effort (kata npw2)"
```

- [ ] **Step 4: Record progress on the kata**

```bash
kata comment npw2 --body "Implemented P1+P2 (posture B) on feat/npw2-omp-compat: session_start hint now derives from getApiKeyForProvider (omp-shaped fake host in tests reproduces the original TypeError as the red step); login defaults to browser flow when onSelect is absent; README states mainline-supported / omp best-effort. Full gate (npm run check) green."
```

(Do NOT close the kata — closing asserts the work is verified end-to-end; the owner closes after review/merge.)

---

## Out of scope (tracked on kata npw2)

- P3: omp `fetchDynamicModels` adapter for live catalog refresh on omp.
- P4: `model_select` not fired on omp (stale `currentModel` on re-login auto-pick).
- P5: provider display name (`name` field ignored by omp).
- Version bump / release chore (0.4.1 happens at merge time per repo release process).
