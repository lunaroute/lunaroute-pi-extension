# Usage Insights & Queue Nudge — Extension Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add on-by-default usage insights to the LunaRoute Pi extension — collect per-request queue time from response headers, render `/lunaroute usage`, and show a once-per-process proactive nudge driven by the server's aggregate tool.

**Architecture:** A new `src/usage.ts` holds pure parsing/accumulation/formatting plus one MCP call. `src/settings.ts` gains a toggle; `src/settings-ui.ts` gains a settings row and the `usage` subcommand; `src/index.ts` wires the `after_provider_response` hook and the `session_start` check. No server changes in this plan (see the server plan).

**Tech Stack:** TypeScript, vitest, `ExtensionAPI` (`@earendil-works/pi-coding-agent`), the existing `LunarouteMcpClient` from `src/web-tools.ts`.

**Spec:** `docs/superpowers/specs/2026-10-15-usage-insights-queue-nudge-design.md`

## Global Constraints

- `usageInsights` defaults to `"on"`; an absent `lunaroute.json` key must behave as `"on"` (same semantics as the other toggles).
- `LUNAROUTE_USAGE_INSIGHTS` set to `off` / `0` / `false` only ever disables; the file is the user knob.
- The server owns `status` thresholds and `suggestedAction.message`; the extension maps `status` to presentation only.
- The proactive check runs at most once per process.
- Fail-open everywhere: a malformed header is ignored, a failed MCP call is silent, no hook/command throws.
- `get_usage` returns its JSON payload as text content of an MCP tool result.
- No model-facing tool registration in this plan.

## Review Focus

- A non-numeric, negative, or absurd `x-lunaroute-queue-ms` must be ignored, never produce `NaN` in totals.
- An old server without `get_usage` must not break `/lunaroute usage` — fall back to session stats; the proactive check stays silent.
- `status: "unknown"` must render as "no insight", never as a warning.
- Toggling insights off mid-process must suppress further checks and command output.
- A turn with several provider responses must accumulate each wait once, and must not re-run the proactive check.

---

### Task 1: `usageInsights` setting

**Files:**
- Modify: `src/settings.ts`
- Test: `tests/settings.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `LunarouteSettings.usageInsights: Toggle`; `DEFAULT_SETTINGS.usageInsights = "on"`; `usageInsightsEnabled(env, settings): boolean`.

`readSettings(env, io?)` in `src/settings.ts` already takes an optional second
argument defaulting to real file I/O, so `readSettings(process.env)` is the
correct production call (the two-argument form is only for tests).

- [ ] **Step 1: Write the failing tests**

Add to `tests/settings.test.ts`:

```ts
it("defaults usageInsights to on", () => {
  expect(readSettings({}, emptyIo()).usageInsights).toBe("on");
});

it("parses usageInsights and ignores invalid values", () => {
  expect(readSettings({}, ioWith('{"usageInsights":"off"}')).usageInsights).toBe("off");
  expect(readSettings({}, ioWith('{"usageInsights":"maybe"}')).usageInsights).toBe("on");
});

it("LUNAROUTE_USAGE_INSIGHTS only disables", () => {
  expect(usageInsightsEnabled({ LUNAROUTE_USAGE_INSIGHTS: "off" }, { ...DEFAULT_SETTINGS, usageInsights: "on" })).toBe(false);
  expect(usageInsightsEnabled({ LUNAROUTE_USAGE_INSIGHTS: "on" }, { ...DEFAULT_SETTINGS, usageInsights: "off" })).toBe(false);
  expect(usageInsightsEnabled({}, { ...DEFAULT_SETTINGS, usageInsights: "on" })).toBe(true);
});
```

(`emptyIo` / `ioWith` — reuse the existing test helpers in this file; if none match, follow the `SettingsIo` fake already used there.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/settings.test.ts`
Expected: FAIL — `usageInsights` undefined / `usageInsightsEnabled` not exported.

- [ ] **Step 3: Implement**

In `src/settings.ts`: add `usageInsights: Toggle` to `LunarouteSettings`, `usageInsights: "on"` to `DEFAULT_SETTINGS`, a `parseToggle(obj.usageInsights, DEFAULT_SETTINGS.usageInsights)` line in `readSettings`, and:

```ts
/** Usage insights enabled? Same contract as convertToolsEnabled — the env
 * escape hatch only ever disables; the file is the user knob. */
export function usageInsightsEnabled(env: NodeJS.ProcessEnv, settings: LunarouteSettings): boolean {
  const v = env[LUNAROUTE_ENV_USAGE_INSIGHTS];
  if (v === "off" || v === "0" || v === "false") return false;
  return settings.usageInsights === "on";
}
```

(`env[LUNAROUTE_ENV_USAGE_INSIGHTS]` — bracket access, because the constant's
*value* is `"LUNAROUTE_USAGE_INSIGHTS"`; dot access would read a property
literally named `LUNAROUTE_ENV_USAGE_INSIGHTS`.)

Add `export const LUNAROUTE_ENV_USAGE_INSIGHTS = "LUNAROUTE_USAGE_INSIGHTS";` to `src/lunaroute.ts` (it lives there so `settings.ts` can import it without a cycle, mirroring the other tool env vars).

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/settings.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/settings.ts src/lunaroute.ts tests/settings.test.ts
git commit -m "feat(usage): add usageInsights setting"
```

---

### Task 2: Header parsing and session accumulation (pure)

**Files:**
- Create: `src/usage.ts`
- Test: `tests/usage.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `parseQueueMs(headers: Record<string, string>): number | undefined` — integer ms from `x-lunaroute-queue-ms`, or `undefined`.
  - `interface SessionQueueStats { requests: number; totalMs: number; maxMs: number; lastMs: number }`
  - `emptyStats(): SessionQueueStats`
  - `recordQueueWait(stats: SessionQueueStats, ms: number): SessionQueueStats` (returns a new object).
  - `setInsightsOn(on: boolean): void` / `isInsightsOn(): boolean` / `_resetInsightsState(): void` — the process-wide cached gate both `index.ts` and the settings applier share, so no file I/O happens per provider response.

- [ ] **Step 1: Write the failing tests**

`tests/usage.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { emptyStats, parseQueueMs, recordQueueWait } from "../src/usage.js";

describe("parseQueueMs", () => {
  it("reads an integer millisecond value", () => {
    expect(parseQueueMs({ "x-lunaroute-queue-ms": "1420" })).toBe(1420);
  });
  it("returns undefined when the header is absent", () => {
    expect(parseQueueMs({ "content-type": "text/event-stream" })).toBeUndefined();
  });
  it("ignores non-numeric, negative and absurd values", () => {
    expect(parseQueueMs({ "x-lunaroute-queue-ms": "abc" })).toBeUndefined();
    expect(parseQueueMs({ "x-lunaroute-queue-ms": "-5" })).toBeUndefined();
    expect(parseQueueMs({ "x-lunaroute-queue-ms": "999999999999999" })).toBeUndefined();
  });
});

describe("recordQueueWait", () => {
  it("accumulates count, total, max and last", () => {
    let s = emptyStats();
    s = recordQueueWait(s, 100);
    s = recordQueueWait(s, 20);
    expect(s).toEqual({ requests: 2, totalMs: 120, maxMs: 100, lastMs: 20 });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/usage.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/usage.ts`**

`parseQueueMs`: lowercase-lookup the header, parse with a strict integer regex (`/^\d+$/`), reject values above a sane ceiling (use `60 * 60 * 1000` — one hour; anything larger is corrupt). `recordQueueWait` returns a fresh object. Keep types exported. The gate is a module-level `let insightsOn = false` with the three exported accessors (default off until the first `session_start` or settings write sets it).

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/usage.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/usage.ts tests/usage.test.ts
git commit -m "feat(usage): parse queue header and accumulate session stats"
```

---

### Task 3: `fetchUsage` over MCP

**Files:**
- Modify: `src/usage.ts`
- Test: `tests/usage.test.ts`

**Interfaces:**
- Consumes: `LunarouteMcpClient` (from `src/web-tools.ts`).
- Produces:
  - `type UsageStatus = "ok" | "elevated" | "saturated" | "unknown"`
  - `interface UsageSnapshot { plan: { id: string; name: string; interactiveLanes?: number; backgroundLanes?: number }; ... }` — **lane fields are absent when unavailable, never `null`.** The server omits them (`skip_serializing_if = "Option::is_none"`); `parseUsageSnapshot` accepts `undefined` and treats it as unknown. If a server ever sends `null`, the parser treats it as absent rather than rejecting the whole snapshot.
  - `parseUsageSnapshot(raw: unknown): UsageSnapshot | undefined` (pure, validates the shape)
  - `fetchUsage(client: LunarouteMcpClient, signal?: AbortSignal): Promise<UsageSnapshot | undefined>`

- [ ] **Step 1: Write the failing tests**

```ts
it("parses a well-formed get_usage result", async () => {
  const client = fakeClient({ text: JSON.stringify(VALID_SNAPSHOT) });
  await expect(fetchUsage(client)).resolves.toEqual(VALID_SNAPSHOT);
});

it("returns undefined when the tool errors or is absent", async () => {
  const throwing = { callTool: async () => { throw new Error("MCP tools/call failed"); } } as unknown as LunarouteMcpClient;
  await expect(fetchUsage(throwing)).resolves.toBeUndefined();
});

it("returns undefined on malformed payloads", async () => {
  const client = fakeClient({ text: "not json" });
  await expect(fetchUsage(client)).resolves.toBeUndefined();
});
```

Define `VALID_SNAPSHOT` from the spec payload and a `fakeClient({text})` whose `callTool` resolves `{ content: [{ type: "text", text }] }`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/usage.test.ts`
Expected: FAIL — `fetchUsage` not exported.

- [ ] **Step 3: Implement**

`fetchUsage` calls `client.callTool("get_usage", {}, signal)` — the signal is **forwarded as the third argument**; `LunarouteMcpClient.callTool(name, args, signal?)` passes it to `rpc(...)` and on to `fetch`, so an aborted signal really cancels the in-flight request. If `signal` is omitted the call is unbounded; the command always supplies one. The function joins the `content[].text`, `JSON.parse`es it, and passes it through `parseUsageSnapshot`. Wrap the whole thing in try/catch and return `undefined` on any failure (including abort). `parseUsageSnapshot` checks: `status` is one of the four values, `plan.name`/`plan.id` are strings, `totals` numeric fields are finite numbers, `period` strings. Drop unknown extra fields.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/usage.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/usage.ts tests/usage.test.ts
git commit -m "feat(usage): fetch and parse the get_usage MCP snapshot"
```

---

### Task 4: Report formatting and nudge selection

**Files:**
- Modify: `src/usage.ts`
- Test: `tests/usage.test.ts`

**Interfaces:**
- Consumes: `UsageSnapshot`, `SessionQueueStats`.
- Produces:
  - `formatUsageReport(snapshot: UsageSnapshot | undefined, stats: SessionQueueStats): string`
  - `nudgeMessage(snapshot: UsageSnapshot): string | undefined` — only for `elevated` / `saturated`; prefers `suggestedAction.message`, else a built-in per-status string.

- [ ] **Step 1: Write the failing tests**

```ts
it("reports plan, lanes, period and queued totals", () => {
  const text = formatUsageReport(VALID_SNAPSHOT, { requests: 2, totalMs: 120, maxMs: 100, lastMs: 20 });
  expect(text).toContain("Pro");
  expect(text).toContain("4 lanes"); // plan.interactiveLanes
  expect(text).toContain("8m 2s"); // 482000 ms formatted
  expect(text).toContain("3 rejected"); // totals.rejected
  expect(text).toContain("this session: 2 requests, 120 ms queued, avg 60 ms, max 100 ms");
});

it("falls back to session stats when the snapshot is missing", () => {
  const text = formatUsageReport(undefined, { requests: 2, totalMs: 120, maxMs: 100, lastMs: 20 });
  expect(text).toContain("usage unavailable");
  expect(text).toContain("this session: 2 requests, 120 ms queued, avg 60 ms, max 100 ms");
});

it("fallback with zero measured requests omits the average without NaN", () => {
  const text = formatUsageReport(undefined, { requests: 0, totalMs: 0, maxMs: 0, lastMs: 0 });
  expect(text).not.toContain("NaN");
  expect(text).toContain("no queued responses measured");
});

it("nudges only for elevated and saturated", () => {
  expect(nudgeMessage({ ...VALID_SNAPSHOT, status: "ok" })).toBeUndefined();
  expect(nudgeMessage({ ...VALID_SNAPSHOT, status: "unknown" })).toBeUndefined();
  expect(nudgeMessage({ ...VALID_SNAPSHOT, status: "elevated", suggestedAction: { kind: "add_lanes", message: "Add a lane" } })).toBe("Add a lane");
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/usage.test.ts`
Expected: FAIL — not exported.

- [ ] **Step 3: Implement**

A small `formatMs(ms)` helper (seconds/minutes). A snapshot report renders: plan name, **interactive lane count when present**, period, queued total, **rejection count and rejection queue time**, status, and `suggestedAction.url` when present. **The `undefined`-snapshot branch must still render the measured local stats** — request count, total queued, average (`totalMs / requests`), and max — never discarding them; it only adds "usage unavailable" for the plan/period part. With `requests === 0` it renders "no queued responses measured" and never divides (no `NaN`). Built-in nudge strings are generic ("LunaRoute is queueing your requests often — run /lunaroute usage for details."); the server `message` wins when present.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/usage.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/usage.ts tests/usage.test.ts
git commit -m "feat(usage): format reports and select nudges"
```

---

### Task 5: `/lunaroute usage` subcommand and menu entry

**Files:**
- Modify: `src/settings-ui.ts`
- Test: `tests/settings-ui.test.ts`

**Interfaces:**
- Consumes: `usageInsightsEnabled`, `fetchUsage`, `formatUsageReport`, `createLunarouteMcpClient`, `resolveMcpUrl`, `buildAttributionHeaders`.
- Produces: `runUsageCommand(ctx, deps, getQueueStats: () => SessionQueueStats, clientFactory?)` (exported for tests); `/lunaroute usage`; bare-menu option "Usage".

The stats argument is a **live getter**, not a captured value: `queueStats` is
reassigned on every provider response, so the command must read it at
invocation time or it will render stale totals.

- [ ] **Step 1: Write the failing tests**

Add to `tests/settings-ui.test.ts`, following the existing command tests:

```ts
it("/lunaroute usage says off when insights are disabled", async () => { /* notify contains "off" */ });
it("/lunaroute usage says login when no key", async () => { /* notify contains "login" */ });
it("/lunaroute usage reports the snapshot", async () => { /* injected clientFactory returns VALID_SNAPSHOT; notify contains plan name */ });
it("/lunaroute usage falls back on tool failure", async () => { /* client throws; notify contains session stats or usage unavailable */ });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/settings-ui.test.ts`
Expected: FAIL — unknown option / no handler.

- [ ] **Step 3: Implement**

In the `/lunaroute` handler add `if (sub === "usage") { await runUsageCommand(...); return; }` and extend the unknown-option hint. Add "Usage" to `ctx.ui.select`. `runUsageCommand` reads settings; if `usageInsightsEnabled` is false, notify the off message and return; look up the key; if absent, notify the login hint; otherwise build a client

```ts
createLunarouteMcpClient({
  url: resolveMcpUrl(deps.env),
  headers: {
    "LUNAROUTE-API-KEY": key, // the same auth header the web tools use
    ...buildAttributionHeaders(deps.version, deps.sessionId),
  },
  fetchImpl: fetch,
})
```

call `fetchUsage` with a `setTimeout`-aborted signal (~10 s), and notify
`formatUsageReport(snapshot, getQueueStats())` — calling the getter **after**
the await, so the numbers include any responses that landed meanwhile. The
`clientFactory` parameter defaults to the real one so tests inject a fake.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/settings-ui.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/settings-ui.ts tests/settings-ui.test.ts
git commit -m "feat(usage): add /lunaroute usage command and menu entry"
```

---

### Task 6: Wire the response hook and the once-per-process check

**Files:**
- Modify: `src/settings-ui.ts` (settings row)
- Modify: `src/index.ts`
- Test: `tests/index.test.ts`, `tests/settings-ui.test.ts`

**Interfaces:**
- Consumes: Task 1–5 exports.
- Produces: a `usageInsights` SettingsList row; a session-scoped `SessionQueueStats` accumulator owned by `index.ts`; the gated `after_provider_response` handler; the `session_start` proactive check behind a module-level guard.

- [ ] **Step 1: Write the failing tests**

`tests/index.test.ts` (reuse the existing `ExtensionAPI` fake):

```ts
it("ignores response events when usage insights are off", async () => { /* handler registered, settings off → stats unchanged */ });
it("toggling the usageInsights row updates the gate immediately", async () => { /* applyApplier("usageInsights","off") → isInsightsOn() false; then "on" → true */ });
it("accumulates queue waits from response headers", async () => { /* two events → stats updated */ });
it("runs the proactive check at most once per process", async () => { /* two session_starts → one notify */ });
it("stays silent for ok/unknown/off", async () => { /* no notify */ });
```

`tests/settings-ui.test.ts`: `buildSettingsItems({...DEFAULT_SETTINGS}).map(i => i.id)` contains `"usageInsights"`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/index.test.ts tests/settings-ui.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

`settings-ui.ts`: append the row:

```ts
{ id: "usageInsights", label: "Usage insights", description: "Queue/usage messages and /lunaroute usage", currentValue: settings.usageInsights, values: ["on", "off"] },
```

and in `createSettingChangeApplier`, handle the row explicitly so the cached
gate updates live:

```ts
if (id === "usageInsights") { setInsightsOn(newValue === "on"); return; }
```

(place it beside the `searchProvider` early return — both are pure state
updates with no tool re-registration).

`index.ts`: add a module-level `usageCheckDone = false` (process-scoped, per
spec), a `let queueStats = emptyStats()` that is **reset to `emptyStats()` at
the top of every `session_start`** — session stats are per session even though
the proactive check is per process. In `session_start`, when
`ctx.hasUI`, first resolve the key; **if there is no key, leave
`usageCheckDone` false and return** (so a later logged-in session in the same
process can still be nudged), then `setInsightsOn(
usageInsightsEnabled(process.env, readSettings(process.env)))` and, when on and
`!usageCheckDone`, set `usageCheckDone = true` and run the check (build the
client from the session key, `fetchUsage` with a 10 s abort signal,
`nudgeMessage`, `ctx.ui.notify` on a non-undefined message; swallow all errors).
The signal is mandatory here: `fetchUsage` is unbounded without one and
`session_start` must never hang on a stalled MCP request. Register

```ts
pi.on("after_provider_response", (event) => {
  // Header first: cheap, and it identifies our provider without any I/O.
  const ms = parseQueueMs(event.headers);
  if (ms === undefined || !isInsightsOn()) return;
  queueStats = recordQueueWait(queueStats, ms);
});
```

**The handler is registered unconditionally**, but it does **no file I/O per
response**: `isInsightsOn()` reads the module-level boolean from `src/usage.ts`,
refreshed at `session_start` and updated by the settings applier when the
`usageInsights` row changes (both sides import the same accessors — no callback
plumbing). The header check runs first so another
provider's responses cost one object lookup. This makes an off-toggle take effect immediately without a restart and
without re-registering the handler. The header check runs first so another
provider's responses cost one object lookup. Pass `() => queueStats` into the
`/lunaroute usage` path so the command always reads live totals.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/index.test.ts tests/settings-ui.test.ts`
Expected: PASS.

- [ ] **Step 5: Full check and commit**

Run: `npm run check`
Expected: typecheck + all tests PASS.

```bash
git add src/index.ts src/settings-ui.ts tests/index.test.ts tests/settings-ui.test.ts
git commit -m "feat(usage): collect queue time and notify once per process"
```

---

### Task 7: README

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Document** the `Usage insights` settings row, `/lunaroute usage`, the `LUNAROUTE_USAGE_INSIGHTS` env var in the configuration table, and the server version that provides the data.

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "docs(usage): document insights toggle and command"
```

## Self-Review

- **Spec coverage:** setting (Task 1), header collection (Task 2/6), aggregate tool (Tasks 3/5), command + menu (Task 5), proactive check (Task 6), off semantics (Tasks 5/6), README (Task 7). Server headers/tool are in the server plan.
- **Type consistency:** `UsageSnapshot` / `SessionQueueStats` / `usageInsightsEnabled` names are used identically across tasks.
- **Review Focus:** each of the five lines is pinned — malformed header (Task 2), old server (Tasks 3/5 fallback), `unknown` (Task 4/6), off mid-session (Tasks 5/6), multiple responses (Task 6).
