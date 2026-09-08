# `/lunaroute` Settings TUI — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A `/lunaroute` command that opens a pi-native SettingsList TUI for MCP on/off, web tools on/off, and the default search provider (server/brave/exa/kagi), persisted in `~/.pi/agent/lunaroute.json` and applied live where pi allows.

**Architecture:** A new pure-ish `src/settings.ts` owns the settings file (read/write/decide). A new `src/settings-ui.ts` owns the `/lunaroute` command: SettingsList wiring, live-apply actions, RPC fallback. `src/index.ts` wires both in and threads settings into the existing session_start / login orchestration. `src/web-tools.ts` gains settings gating + default-provider injection.

**Tech Stack:** TypeScript, Node.js 22+, Pi extension API (`@earendil-works/pi-coding-agent` >= 0.84.1, `@earendil-works/pi-tui` >= 0.84.1), Vitest, npm.

**Spec:** `docs/superpowers/specs/2026-09-08-bjy9-lunaroute-settings-tui-design.md`

## Global Constraints

- `on` semantics = exactly current behavior (defer rules included). Absent settings file = current behavior, byte-for-byte.
- The settings file is `~/.pi/agent/lunaroute.json` via the existing `agentDirFromEnv()`; reader is per-key tolerant; writes are atomic (tmp+rename) and canonical (three keys only).
- `webTools → on` re-activation goes through `pi.setActiveTools()`, **never** `registerWebTools()` (registered-but-inactive detection no-op trap — see spec).
- `LUNAROUTE_WEB_TOOLS` env still wins over the file. No new env vars.
- Per-call `provider` param on `web_search` keeps winning over the setting.
- All live-apply paths degrade silently or to a hint (login hint, adapter hint, defer notice) — never throw from the command handler.
- No changes to attribution headers, login flow, model sync, or MCP runtime-register contract.
- Tests: no network, no ports; injected IO only (house style).

---

## File Structure

- `src/settings.ts` — NEW: `LunarouteSettings` type, `DEFAULT_SETTINGS`, `SEARCH_PROVIDERS`, `settingsPath(env)`, `readSettings(env, io?)`, `writeSettings(env, settings, io?)` (atomic), `webToolsEnabled(env, settings)` (env wins), `mcpEnabled(settings)`, `resolveSearchProvider(settings)` (`server` → undefined).
- `src/settings-ui.ts` — NEW: `registerLunarouteSettingsCommand(pi, deps)` — `/lunaroute` command; SettingsList items builder (pure, exported for tests); change handler (write + live-apply); login-status header; RPC/no-UI fallbacks.
- `src/web-tools.ts` — MODIFY: `RegisterWebToolsDeps` gains optional `settings`; `webToolsDisabled` consults file+env; `buildWebSearchTool` gains `defaultProvider` and resolves `params.provider ?? defaultProvider`.
- `src/index.ts` — MODIFY: register the command; read settings once at factory; pass into `registerWebTools` calls; gate MCP registration on `mcpEnabled`.
- `tests/settings.test.ts` — NEW.
- `tests/settings-ui.test.ts` — NEW.
- `tests/web-tools.test.ts` — MODIFY (gating + provider default cases).
- `tests/index.test.ts` — MODIFY (settings threaded into session_start orchestration).
- `README.md` — MODIFY (Settings section).

---

### Task 1: `src/settings.ts` + `tests/settings.test.ts`

**Files:**
- Create: `src/settings.ts`, `tests/settings.test.ts`

**Interfaces:**

```ts
export type Toggle = "on" | "off";
export type SearchProviderSetting = "server" | "brave" | "exa" | "kagi";
export interface LunarouteSettings {
  mcp: Toggle;
  webTools: Toggle;
  searchProvider: SearchProviderSetting;
}
export const DEFAULT_SETTINGS: LunarouteSettings; // { on, on, server }
export const SEARCH_PROVIDERS: readonly SearchProviderSetting[];

export function settingsPath(env: NodeJS.ProcessEnv): string;
// join(agentDirFromEnv(env), "lunaroute.json") — export agentDirFromEnv from lunaroute.ts first

export interface SettingsIo {
  readFileSync(path: string): string;          // injected, default node:fs
  writeFileSync(path: string, data: string): void;
  renameSync(from: string, to: string): void;
  randomUUID(): string;
}
export function readSettings(env, io?): LunarouteSettings;   // per-key tolerant; invalid JSON → defaults
export function writeSettings(env, settings, io?): void;      // atomic tmp+rename; canonical 3-key JSON + trailing newline
export function webToolsEnabled(env, settings): boolean;     // env off|0|false wins; else settings.webTools === "on"
export function mcpEnabled(settings): boolean;                 // settings.mcp === "on"
export function resolveSearchProvider(settings): "brave" | "exa" | "kagi" | undefined; // "server" → undefined
```

**Steps:**
- [x] Export `agentDirFromEnv` from `src/lunaroute.ts` (currently module-private).
- [x] Implement `src/settings.ts` per interface above. Reader: JSON.parse in try/catch → defaults; per-key validation (invalid value → default for that key only; extra keys ignored). Writer: JSON.stringify 2-space + `\n`, tmp file `${path}.${uuid}.tmp`, rename over target.
- [x] `tests/settings.test.ts`: defaults on missing file / invalid JSON / partial file (`{"mcp":"off"}` → `{off, on, server}`); invalid value per key; extra keys ignored; env precedence for webTools (`off`/`0`/`false` variants, and file-off + env-on → still off since env only disables); `resolveSearchProvider` mapping; write round-trip via tmp dir (`mkdtempSync`, `PI_CODING_AGENT_DIR` env) — file exists, no `.tmp` leftovers, canonical shape.
- [x] `npm run check` green.

### Task 2: settings gating + default provider in `src/web-tools.ts`

**Files:**
- Modify: `src/web-tools.ts`, `tests/web-tools.test.ts`

**Interfaces:**

```ts
export interface RegisterWebToolsDeps {
  key: string;
  env: NodeJS.ProcessEnv;
  version: string;
  sessionId: string;
  fetchImpl?: FetchLike;
  settings?: LunarouteSettings;        // NEW optional; absent → DEFAULT_SETTINGS
}
export interface WebToolBuildDeps {
  client: LunarouteMcpClient;
  mcpToolName: string;
  defaultProvider?: "brave" | "exa" | "kagi";  // NEW optional
}
```

**Steps:**
- [x] `registerWebTools`: replace `webToolsDisabled(env)` with `!webToolsEnabled(env, deps.settings ?? DEFAULT_SETTINGS)` (returns `skipped-disabled` outcome as today).
- [x] `buildWebSearchTool`: execute passes `provider: params.provider ?? deps.defaultProvider` to `callTool` (undefined = omit → server default). No schema change — per-call param stays.
- [x] Tests: `webTools: "off"` in settings → `{skipped-disabled, skipped-disabled}` without any network (inject fetch that throws if called); env `LUNAROUTE_WEB_TOOLS=off` beats `webTools: "on"`; default provider forwarded when params omit it; per-call `provider` param still wins over default; `defaultProvider: undefined` omits the key from the MCP arguments.
- [x] `npm run check` green.

### Task 3: `/lunaroute` command — `src/settings-ui.ts` + wiring

**Files:**
- Create: `src/settings-ui.ts`, `tests/settings-ui.test.ts`
- Modify: `src/index.ts`, `tests/index.test.ts`

**Interfaces:**

```ts
export interface SettingsCommandDeps {
  env: NodeJS.ProcessEnv;
  version: string;
  sessionId: string;
  readSettings?: typeof readSettings;   // injectable for tests
  writeSettings?: typeof writeSettings;
  webToolNames?: ReadonlySet<string>;   // default {web_search, web_fetch}
}
export function buildSettingsItems(settings: LunarouteSettings): SettingItem[];  // pure
export function registerLunarouteSettingsCommand(pi: ExtensionAPI, deps: SettingsCommandDeps): void;
```

**Steps:**
- [x] `buildSettingsItems`: three rows per spec (mcp, webTools, searchProvider with values `["server","brave","exa","kagi"]`).
- [x] Command handler: guard `!ctx.hasUI` → return; `ctx.mode !== "tui"` → `ctx.ui.notify("Run /lunaroute in interactive mode, or edit <path>")` with the real path; return.
- [x] TUI: resolve key via `ctx.modelRegistry.getApiKeyForProvider(LUNAROUTE_PROVIDER)` for the header line (logged in ✓ / `Not logged in — run /login lunaroute`); `ctx.ui.custom()` hosting Container + title + status line + SettingsList with `getSettingsListTheme()`; close → done(undefined).
- [x] Change handler `(id, newValue)`: update in-memory settings, `writeSettings` (file first — source of truth), then live-apply:
  - `webTools off` → `pi.setActiveTools(pi.getActiveTools().filter(n => !webToolNames.has(n)))`
  - `webTools on` → registered ∩ webToolNames via `pi.getAllTools()`; if any → add to active set; none → if key → `registerWebTools(pi, {key, ...})` else notify login hint
  - `mcp off` → `void disposeLunarouteMcp()`
  - `mcp on` → if `isLunarouteMcpConfigured(env)` → `maybeShowConfiguredNotice`; else key → `registerLunarouteMcp(pi, key, deps)` (missing adapter / no key → existing hints); never throw
  - `searchProvider` → nothing (next call reads it)
- [x] `src/index.ts`: read settings at factory (`readSettings(process.env)`); `registerLunarouteSettingsCommand(pi, { env: process.env, version: VERSION, sessionId })`; pass `settings` into both `registerWebTools` call sites; gate session_start + post-login MCP registration on `mcpEnabled(settings)`.
- [x] `tests/settings-ui.test.ts`: items builder pure test; handler fallback branches (no-UI, RPC notify) with fake pi/ctx; change handler for each direction against fake pi recording `setActiveTools`/`registerTool` calls (off removes only web tools; on re-activates registered ones; on with nothing registered + no key → notify, no throw); write called with updated settings before apply (ordering); fake `custom` capturing the component → simulate change callbacks.
- [x] `tests/index.test.ts`: extend the fake-pi session_start test — settings `{mcp:"off"}` → no `registerLunarouteMcp` events; `{webTools:"off"}` → no web tool registration even with server offering it; defaults → behavior unchanged.
- [x] `npm run check` green.

### Task 4: README + smoke

**Files:**
- Modify: `README.md`

**Steps:**
- [x] New "Settings" section: `/lunaroute` screenshot-style description, the three rows, file path + shape, env override note (`LUNAROUTE_WEB_TOOLS`), "provider applies as default; the model can still override per call".
- [ ] Manual smoke (interactive TUI — needs a human in a terminal):
- [x] Final `npm run check` + review diff against plan.

## Risks / Notes

- `SettingsList` API shape taken from tui.md Pattern 3 (pi 0.85.1); if constructor differs at runtime the fallback is trivial (it's the documented pattern pi's own examples use).
- The registered-but-inactive trap (spec "Live apply") is the one non-obvious behavior; covered by an explicit test.
- No semver concerns: absent file = current behavior, so 0.6.0 → 0.7.0 minor bump at release time.
