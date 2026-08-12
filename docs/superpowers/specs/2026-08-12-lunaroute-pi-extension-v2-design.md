# LunaRoute Pi Extension v2 — Provider Ownership, Login, and Model Sync

Date: 2026-08-12

## Goal

Turn the LunaRoute Pi extension from a header-only override (v1) into a complete
Pi provider that the user enables by logging in, and that keeps its model list
synchronized with LunaRoute's model catalog. After install + `/login lunaroute`,
the user has working LunaRoute models with correct context windows, max tokens,
reasoning, and reasoning-effort configuration — with no `models.json` editing.

## Relationship to v1

v1 was a header-only override that leaned on a user-authored `lunaroute` entry
in `~/.pi/agent/models.json`. v1 was never deployed to any user, so v2 has no
migration path, no compatibility shims, and carries none of v1's warnings
(missing-provider, missing-auth). v2 owns the `lunaroute` provider from a clean
slate.

The one thing v2 preserves from v1 is the three attribution headers and the
per-runtime session UUID.

## Prerequisites

### Pi version

v2 targets Pi **>= 0.84.1**. The `registerProvider` legacy `ProviderConfig`
form in 0.84.1 exposes both interactive `oauth.login` and credential-aware
`refreshModels(context: RefreshModelsContext)` (where `context.credential` is
the resolved credential). Earlier Pi versions (e.g. 0.80.3) lack
`refreshModels` on `ProviderConfig` entirely.

The package declares:
- `devDependencies: { "@earendil-works/pi-coding-agent": "^0.84.1" }`
- `peerDependencies: { "@earendil-works/pi-coding-agent": ">=0.84.1" }`
- README states the minimum Pi version.

### LunaRoute server (blocked: kata `vkd3`)

v2 is **blocked on** `lunaroute-saas` kata issue **`vkd3`** ("Expose Pi
reasoning-compat metadata (thinkingLevelMap/compat) on GET /v1/models"). The
extension cannot correctly register reasoning models until the gateway's
`/v1/models` returns the `pi` compat block. v2 ships after `vkd3` lands; until
then the extension work is complete-but-waiting.

The LunaRoute surfaces v2 depends on (all already live, no server work beyond
`vkd3`):

- **Browser login → API key**: `services/lunaroute-front/app/pi-auth/page.tsx`
  → `DeviceAuthPage` → `app/api/auth/pi/authorize/route.ts` → Go
  `handlers/cli_auth.go::AuthorizePI` + public `POST /v1/auth/exchange`
  (aliased "for non-cli clients / pi plugin"). Returns
  `{ full_key, org_id, user_email, source: "pi", api_url, routing_url }`.
  Reference client: `services/lunaroute-cli/src/login.ts`.
- **Model catalog**: Rust gateway `GET /v1/models`
  (`services/lunaroute-hosted/src/routes/models.rs`), header-authed with the
  same `lr_` key (`Authorization` / `LUNAROUTE-API-KEY` / `x-api-key`). Returns
  OpenAI-shape objects with `id`, `context_window`, `context_length`,
  `max_input_tokens`, `max_output_tokens`, `max_completion_tokens`, and
  `capabilities` (`openai_chat`, `anthropic_messages`, `tools`, `reasoning`,
  `vision`). After `vkd3`, also an optional `pi` block (see Discovery).

## Architecture

The extension is a standalone TypeScript Pi package. It registers a single
provider named `lunaroute` via the legacy `ProviderConfig` form of
`pi.registerProvider`. The provider owns:

1. **Identity** — `baseUrl` (the LunaRoute gateway URL), `api:
   "openai-completions"`, display name "LunaRoute", `authHeader: true`.
2. **Auth** — an `oauth` block whose `login()` offers a browser flow or a
   paste-an-API-key flow. The returned `lr_` key is stored by Pi in
   `~/.pi/agent/auth.json` keyed by provider id `lunaroute`.
3. **Models** — a `refreshModels(context)` that fetches `GET {baseUrl}/v1/models`
   with the resolved key and maps each entry to a Pi model object. `models`
   is registered as `[]`; `refreshModels` populates the list.
4. **Attribution headers** — provider-level `headers` carrying the three
   LunaRoute attribution headers with a per-runtime session UUID.

The extension **never writes to `models.json`** — not for the API key, not for
models. There is no v1→v2 migration path and no `models.json` conflict
detection.

### File structure

```text
src/
  lunaroute.ts        # pure helpers: headers, PKCE, URL builders, catalog mapper, warnings
  login.ts            # oauth.login implementation: loopback server, browser/paste, exchange
  discovery.ts        # refreshModels implementation: fetch /v1/models, map to Pi models
  index.ts            # extension entrypoint: registerProvider + session_start first-run hint
tests/
  lunaroute.test.ts   # pure helpers
  login.test.ts       # login() with fake AuthLoginCallbacks + mocked fetch
  discovery.test.ts   # refreshModels with fake RefreshModelsContext + mocked fetch
  index.test.ts       # registration wiring with fake pi
```

## Auth and login

The `oauth` block on `ProviderConfig` is the only form that gives both
interactive login and credential-aware `refreshModels`. LunaRoute issues a
plain static `lr_` API key, not an OAuth token, so the credential is modeled
as an `OAuthCredential` with a far-future expiry. This is the documented
trade-off: native `auth.apiKey.login` is semantically cleaner but its
`refreshModels()` is argless (no `context.credential`), which would force a
side-channel to reach the key for discovery.

```typescript
const lunarouteOAuth = {
  name: "LunaRoute",
  async login(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
    const method = await callbacks.onSelect({
      message: "Log in to LunaRoute",
      options: [
        { id: "browser", label: "Log in with browser" },
        { id: "paste",   label: "Paste an API key" },
      ],
    });
    if (!method) throw new Error("Login cancelled");

    let key: string;
    if (method === "browser") {
      key = await loginWithBrowser(callbacks);
    } else {
      key = (await callbacks.onPrompt({ type: "secret", message: "Paste your LunaRoute API key (lr_...)" })).trim();
    }
    if (!key) throw new Error("No API key provided");

    // Far-future expiry: the lr_ key is static; Pi never calls refreshToken.
    return { access: key, refresh: "", expires: Date.now() + 10 * 365 * 24 * 60 * 60 * 1000 };
  },
  async refreshToken(creds: OAuthCredentials, _signal: AbortSignal): Promise<OAuthCredentials> {
    return creds; // no-op; static key, far-future expiry
  },
  getApiKey(creds: OAuthCredentials): string {
    return creds.access;
  },
};
```

### Browser path (`loginWithBrowser`)

Mirrors `services/lunaroute-cli/src/login.ts`:

1. Start a loopback `http` server on `127.0.0.1:0` listening for
   `/callback?code=&state=`.
2. Generate PKCE `verifier` + `challenge` (S256) and a random `state`.
3. `callbacks.notify({ type: "auth_url", url: \`${frontUrl}/pi-auth?port=${port}&state=${state}&challenge=${challenge}\` })`.
   Pi opens the user's browser.
4. Await the loopback callback (race with a timeout; the backend code expires
   in ~60s).
5. Verify `state` matches; abort on mismatch.
6. `POST ${apiUrl}/v1/auth/exchange` with `{ code, verifier, label: "pi" }`
   (fetch mocked in tests; real network in production). The response contains
   `{ full_key: "lr_...", routing_url, org_id, user_email }`.
7. Return `full_key`.

`frontUrl` defaults to the production LunaRoute web URL and is overridable
via `LUNAROUTE_FRONT_URL`. `apiUrl` (for the exchange) defaults to the
production API URL and is overridable via `LUNAROUTE_API_URL`. Both defaults
are constants in `lunaroute.ts`.

### Paste path

`callbacks.onPrompt({ type: "secret", message: "Paste your LunaRoute API key (lr_...)" })`,
trim, return as `access`. No network.

### Key storage

Pi persists the returned `OAuthCredential` into `~/.pi/agent/auth.json` keyed
by provider id `lunaroute`. The extension never writes to `models.json`, and
the raw key never lives in any file the extension controls. `getApiKey` feeds
the stored key back per request; `authHeader: true` makes Pi send
`Authorization: Bearer <lr key>`, which the gateway accepts.

## Provider registration

```typescript
pi.registerProvider("lunaroute", {
  name: "LunaRoute",
  baseUrl: process.env.LUNAROUTE_ROUTING_URL ?? DEFAULT_ROUTING_URL,
  api: "openai-completions",
  authHeader: true,
  headers: buildAttributionHeaders(VERSION, sessionId),
  oauth: lunarouteOAuth,
  refreshModels: lunarouteRefreshModels,
  models: [],
});
```

- **`baseUrl`**: the gateway URL. Defaults to production; `LUNAROUTE_ROUTING_URL`
  overrides for dev/staging. (The exchange response also returns `routing_url`;
  auto-updating `baseUrl` from it post-login is out of scope for v2.)
- **`api: "openai-completions"`** + **`authHeader: true`**: the gateway speaks
  OpenAI completions (`openai_chat` capability) and accepts
  `Authorization: Bearer`.
- **`headers`**: `buildAttributionHeaders(version, sessionId)` returns:
  ```http
  lunaroute-agent: pi/<pi-version>
  x-lunaroute-session: <session-uuid>
  lunaroute-session-id: <session-uuid>
  ```
  One session UUID per extension runtime (same value for both session headers),
  generated with `randomUUID` and a safe timestamp/random fallback (carried
  from v1).
- **`models: []`**: empty at registration; `refreshModels` populates the list.

`sessionId` and `VERSION` are resolved once at module load; `registerProvider`
is called in the (sync) extension factory so it is queued and applied at
startup.

## Discovery and model mapping

`refreshModels(context: RefreshModelsContext)` fetches the catalog and maps
it to `ProviderModelConfig[]`:

1. If `context.allowNetwork === false` (offline init), return `[]` immediately,
   no fetch, no warning.
2. If `context.credential` is missing (user hasn't logged in), return `[]`,
   no fetch, no warning (clean unconfigured state).
3. Otherwise `fetch(${baseUrl}/v1/models`, `{ signal: context.signal, headers:
   { Authorization: \`Bearer ${context.credential.access}\` } })`.
   - On network error or 5xx: return `[]`. Do not throw — Pi surfaces the
     refresh failure natively via its `ModelsError` ("model_source") path,
     and the list stays at its last-known state (empty on first refresh) until
     the next refresh retries.
   - On 401/403: return `[]` for the same reason. Pi's request-time auth
     resolution surfaces a "needs re-login" state when a real request is
     attempted, which is the right moment to tell the user to re-run
     `/login lunaroute`.
4. Parse the OpenAI-shape response `{ data: OpenAIModelObject[] }` and map
   each entry to a `ProviderModelConfig`.

### Field mapping

| Gateway `/v1/models` field | Pi `ProviderModelConfig` field |
|---|---|
| `id` (the `lunaroute_model_name` alias) | `id` |
| `display_name` ?? `id` | `name` |
| `context_window` | `contextWindow` |
| `max_output_tokens` | `maxTokens` |
| `capabilities.reasoning === true` | `reasoning` |
| `capabilities.vision === true` | `input: ["text","image"]`, else `["text"]` |
| (tools work; no Pi flag) | — |
| `pi.thinkingLevelMap` (from `vkd3`) | `thinkingLevelMap` |
| `pi.compat` `{thinkingFormat, maxTokensField, supportsReasoningEffort}` (from `vkd3`) | `compat` |
| — | `cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }` |

`cost` is zero because LunaRoute bills via credits, not per-token USD; zero
keeps Pi's cost arithmetic from erroring. Surfacing catalog pricing is out of
scope for v2.

### Reasoning-model guard

v2 is gated on `vkd3`, so reasoning models should always arrive with a `pi`
block. Defensively, if `capabilities.reasoning === true` but the entry has no
`pi` block, the model is **skipped** (not registered). `refreshModels` cannot
emit a UI warning (it has no UI channel), so the skip is silent; Pi's model
list reflects only the models that were mapped successfully. Skipping (rather
than registering with default thinking behavior) prevents a reasoning model
from being silently misconfigured.

### Non-reasoning models

Register with just `id`, `name`, `contextWindow`, `maxTokens`, `reasoning:
false`, `input`, and `cost`. No `compat`, no `thinkingLevelMap`.

### Persistence

`refreshModels` does **not** call `context.publish`. The catalog is small,
always re-fetchable, and changes server-side; persisting adds
generation-check complexity for no v2 benefit. If the gateway is unreachable
at refresh, the list is empty until the next refresh. (Offline-startup
resilience is a future enhancement, out of scope.)

## Error handling summary

- **Login fails** (browser timeout, PKCE mismatch, exchange 4xx, user
  cancels select, empty paste): `login()` throws a clear `Error`; Pi surfaces
  "Login failed"; user retries. No partial credential is stored.
- **`/v1/models` network/5xx**: `refreshModels` returns `[]`, no throw. Pi
  surfaces the refresh failure natively via its `ModelsError` path; the list
  retries on the next refresh.
- **`/v1/models` 401/403**: `refreshModels` returns `[]`, no throw. Pi's
  request-time auth resolution surfaces a "needs re-login" state when the
  user actually sends a request.
- **`allowNetwork: false`**: return `[]`, no fetch.
- **No credential stored**: return `[]`, no fetch. The `session_start`
  first-run hint (below) tells the user to run `/login lunaroute`.
- **Reasoning model missing `pi` block**: skip the model silently (see
  Reasoning-model guard).

`refreshModels` has no UI channel in `RefreshModelsContext`, so all
user-facing messaging is handled either by Pi's native error surfacing
(refresh/request failures) or by the extension's `session_start` handler
(unconfigured state).

## session_start

A single, gentle first-run hint: if no LunaRoute credential is stored (the
user just installed), `session_start` emits a non-blocking
`ctx.ui.notify` "Run `/login lunaroute` to start using LunaRoute." This is
the only startup notification. There is **no** missing-provider warning (the
extension provides the provider) and **no** missing-auth warning (auth is
"configured" once you log in) and **no** models.json conflict detection (no
migration path).

Detection of "no credential stored" uses `ctx.modelRegistry.getProviderAuthStatus`
in the installed Pi version's form, or `getApiKeyForProvider` resolving
undefined — whichever the targeted Pi exposes. The exact API call is pinned
during implementation.

## Testing strategy

Mirrors v1's pure-helpers + fake-Pi approach; no real network.

- **`lunaroute.test.ts`** (pure helpers): `buildAttributionHeaders` (carried
  from v1, still asserts the three headers + no `User-Agent`), PKCE
  `verifier`/`challenge` generation, loopback URL builder, `mapCatalogEntry`
  (gateway model → Pi model, including the `pi` block mapping and the
  reasoning-model skip), `mapLoginMethod`, warning-text builders.
- **`login.test.ts`** (`login()` with fake `OAuthLoginCallbacks` + mocked
  `fetch`): browser path asserts `onSelect` → `notify({auth_url})` → awaits
  callback → `exchangeCode` called with right `{code, verifier, label:"pi"}`
  → returns `{access, refresh, expires}`; paste path asserts
  `onPrompt({secret})`; cancel/empty throws; state mismatch throws.
- **`discovery.test.ts`** (`refreshModels` with a fake `RefreshModelsContext`
  + mocked `fetch`): credential set → fetch called with `Authorization:
  Bearer` + `signal` → response mapped to `ProviderModelConfig[]`; credential
  unset → `[]`, no fetch; `allowNetwork: false` → `[]`, no fetch; 401 → `[]`,
  no throw; network error → `[]`, no throw; reasoning entry without `pi` block
  → skipped, not in the returned list.
- **`index.test.ts`** (registration wiring with fake `pi`, like v1): assert
  `registerProvider` called once with name `"lunaroute"` and the expected
  `ProviderConfig` shape (`name`, `baseUrl`, `api`, `authHeader`, `headers`
  matching v1's contract, `oauth`, `refreshModels`, `models: []`); assert
  attribution headers carry one UUID shared across both session headers and
  no `User-Agent`; assert `session_start` first-run hint fires when no
  credential is stored and is silent when one is.

### Integration smoke test (manual, documented in README)

1. On Pi >= 0.84.1 against a `vkd3`-patched LunaRoute, `pi -e .` (or
   `pi install npm:@lunaroute/pi-extension`).
2. Run `/login lunaroute`, pick browser, complete the flow.
3. Confirm a reasoning model (e.g. `glm-5.2`) appears in `/model` with the
   correct `thinkingLevelMap` and reasoning effort.
4. Send a request; confirm LunaRoute receives `lunaroute-agent`,
   `x-lunaroute-session`, and `lunaroute-session-id`.
5. Repeat with the paste path.
6. On a fresh profile with no key, confirm the first-run hint appears and no
   error is thrown.

## Out of scope for v2

- Per-token USD cost tracking (cost stays 0).
- Persisting the catalog for offline startup.
- Auto-updating `baseUrl` from the exchange response's `routing_url`.
- Multi-account / multi-org (one credential per provider, per Pi's
  `auth.json`).
- Modifying the HTTP `User-Agent` header (unchanged from v1).
- Supporting `lunaroute11111` or other test providers (unchanged from v1).
- v1→v2 migration (v1 was never deployed).
- Surfacing LunaRoute pricing in Pi's cost UI.

## Open questions to resolve during implementation

- Exact `ctx.modelRegistry` call for "no credential stored" detection on
  Pi 0.84.1 (`getProviderAuthStatus` vs `getApiKeyForProvider`).
- The production default values for `DEFAULT_ROUTING_URL` and
  `DEFAULT_FRONT_URL` (confirm against the deployed LunaRoute environment).
