# ga6g — `/lunaroute project`: a repo-persisted project ID on every request

2026-11-13 · kata `ga6g` · branch `ga6g-project-id-attribution`

## Intent

LunaRoute splits its usage ledger by *project*: an optional free-form label
(≤128 chars) sent per request as the `LUNAROUTE-PROJECT-ID` header
(https://docs.lunaroute.com/concepts/projects-and-orgs/). Projects change no
auth, routing or concurrency — they only make usage readable per app,
environment or team.

The pi extension tags requests with `lunaroute-agent`, `x-lunaroute-session`
and `lunaroute-session-id` and nothing else (`buildAttributionHeaders`,
`src/lunaroute.ts:72`), so every pi session on a machine lands in one usage
bucket. The user wants to declare "this repo is `lunaroute-web`" once and have
every request from that repo carry it.

## Goals

- `/lunaroute project <name>` writes the project for the current session's
  repository into that repository.
- Bare `/lunaroute project` offers the current value and the repository folder
  name, and lets the user type another name.
- Model requests and LunaRoute MCP tool calls carry the header; a set, change
  or clear mid-session applies to the next request, no restart.
- A repo with no project file sends byte-identical headers to today.

## Non-goals

- `LUNAROUTE_PROJECT_ID` env override (conflicts with "no file ⇒ unchanged",
  and makes `project clear` not clear the effective value). Its own kata.
- System One classifier requests (`createSystemOneClassifier`,
  `src/lunaroute.ts:375`): out of scope, and said so here rather than silently
  omitted by "every model request".
- Server-side project management (create/list/rename), org defaults, per-model
  project overrides.

## Anti-goals

- A project value that can execute a shell command or expand an environment
  variable — see constraints.

## Trust model

A committed `.lunaroute.json` takes effect automatically, for anyone who checks
that repo out. That is the feature — a team shares one label by committing it —
not an accident to be gated: the worst a hostile repo file can do is mislabel
reporting, since the value is validated printable ASCII and never expanded or
executed. The counterweight is visibility: `/lunaroute project` always reports
the effective value *and* the file it came from, so a surprising label is one
command away from being seen and one from being cleared.

## Constraints

- **The header value is untrusted.** `.lunaroute.json` arrives with a cloned
  repo. It must never reach pi's provider *configuration* headers
  (`providerConfig.headers`, `models.json`, model/override headers): those are
  resolved through `resolveConfigValue`, where a leading `!` is run with
  `execSync` (`resolve-config-value.js:65`) and `$VAR` is interpolated
  (`provider-composer.js:263`). Literal request headers only
  (`ProviderRequestOptions.headers`, merged last by the openai adapters).
- **Static seams cannot carry it.** `providerConfig.headers` is built once at
  extension load (`src/index.ts:189`); MCP clients capture `opts.headers` at
  construction (`createLunarouteMcpClient`, `src/web-tools.ts:148`).
- **`before_provider_headers` does not fit.** It fires for every provider and
  its payload carries only `headers` (`extensions/types.d.ts:508-515`), so it
  cannot be scoped to LunaRoute without sniffing our own header.
- **Session directory, not process directory.** `ctx.cwd` is authoritative
  (`extensions/types.d.ts:216`); pi sessions can be rooted elsewhere.
- **Header limits:** 128 characters, printable ASCII only (CR/LF and other
  control characters are header injection).

## Approaches considered

- **A — extend the global settings file** (`~/.pi/agent/lunaroute.json`,
  `src/settings.ts`). Cheapest: reuse the tolerant read/write code as-is. Rejected:
  the label is per app/environment/team, so it belongs to the repository; a
  teammate cannot inherit it, and moving between repos means editing one
  machine-global value by hand.
- **B — repo-local `<git root>/.lunaroute.json`, literal per-request headers
  (chosen).** Trades a second config file and a per-request file read for
  per-repo attribution that a team can share by committing it.
- **C — env var only** (`LUNAROUTE_PROJECT_ID`). Rejected: nothing persists per
  repo, and an invisible variable is not something a user will remember to
  export in every shell.

## Design

### 1. Storage — `src/project.ts` (new)

- `findProjectRoot(cwd)`: walk up to the first directory containing `.git`
  (existence test — worktrees and submodules have a `.git` *file*), else `cwd`.
- File `<root>/.lunaroute.json`, `{"project": "<name>"}`.
- `readProject(root, io)` tolerant: missing file, bad JSON, non-object,
  non-string or invalid value ⇒ no project, never throws.
- `writeProject(root, name, io)` and `clearProject(root, io)`: atomic tmp +
  rename. Write failures (read-only checkout, permissions) surface to the
  caller and are reported, never swallowed as success.
- `validateProjectName(raw)`: trim, reject empty, reject >128 chars, reject
  anything outside printable ASCII, and reject the two reserved words `clear`
  and `off` (case-insensitive) — the command grammar reserves them, so a
  project could not be addressed again once set. One function, used by the
  command, by the writer and by the readers, so the rule holds on every path.
- `io` is injected (a small fs interface, same shape/spirit as `SettingsIo` —
  not `readSettings`/`writeSettings`, which are bound to the agent dir).

### 2. Tagging — literal request headers, resolved per request

- **Model requests.** Extend the LunaRoute-only `streamSimple` wrapper
  (`buildRetryingStreamSimple`, `src/lunaroute.ts:470`) to merge
  `headers: {...options?.headers, "LUNAROUTE-PROJECT-ID": value}` from a
  getter. Nothing enters provider config. With no project set the key is not
  added at all — not set to `undefined` or `""` — so the outgoing headers stay
  byte-identical to today. When it is set, drop any case-insensitive variant
  already present in `options.headers` first, so exactly one spelling reaches
  the wire.
- **Session directory.** Capture `ctx.cwd` on `session_start`
  (`src/index.ts:266`) into a module-scoped value, refreshed on every
  session_start (resume/fork). Before the first session_start there is no
  project header — refusing to guess beats attributing to the wrong repo.
  Commands use `ctx.cwd` directly.
- **MCP requests.** `createLunarouteMcpClient` takes attribution headers as a
  function evaluated inside `rpc`, so set/change/clear reaches already
  registered tools. The five call sites stop spreading a captured object and
  pass a closure over (version, sessionId, project).
- **Classifier requests** stay untagged (non-goal above).

### 3. Command surface (`src/settings-ui.ts:253`)

- `/lunaroute project <name>` — validate, write, confirm with the file path.
- `/lunaroute project` — with a dialog-capable UI: notify the effective
  project and its source file, then `select` over
  `[<current value>, <root folder name>, "Enter another name…"]`
  (`ui.input` on the last). The 0.84.1 UI has no pre-filled input value
  (`ExtensionUIDialogOptions` is only signal/timeout), so the folder name is a
  pickable option, not text already typed. Offer it only when it passes
  validation; with no valid candidate and no current value, go straight to
  `input`. Cancel writes nothing.
- Without dialogs (print/json), bare `project` only reports the effective
  value and file path.
- `/lunaroute project clear` (also `off`) — drop the key.
- Update the unknown-option message; `project` needs no login.

### 4. Tests

Injected fs and directory, no real repo or `$HOME`: root discovery (`.git`
file and directory), tolerant read, write/rename failure, validation
(oversize, newline, non-ASCII), `!`/`$` values reaching the wire as literals,
MCP register → set → change → clear, the three command forms. Follow the
temp-dir/fake-I/O conventions in `tests/settings.test.ts`. `npm run check`.

README: one line for the subcommand next to `/lunaroute usage`.

## Left to the builder

- Whether the per-request read needs a cache (path + mtime). Start without;
  measure only if a profile says so.
- Whether the bare-`/lunaroute` TUI menu gets a "Project" entry (one line, only
  if it stays one line).
- Wording of the confirmations and the post-write hint.
