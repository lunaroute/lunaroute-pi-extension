# Usage Insights & Queue Nudge — Server Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expose per-request queue wait on successful gateway responses and add one read-only `get_usage` MCP tool that returns a self-scoped, server-classified usage snapshot.

**Architecture:** The admission gate already computes `queue_wait` per request; this plan only surfaces it (response header) and aggregates it (`usage_events`) into a normalized snapshot on the hosted MCP server. A new Rust module owns the snapshot build + status classification; `routes/mcp.rs` gains the tool descriptor and dispatch; the response builder stamps the header.

**Tech Stack:** Rust (`lunaroute-hosted`), Axum, SQLx/Postgres (`usage_events`), the hosted MCP route.

**Spec:** `docs/superpowers/specs/2026-10-15-usage-insights-queue-nudge-design.md` (in the `lunaroute-pi-extension` repo)

**Repo:** `lunaroute-saas`

## Global Constraints

- The tool is read-only, self-scoped to the calling key's `(org_id, user_id)`; no cache entry or result may cross identities.
- The server owns `status` thresholds and `suggestedAction.message`; the extension only maps `status`.
- `status` is always one of `ok | elevated | saturated | unknown`; `unknown` when plan limits are unavailable.
- No new request-path work: the header reads an already-captured `queue_wait_us`; the tool query is off the request path.
- `usage_events` is the only aggregate source; do not add instrumentation.

## Review Focus

- A caller with no usage rows this period must get a zeroed snapshot, not an error.
- A tool call must never return another user's or org's data, including through the cache.
- The header must be absent on error responses and must not alter status/body.
- A dark/absent entitlement arm (`None` lanes) must classify as `unknown`, not `saturated`.
- A huge or NULL `queue_wait_us` must not overflow the millisecond conversion.

## Verified integration points

- `OrgAdmission.queue_wait` / `RequestTimings.queue_wait_us` / `gate_scope` — `services/lunaroute-hosted/src/saas/org_concurrency_gate.rs:~306`, `.../saas/handlers.rs:~356`.
- Rejection rows already booked (`book_gate_rejection`, `.../saas/handlers.rs:~525`) with `dispatch_timestamp: None`.
- MCP tool pattern — `services/lunaroute-hosted/src/routes/mcp.rs`: tool-name consts (~`GENERATE_IMAGE`), `tools_list` (~746), `tools_call` name match + dispatch (~961), `annotate_idempotency`.
- Policy gate — `services/lunaroute-hosted/src/saas/mcp_policy.rs` (`tool_policy(...).allows(...)`).
- Plan lanes on the resolved tenant — `services/lunaroute-hosted/src/saas/tenant_resolver.rs:~25` (`plan`, `org_max_concurrent_requests`, `background_lanes`; the effective-lane view is `org_effective_entitlements`, migration 00072).
- Existing metrics query shape to copy — `services/lunaroute-api/internal/models/org_metrics_store.go:~329` (interactive `queue_wait_us` / `latency_us` sums).

---

### Task 1: Snapshot types and status classification (pure)

**Files:**
- Create: `services/lunaroute-hosted/src/saas/usage_insights.rs`
- Modify: `services/lunaroute-hosted/src/saas/mod.rs` (add `pub mod usage_insights;`)
- Test: unit tests in `usage_insights.rs`

**Interfaces:**
- Produces:
  - `pub(crate) struct UsageTotals { pub requests: i64, pub queued_ms: i64, pub request_ms: i64, pub rejected: i64, pub reject_queued_ms: i64 }`
  - `pub(crate) struct PlanView { pub id: String, pub name: String, pub interactive_lanes: Option<u32>, pub background_lanes: Option<u32> }`
  - `pub(crate) enum UsageStatus { Ok, Elevated, Saturated, Unknown }` with `as_str()`
  - `pub(crate) fn classify_status(totals: &UsageTotals, plan: &PlanView) -> UsageStatus`

- [ ] **Step 1: Write the failing tests**

```rust
#[test]
fn zero_usage_is_ok() { /* all-zero totals + lanes -> Ok */ }

#[test]
fn elevated_when_queued_is_at_least_a_tenth_of_request_time_or_any_rejection() {
    // request_ms=1_900_000, queued_ms=190_000 -> Elevated
    // request_ms=1_900_000, queued_ms=0, rejected=1 -> Elevated
}

#[test]
fn saturated_at_a_quarter_or_repeated_rejections() {
    // queued_ms=475_000, request_ms=1_900_000 -> Saturated
    // rejected=3 -> Saturated
}

#[test]
fn unknown_when_lanes_are_unset() {
    // interactive_lanes = None -> Unknown
}

#[test]
fn zero_request_time_cannot_divide_by_zero() { /* request_ms=0, queued_ms>0 -> not a panic; Elevated via any-queue rule */ }
```

Boundaries: at least 10% → `Elevated`; at least 25% → `Saturated`; `rejected >= 3` → `Saturated`; `rejected == 1..=2` → at least `Elevated`; lanes `None` → `Unknown`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test -p lunaroute-hosted usage_insights::`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the types and `classify_status`**

Handle `request_ms == 0` by treating any `queued_ms > 0` as `Elevated` (no division). Do the threshold comparison in `i128` so a large aggregate can never overflow:
`(queued_ms as i128) * 10 >= request_ms as i128` (and `* 4` for the 25%
boundary). No floats, no saturating casts — `i128` holds the full `i64` range
squared safely.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test -p lunaroute-hosted usage_insights::`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add services/lunaroute-hosted/src/saas/usage_insights.rs services/lunaroute-hosted/src/saas/mod.rs
git commit -m "feat(mcp): usage snapshot classification"
```

---

### Task 2: The usage_events read

**Files:**
- Modify: `services/lunaroute-hosted/src/saas/usage_insights.rs`
- Test: unit test with an injected row set (mirror the existing store seams), plus an integration test if the module has DB tests nearby.

**Interfaces:**
- Consumes: `UsageTotals`.
- Produces: `pub(crate) async fn read_totals(pool: &PgPool, org_id: Uuid, user_id: Uuid, start: DateTime<Utc>, end: DateTime<Utc>) -> Result<UsageTotals, sqlx::Error>`

- [ ] **Step 1: Write the failing test**

Use a fake/`sqlx` test pool per the repo's existing store tests. Assert one row set maps to the expected totals, and that an empty set yields all zeros.

- [ ] **Step 2: Run to verify it fails**

Run: `cargo test -p lunaroute-hosted usage_insights::`
Expected: FAIL.

- [ ] **Step 3: Implement the query**

```sql
SELECT
  COUNT(*),
  LEAST(COALESCE(SUM(queue_wait_us), 0), 9223372036854775807)::bigint,
  LEAST(COALESCE(SUM(latency_us), 0), 9223372036854775807)::bigint,
  COUNT(*) FILTER (WHERE dispatch_timestamp IS NULL),
  LEAST(COALESCE(SUM(queue_wait_us) FILTER (WHERE dispatch_timestamp IS NULL), 0), 9223372036854775807)::bigint
FROM usage_events
WHERE org_id = $1 AND user_id = $2
  AND request_timestamp >= $3 AND request_timestamp < $4;
```

`SUM(bigint)` returns `numeric` in Postgres and can exceed `i64`, which would
fail SQLx decoding. `LEAST(..., 9223372036854775807)` clamps **before** the
`::bigint` cast, so the cast always succeeds and the result matches the
saturating semantics the extension assumes. `requests` counts all rows; `rejected` counts **all** gate-rejection rows (`dispatch_timestamp IS NULL`) regardless of whether `queue_wait_us` is NULL — the two columns must not disagree on what a rejection is. `reject_queued_ms` sums only the non-NULL waits (NULLs drop out of `SUM`).

- [ ] **Step 4: Run to verify it passes**

Run: `cargo test -p lunaroute-hosted usage_insights::`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add services/lunaroute-hosted/src/saas/usage_insights.rs
git commit -m "feat(mcp): read usage_events totals for the insights window"
```

---

### Task 3: Assemble the snapshot payload

**Files:**
- Modify: `services/lunaroute-hosted/src/saas/usage_insights.rs`
- Test: unit tests.

**Interfaces:**
- Consumes: `read_totals`, `classify_status`, `ResolvedTenant`.
- Produces:
  - `pub(crate) fn snapshot_json(plan: &PlanView, period: (DateTime<Utc>, DateTime<Utc>), totals: &UsageTotals, status: UsageStatus) -> serde_json::Value`
  - `pub(crate) fn suggested_action(status: UsageStatus) -> serde_json::Value`
  - `pub(crate) fn plan_view(tenant: &ResolvedTenant) -> PlanView`

- [ ] **Step 1: Write the failing tests**

Assert the exact JSON shape from the spec (keys `plan` / `period` / `totals` / `status` / `suggestedAction`, ms integers); `ok`/`unknown` produce `{"kind":"none"}` with no `url`; `elevated` → `add_lanes`, `saturated` → `upgrade_plan`, both with the billing URL and a `message`.

- [ ] **Step 2: Run to verify it fails**

Run: `cargo test -p lunaroute-hosted usage_insights::`
Expected: FAIL.

- [ ] **Step 3: Implement** the three functions. `plan_view` maps `tenant.plan` and both lane arms from the **effective entitlement view**: the resolver's tenant query already selects `e.interactive_lanes AS org_max_concurrent_requests` and `e.background_lanes AS background_lanes` from `org_effective_entitlements e` (`.../saas/tenant_resolver.rs:~1689-1694`), so `interactive_lanes = Some(tenant.org_max_concurrent_requests)` and `background_lanes = tenant.background_lanes` are the authoritative values — no separate entitlements lookup. A `None`/absent arm maps to `None`, which `classify_status` renders as `unknown`. Timestamp the period from the existing billing-period helper used by the usage read (do not invent a window).

- [ ] **Step 4: Run to verify it passes**

Run: `cargo test -p lunaroute-hosted usage_insights::`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add services/lunaroute-hosted/src/saas/usage_insights.rs
git commit -m "feat(mcp): build the get_usage snapshot payload"
```

---

### Task 4: MCP tool `get_usage`

**Files:**
- Modify: `services/lunaroute-hosted/src/routes/mcp.rs`
- Modify: `services/lunaroute-hosted/src/saas/mcp_policy.rs`
- Test: `routes/mcp.rs` tests (follow the existing per-tool tests).

**Interfaces:**
- Consumes: Task 3 exports.
- Produces: `const GET_USAGE: &str = "get_usage";`, `fn get_usage_tool_json() -> Value`, `async fn get_usage_call(state, tenant, user_id, id) -> Response`, plus the `tools_list` line and the `tools_call` match arm.

- [ ] **Step 1: Write the failing tests**

Following the existing tool tests: `tools/list` includes `get_usage` when policy allows and omits it when denied; `tools/call` with `{"name":"get_usage","arguments":{}}` returns a text content payload whose parsed JSON matches the spec, scoped to the caller; a denied policy returns `Outcome::Denied`. Assert an unknown argument is rejected (`"additionalProperties": false` behaviour, mirroring `convert_document`).

- [ ] **Step 2: Run to verify they fail**

Run: `cargo test -p lunaroute-hosted routes::mcp`
Expected: FAIL.

- [ ] **Step 3: Implement**

- `get_usage_tool_json`: `{"name":"get_usage","description":"…","inputSchema":{"type":"object","properties":{},"additionalProperties":false}}`, no arguments.
- `tools_list`: `if policy.allows(GET_USAGE) { tools.push(get_usage_tool_json()); }` — no catalog/entitlement dependency (the tool itself can answer `unknown`).
- `tools_call`: add `GET_USAGE` to the registered-name match, dispatch to `get_usage_call`, and add the arm.
- `get_usage_call`: check `policy.allows(GET_USAGE)` exactly like `convert_document_call` (deny → `mcp_tool_disabled`, `Outcome::Denied`), reject any non-empty arguments, resolve the billing window, call `read_totals`, `classify_status`, `snapshot_json`, and return `tool_result` with `content: [{"type":"text","text": <json string>}]`.
- `mcp_policy.rs`: add `GET_USAGE` to the tool set the policy type carries, defaulting to allowed (match how `CONVERT_DOCUMENT` is wired).

- [ ] **Step 4: Run to verify they pass**

Run: `cargo test -p lunaroute-hosted routes::mcp`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add services/lunaroute-hosted/src/routes/mcp.rs services/lunaroute-hosted/src/saas/mcp_policy.rs
git commit -m "feat(mcp): add the get_usage tool"
```

---

### Task 5: `x-lunaroute-queue-ms` response header

**Files:**
- Modify: `services/lunaroute-hosted/src/saas/handlers.rs` (the shared success-response builder holding `RequestTimings`; the streaming `Body::from_stream` sites at ~4355/4476/10706 are the candidates — use the one function both chat endpoints share, adding the header once).
- Test: `handlers.rs` tests.

**Interfaces:**
- Consumes: `RequestTimings.queue_wait_us`, `RequestTimings.gate_scope`.
- Produces: header `x-lunaroute-queue-ms` on successful chat/completions and responses.

- [ ] **Step 1: Write the failing test**

Extend the existing success-path handler test to assert `response.headers()["x-lunaroute-queue-ms"]` equals the admitted wait in ms (e.g. `"1420"`), and that an error response does **not** carry it.

- [ ] **Step 2: Run to verify it fails**

Run: `cargo test -p lunaroute-hosted handles`
Expected: FAIL — header absent.

- [ ] **Step 3: Implement**

At the point the success `Response` is assembled, insert `x-lunaroute-queue-ms` = `queue_wait_us / 1000` (saturating). **Only this one header** — no `x-lunaroute-gate-scope`; nothing consumes it yet, and an undocumented header is worse than none. Do not touch the 429 path.

- [ ] **Step 4: Run to verify it passes**

Run: `cargo test -p lunaroute-hosted handles`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add services/lunaroute-hosted/src/saas/handlers.rs
git commit -m "feat(gateway): expose queue wait as a response header"
```

---

### Task 6: Docs

**Files:**
- Modify: `services/lunaroute-docs/src/content/docs/mcp/index.md` (add `get_usage`), and the gateway/config docs index listing response headers.

- [ ] **Step 1: Document** the tool's payload and the `x-lunaroute-queue-ms` response header, including the `unknown` status and the self-scoping guarantee.
- [ ] **Step 2: Commit**

```bash
git add services/lunaroute-docs
git commit -m "docs(mcp): document get_usage and queue headers"
```

## Self-Review

- **Spec coverage:** per-request header (Task 5), aggregate tool (Tasks 1–4), server-owned `status`/`message` (Tasks 1/3), self-scoping and cache-identity (Tasks 2/4 — the query binds `(org_id, user_id)`; if a cache is added, key it on that pair), README/docs (Task 6).
- **Type consistency:** `UsageTotals` / `PlanView` / `UsageStatus` / `snapshot_json` names are used identically across tasks.
- **Review Focus:** each line is pinned — empty rows (Task 2), identity scoping (Task 4), header off error paths (Task 5), `None` lanes → `unknown` (Task 1), large/NULL waits saturating (Tasks 2/5).
