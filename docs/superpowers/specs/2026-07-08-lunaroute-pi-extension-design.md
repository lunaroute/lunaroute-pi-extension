# LunaRoute Pi Extension Design

Date: 2026-07-08

## Goal

Create a small Pi extension package that identifies Pi-originated LunaRoute requests and provides a stable per-session identifier. The first version must target only the configured Pi provider named `lunaroute`.

## Research Findings

- Pi extensions can manage providers with `pi.registerProvider(name, config)` and `pi.unregisterProvider(name)`.
- A header-only provider registration for an existing provider preserves that provider's existing model list. Providing `models` replaces the provider's model list, so v1 will not provide models.
- Pi's `before_provider_request` hook can replace provider payloads but does not expose request headers for mutation.
- Pi exports its version as `VERSION` from `@earendil-works/pi-coding-agent`.
- LunaRoute currently distinguishes:
  - `lunaroute-agent`: client/harness attribution, already parsed as an explicit override such as `pi/0.4.2`.
  - `x-lunaroute-session`: managed-inference affinity key.
  - `lunaroute-session-id`: client/session attribution.
- OpenAI Node SDK sets `User-Agent` to an SDK-generated value such as `OpenAI/JS <version>`. v1 will not alter this header.

## Architecture

The package will live as a standalone Pi package in `/home/eran/work/lunaroute-pi-extension`, separate from `/home/eran/work/lunaroute-saas`.

The extension will:

1. Import `VERSION` from `@earendil-works/pi-coding-agent`.
2. Generate a UUID for the current Pi session/runtime.
3. Register an override for provider `lunaroute` that sets `apiKey: "$LUNAROUTE_API_KEY"` plus these headers:

```http
lunaroute-agent: pi/<pi-version>
x-lunaroute-session: <session-uuid>
lunaroute-session-id: <session-uuid>
```

The extension will not register or discover models in v1. It relies on the user's existing `lunaroute` provider definition for models, but standardizes request auth to either Pi stored auth for provider `lunaroute` or the `LUNAROUTE_API_KEY` environment variable. Arbitrary existing `models.json` `apiKey` values for `lunaroute` are not preserved by v1.

## Provider Scope

Only provider name `lunaroute` is targeted.

The extension will not target:

- `lunaroute11111` test provider
- arbitrary OpenAI-compatible providers
- built-in OpenAI providers

## Missing Provider and API Key UX

On `session_start`, the extension will inspect `ctx.modelRegistry.getAll()` for at least one model whose `provider` is exactly `lunaroute`.

If none exists and UI is available, it will show a non-blocking warning notification:

> LunaRoute Pi extension loaded, but no provider named `lunaroute` is configured.

If the provider exists, the extension will also check whether LunaRoute auth appears to be configured without reading or displaying any secret value:

1. `process.env.LUNAROUTE_API_KEY` is set, or
2. `ctx.modelRegistry.getProviderAuthStatus("lunaroute").configured` is true.

If neither is true and UI is available, it will show a non-blocking warning explaining how to configure auth:

```text
LunaRoute provider is configured, but no API key was found.

Set one of:
1. Environment variable: export LUNAROUTE_API_KEY=lr_...
   and in ~/.pi/agent/models.json use "apiKey": "$LUNAROUTE_API_KEY".
2. Stored Pi credential for provider "lunaroute".
```

The warnings do not block startup or requests. v1 does not create provider models automatically and does not write credentials.

## Session ID Behavior

The extension generates one UUID for the current extension runtime/session and uses the same value for both:

- `x-lunaroute-session`
- `lunaroute-session-id`

A new UUID on `/reload`, `/new`, `/resume`, or process restart is acceptable for v1. Persisting or restoring session IDs is out of scope.

## Error Handling

- Header values are generated from safe inputs: Pi version and UUID.
- If UUID generation fails, the extension should fall back to a sufficiently unique timestamp/random value or surface a clear warning.
- The extension reads no secrets and stores no secrets.
- The missing-provider warning is best-effort and non-blocking.

## Package Layout

Recommended initial layout:

```text
/home/eran/work/lunaroute-pi-extension/
  package.json
  src/index.ts
  tsconfig.json
  README.md
  docs/superpowers/specs/2026-07-08-lunaroute-pi-extension-design.md
```

Package manifest should declare the Pi extension entrypoint:

```json
{
  "name": "@lunaroute/pi-extension",
  "version": "0.1.0",
  "type": "module",
  "keywords": ["pi-package"],
  "pi": {
    "extensions": ["./src/index.ts"]
  },
  "peerDependencies": {
    "@earendil-works/pi-coding-agent": "*"
  }
}
```

## Publishing and Closed Source

It is acceptable for this package to be closed-source.

For private npm publishing:

- Use a scoped package, for example `@lunaroute/pi-extension`.
- Use `publishConfig.access = "restricted"` or publish with `npm publish --access restricted`.
- Do not set `"private": true` if the package should be published to npm; that flag prevents publishing.
- Consumers need npm credentials with read access.

Alternative distribution can use a private git package via `pi install git:...`.

## Testing Plan

Unit-level checks should cover the pure header-building behavior:

- `lunaroute-agent` is exactly `pi/<version>`.
- `x-lunaroute-session` and `lunaroute-session-id` exist and match.
- No `User-Agent` header is produced by v1.

Manual smoke test:

1. Configure a provider named `lunaroute` in Pi.
2. Load the extension with `pi -e .` or install it as a Pi package.
3. Verify LunaRoute receives the three expected headers.
4. Temporarily remove/rename the provider and confirm the missing-provider warning appears.
5. Temporarily remove auth configuration and unset `LUNAROUTE_API_KEY`, then confirm the missing-API-key warning appears without displaying any secret value.

## Out of Scope for v1

- Modifying the HTTP `User-Agent` header.
- Supporting `lunaroute11111` or other test providers.
- Creating or discovering LunaRoute models.
- LunaRoute server-side changes.
- Persisting session IDs across restarts/resumes.
- Project-local configuration options.
