# Usage Insights & Queue Nudge — Design

Date: 2026-10-15
Kata: _(none yet)_

## Goal

Give a logged-in LunaRoute user visibility into their own queue/usage inside Pi,
and nudge them toward adding lanes or upgrading when they are getting parked.

- **On by default.**
- **Toggle** to turn it off in `/lunaroute settings`.
- **Command** to fetch the information on demand.
- Notifications are proactive when queueing is high, not only on request.

## Non-goals (v1)

- No push channel / websocket / server-initiated notification. Checks are on
  demand plus once per session.
- No nudge/threshold logic in the extension. The server owns what "a lot of
  queued time" means and the upgrade copy.
- No new bespoke REST route in the extension. The aggregate read reuses the
  hosted MCP server.
- Queue time is not surfaced on the 429 error path in v1 (see below).

## Verified facts

Server — `lunaroute-saas` (checked at source):

- The concurrency gate already computes queue wait per request:
  `OrgAdmission.queue_wait: Duration`
  (`services/lunaroute-hosted/src/saas/org_concurrency_gate.rs:~306`).
- The handler captures it before inference starts:
  `RequestTimings.queue_wait_us` (`.../saas/handlers.rs:~356`), plus
  `gate_scope` (managed / background / byok / …).
- Every request already writes a `usage_events` row with `queue_wait_us`;
  gate rejections (`park_timeout` / `rejected_full`) book a row too via
  `book_gate_rejection` (`.../saas/handlers.rs:~525`).
- The 429 response is a generic body (`errors.rs:~258`, `:~766`) plus
  `Retry-After` — it does **not** carry `queue_wait`.
- A usage read path already exists to reuse:
  `services/lunaroute-front/app/api/organizations/[orgId]/metrics/usage/route.ts`.

Pi host (checked at source, 0.85.1 types):

- `after_provider_response` carries `{ status, headers }` and fires once per
  HTTP response, after headers are received and before the stream is consumed
  (`dist/core/extensions/types.d.ts:~706`, emit site `dist/core/sdk.js:~229`).
  It is emitted only when the extension registered a handler.
- The event has **no provider field**; ours is identified by the presence of
  our response header.
- The repo's existing 401 handler states Pi does not emit this event for error
  statuses (verified on 0.85.1, `src/index.ts:~174`).

## Design

Three server-side pieces (A, B) and three extension pieces (C, D, E). The
server pieces are independent and harmless to ship first.

### A. Server: per-request queue headers (lunaroute-saas)

On successful `chat/completions` and `responses` responses, stamp:

```
x-lunaroute-queue-ms: 1420        # RequestTimings.queue_wait_us / 1000, integer
x-lunaroute-gate-scope: managed   # gate_scope.as_str() — diagnostic, optional
```

Where: the response-building path in `.../saas/completions/{mod,stream}.rs`,
alongside existing header writes, using the already-captured `RequestTimings`.
Queue wait is finalized before inference, so it is valid at response start.

Deliberately **not** added to the 429 path in v1 (the body/header surface there
is minimal and the aggregate tool already captures rejections).

### B. Server: aggregate MCP tool `get_usage` (lunaroute-saas)

One read-only tool on the hosted MCP server, self-scoped to the calling key's
user/org. Reuses the existing usage query. Cached server-side (~60 s), keyed by the
authenticated `(org_id, user_id)` only — request parameters never key the cache,
and no cache entry is shared across identities.

```json
{
  "plan":   { "id": "pro", "name": "Pro", "interactiveLanes": 4, "backgroundLanes": 0 },
  "period": { "start": "2026-10-01T00:00:00Z", "end": "2026-10-31T00:00:00Z" },
  "totals": { "requests": 812, "queuedMs": 482000, "rejected": 3, "rejectQueuedMs": 142000 },
  "status": "ok" | "elevated" | "saturated" | "unknown",
  "suggestedAction": {
    "kind": "none" | "add_lanes" | "upgrade_plan",
    "url": "https://app.lunaroute.com/settings/billing",
    "message": "You were parked 8m this month — adding a lane raises your limit."
  }
}
```

- **The server owns thresholds and wording.** `status` is computed from
  server-side plan limits; `suggestedAction` (including `message`) is
  server-authored, so plan tiers and copy can change without an extension
  release. The extension uses `suggestedAction.message` when present and
  otherwise falls back to a built-in per-`status` string, then renders
  `suggestedAction.url` as the link.
- `unknown` is a valid outcome (plan limits unavailable) and must render as
  "no insight", never as a warning.
- No field beyond the caller's own plan + own usage is returned.
- The MCP master toggle (`settings.mcp`) governs model-facing MCP tool
  registration only. Usage insights makes its own direct call and is governed
  solely by `usageInsights`; MCP off does not disable insights.

### C. Extension: setting

- Add `usageInsights: Toggle` to `LunarouteSettings` with
  `DEFAULT_SETTINGS.usageInsights = "on"` (`src/settings.ts`). Absent key =
  on, matching the existing migration semantics.
- Add `usageInsightsEnabled(env, settings)` mirroring `convertToolsEnabled`:
  env `LUNAROUTE_USAGE_INSIGHTS=off|0|false` only ever disables; the file is
  the user knob.
- Add a `SettingsList` row "Usage insights" ("Queue/usage messages and
  `/lunaroute usage`") in `buildSettingsItems` (`src/settings-ui.ts`).

### D. Extension: per-request collection + proactive check

- In the extension factory, when `usageInsightsEnabled`, register
  `pi.on("after_provider_response", ...)`. Read `x-lunaroute-queue-ms` (and
  optional `x-lunaroute-gate-scope`); ignore the event when the header is
  absent (that is another provider). Collect session counters: count, total,
  max, and last queue ms. Malformed values are ignored (never throw).
- **Proactive message source is the aggregate tool, not the raw header.**
  At `session_start` (already exists), when enabled and logged in, call
  `get_usage` once via the extension's MCP client. If `status` is `elevated`
  or `saturated`, `ui.notify` the server-authored message/action. `ok`/`unknown`
  stay silent. A failed call is silent. Notify-at-most-once is enforced by a
  module-level guard for the process (the `adapterNoticeShown` pattern), so a
  reload/resume that re-fires `session_start` does not re-notify.
- Do **not** warn per request. Per-request headers feed only the command
  output.

### E. Extension: `/lunaroute usage` command

- Add subcommand `usage` to the existing `/lunaroute` handler and a "Usage"
  entry to the bare menu (`src/settings-ui.ts`).
- Logged out → "Run /login lunaroute".
- Insights off → "Usage insights are off — enable in /lunaroute settings."
- Otherwise call `get_usage` (bounded timeout) and render: plan + lanes,
  period, queued time, rejections, and the suggested action URL if any.
- On MCP/network failure, fall back to session-local header stats: measured
  requests, total/avg/max queue ms. If nothing measured, say so.
- Model-facing registration of `get_usage` as a Pi tool is **out of scope for
  v1**; the command and session check call the MCP tool directly. (If wanted
  later, follow the `registerWebTools` pattern.)

## Error handling

- Fail-open everywhere: settings errors → default on; absent/malformed header
  → ignore; MCP failure in command → fall back or notify; `session_start`
  check → silent.
- Usage collection never blocks or fails a request.
- Off suppresses the session-start call and all usage data retrieval.
  `/lunaroute usage` still runs but prints only "Usage insights are off —
  enable in /lunaroute settings." so the toggle is discoverable.

## Testing

Extension (`vitest`):

- `settings.test.ts`: default is on; parse/invalid; env hatch disables.
- New `usage.test.ts`: header parse + accumulation (happy, absent, malformed);
  report rendering for each `status`, `suggestedAction`, off, logged-out, and
  MCP-failure fallback, with an injected fake MCP client.
- `settings-ui.test.ts`: `usage` subcommand routing; "Usage insights" row.
- `index.test.ts`: handler registered only when enabled; no session-start
  notify when off or when status is `ok`/`unknown`.

Server (separate plan in `lunaroute-saas`): headers present/absent, tool payload
shape and `unknown` path, self-scoping.

## Rollout

1. Server header (A) — independent, ignored by old extensions.
2. Server `get_usage` (B) — additive tool; absent on old servers.
3. Extension (C–E) — degrades gracefully against a server without A/B: no
   header stats, `unknown`/no-op for the aggregate.

README: document the toggle, the command, `LUNAROUTE_USAGE_INSIGHTS`, and the
server version that provides the data.

## Open items

- Thresholds and copy are server-owned and tunable without an extension
  release. Baseline contract the server ships with (may be retuned later):
  `elevated` when period queued time exceeds ~10% of request time or any
  request was parked-and-rejected; `saturated` at ~25% or repeated rejections;
  `ok` otherwise; `unknown` when plan limits are unavailable. `suggestedAction`
  copy is authored server-side and returned in `message`.
- Confirm at runtime that Pi suppresses `after_provider_response` on non-2xx
  (the repo's 0.85.1 note says it does) — affects nothing in v1 by design.
