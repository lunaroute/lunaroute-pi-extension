# `/lunaroute` Settings TUI — Design

Date: 2026-09-08
Kata: `bjy9`

## Goal

One command — `/lunaroute` — opens a pi-native settings TUI where the user can:

1. Enable/disable the hosted LunaRoute MCP auto-registration (`generate_image`
   etc., surfaced through pi-mcp-adapter).
2. Enable/disable the first-class web tools (`web_search` / `web_fetch`).
3. Pick the default web search provider: server / brave / exa / kagi.

Settings persist across sessions and apply immediately — no `/reload` when
possible.

## Why

- Today every knob is either env-only (`LUNAROUTE_WEB_TOOLS=off`) or not
  exposed at all: MCP registration is unconditional when logged in, and the
  search provider exists only as a per-call LLM parameter — never a
  user-chosen default.
- Env vars are invisible to normal users. Research (verified at the source
  level, see below) shows pi has no settings-contribution API, so the
  pi-idiomatic settings UI is an extension command + `SettingsList` — the same
  component pi's own `/settings` uses.

## Verified research (pi 0.85.1 — current latest at time of writing)

- **No settings-contribution API.** The full `ExtensionAPI` interface
  (`extensions.d.ts`) has no `registerSettings`, no `ctx.settings`, and no way
  to inject rows into pi's built-in `/settings`.
- **pi's `settings.json` is namespace-tolerant** (verified in
  `dist/core/settings-manager.js`): loading is plain `JSON.parse` +
  `migrateSettings` (rewrites only known legacy keys; no schema validation),
  and saves are field-tracked (re-read the file inside a lock, overlay only
  fields pi modified this session). A `"lunaroute": {...}` key would survive
  every pi save. We nonetheless use an extension-owned file: zero coupling to
  an undocumented internal, no lockfile dependency, atomic writes.
- **The native UI is buildable today**: `SettingsList`
  (`@earendil-works/pi-tui`) and `getSettingsListTheme()`
  (`@earendil-works/pi-coding-agent`) are real exports;
  `SettingItem = {id, label, currentValue, values: string[]}`.
- **Mode caveat**: `ctx.ui.custom()` returns `undefined` in RPC mode → guard
  with `ctx.mode === "tui"`; `ctx.ui.notify` works in TUI + RPC, is a no-op
  risk only in print mode (guard with `ctx.hasUI`).
- **Live apply is possible**: `pi.setActiveTools()` deactivates tools
  immediately (registered-but-inactive stays in `getAllTools()`);
  `disposeLunarouteMcp()` / `registerLunarouteMcp()` already exist for the MCP
  direction pair.

## Design decisions

### Storage — `~/.pi/agent/lunaroute.json`

- Global-only (account-level prefs, not per-project). Path via the existing
  `agentDirFromEnv()` (respects `PI_CODING_AGENT_DIR`).
- Exact shape (no version field; three keys):

```json
{ "mcp": "on", "webTools": "on", "searchProvider": "server" }
```

- Reader is tolerant: missing file, invalid JSON, or unknown/invalid values
  fall back to the defaults above, per key. Extra keys are ignored on read;
  writes emit the canonical three-key object (the file is ours).
- Writes are atomic: tmp file + rename, in the same directory.

### Command — `/lunaroute`, no arguments

- TUI mode: `ctx.ui.custom()` hosting a `SettingsList` with
  `getSettingsListTheme()`. Rows:

| id | label | values |
|---|---|---|
| `mcp` | LunaRoute MCP tools (generate_image…) | on / off |
| `webTools` | Web search tools (web_search, web_fetch) | on / off |
| `searchProvider` | Search provider | server / brave / exa / kagi |

- A dim header line shows login status (resolved before opening the list):
  logged in ✓ / `Not logged in — run /login lunaroute`.
- RPC mode: `notify("Run /lunaroute in interactive mode, or edit ~/.pi/agent/lunaroute.json")`.
  No dialog cascade — the JSON is self-documenting for agent users.
- Logged out: settings still open and save; a toggle-on that needs a key shows
  the login hint instead of silently failing.

### Semantics — `on` means exactly today's behavior

- `mcp: "on"` = register at session_start + post-login, **including** the
  defer-to-user-mcp.json rule (`isLunarouteMcpConfigured`). That defer is
  collision-avoidance, not user intent — it is not a separate mode.
- `webTools: "on"` = auto-backfill when no other extension provides web
  search/fetch and the server offers the tool. A "force ours" mode would be
  a lie: cross-extension tool names are first-registration-wins, and a
  duplicate registration is silently ignored.
- `searchProvider: "server"` = omit the provider argument and let the server
  default decide.
- Absent file = defaults = byte-for-byte current behavior on upgrade.

### Provider injection

`web_search` execute resolves the provider as
`params.provider ?? settings.searchProvider` (per-call model override keeps
winning; `server` maps to omitting the argument). Applies to the very next
call — no state to flush.

### Live apply (from the command's change handler)

- `webTools → off`: `setActiveTools(active.filter(n => !webToolNames.has(n)))`.
- `webTools → on`: **re-activate via `setActiveTools`, not `registerWebTools`**
  — the tools stay *registered-but-inactive* after deactivation, so
  `registerWebTools`' detection (`getAllTools()`) would no-op and leave them
  off. `registerWebTools` remains the session-start / not-yet-registered path
  (needs a key; logged out → login hint).
- `mcp → off`: `disposeLunarouteMcp()`.
- `mcp → on`: mirror session_start — if user-configured MCP exists, show the
  defer notice; else `registerLunarouteMcp()` (adapter-missing and
  logged-out cases already degrade to hints).
- `searchProvider → *`: nothing to apply.
- Every change writes the file first (the file is the source of truth;
  in-process application is an optimization on top).

### Env interplay

`LUNAROUTE_WEB_TOOLS=off|0|false` remains and **wins** over the file
(dev/CI escape hatch). No new env vars are added — the file is the user
surface, and the env surface stays exactly as documented.

## Testing

- `tests/settings.test.ts`: defaults on absent/invalid input, per-key
  tolerance, canonical write shape, env precedence, provider resolution
  (`params.provider ?? settings.searchProvider`, `server` → undefined),
  atomic write (tmp+rename).
- `tests/web-tools.test.ts` (extended): `registerWebTools` respects a
  `webTools: "off"` setting; execute passes the default provider when the
  model didn't specify one.
- `tests/settings-ui.test.ts`: command wiring against a fake `pi`/ctx —
  SettingsList items built from settings, change handler writes + applies
  (on/off directions incl. the registered-but-inactive re-activation rule,
  defer notice on mcp-on), RPC fallback notify, no-UI guard.

## Out of scope

- URL overrides in the TUI (`LUNAROUTE_ROUTING_URL` etc. stay env-only).
- Any pi `/settings` integration (impossible today).
- Project-level settings layering (`.pi/lunaroute.json`).
- Provider list fetched from the server (static brave/exa/kagi in v1).
