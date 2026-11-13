# ga6g `/lunaroute project` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `/lunaroute project <name>` persists a per-repo project ID in `<git root>/.lunaroute.json`, and every model request and LunaRoute MCP call carries it as `LUNAROUTE-PROJECT-ID`.

**Architecture:** A new `src/project.ts` owns discovery, tolerant read, atomic write, validation and the literal header helper. The two request paths resolve the value per request instead of capturing it: the LunaRoute-only `streamSimple` wrapper merges it into `ProviderRequestOptions.headers`, and `createLunarouteMcpClient` accepts attribution headers as a function evaluated inside `rpc`. Nothing touches provider *config* headers.

**Tech Stack:** TypeScript, vitest, pi extension API (`ExtensionAPI`), node:fs.

**Spec:** `docs/superpowers/specs/2026-11-13-ga6g-project-id-design.md`

## Global Constraints

- Header name exactly `LUNAROUTE-PROJECT-ID`; value ≤128 chars, printable ASCII (0x20–0x7E), trimmed.
- Project values are **never** put into `providerConfig.headers`, `models.json` or model/override headers: pi resolves those through `resolveConfigValue`, where a leading `!` is `execSync` and `$VAR` is interpolated. Literal request headers only.
- No project set ⇒ the header key is absent, not empty: outgoing headers byte-identical to today.
- Session directory is `ctx.cwd`, captured on `session_start`; no `process.cwd()` fallback before it.
- `clear` and `off` are reserved project names (case-insensitive).
- No `LUNAROUTE_PROJECT_ID` env override. System One classifier requests stay untagged.
- Everything ends with `npm run check` (typecheck + vitest) green. Work only inside `.worktrees/ga6g-project-id-attribution`.

## Review Focus

1. A cloned repo's committed `.lunaroute.json` silently labels that user's usage — expected (Trust model in spec); the check is that `/lunaroute project` names the source file.
2. Unset project must leave the wire byte-identical: no empty-string or `undefined` header value.
3. `!`- and `$`-prefixed values must reach the wire as literal text, never exec or expand.
4. A resume/fork can change `ctx.cwd`; the headered requests of the new session must follow the new root.
5. `clear` mid-session must drop the header from the very next request (both paths).
6. Unreadable/badly-encoded project file (EACCES, invalid UTF-8, oversized) must degrade to no header, never throw into a request.

---

### Task 1: Repo project storage

**Files:**
- Create: `src/project.ts`
- Test: `tests/project.test.ts`

**Interfaces:**
- Consumes: `SettingsIo` type from `./settings.js` (readFileSync/writeFileSync/renameSync/randomUUID).
- Produces:
  - `export const PROJECT_FILE = ".lunaroute.json"` and `export const PROJECT_HEADER = "LUNAROUTE-PROJECT-ID"`
  - `export interface ProjectIo extends SettingsIo { existsSync(path: string): boolean }`
  - `export function findProjectRoot(cwd: string, io: ProjectIo = defaultProjectIo): string`
  - `export function projectFilePath(root: string): string`
  - `export function validateProjectName(raw: string): { ok: true; name: string } | { ok: false; reason: string }`
  - `export function readProject(root: string, io: ProjectIo = defaultProjectIo): string | undefined`
  - `export function writeProject(root: string, name: string, io: ProjectIo = defaultProjectIo): void` (throws `Error` with the validator's reason on an invalid name)
  - `export function clearProject(root: string, io: ProjectIo = defaultProjectIo): void`
  - `export function projectHeaders(project: string | undefined): Record<string, string>` — `{}` when unset or invalid, else `{ [PROJECT_HEADER]: name }`
  - `export function setSessionRoot(root: string | undefined): void`
  - `export function readSessionProject(io: ProjectIo = defaultProjectIo): string | undefined` — `undefined` before `setSessionRoot`

- [ ] **Step 1: Write the failing tests**

```ts
// tests/project.test.ts
import { describe, expect, test, vi } from "vitest";
import {
  PROJECT_FILE, findProjectRoot, projectFilePath, validateProjectName,
  readProject, writeProject, clearProject, projectHeaders,
  setSessionRoot, readSessionProject, type ProjectIo,
} from "../src/project.js";

function fakeIo(exists: string[], files: Record<string, string> = {}, fail?: Error): ProjectIo {
  return {
    existsSync: (p) => exists.includes(p),
    readFileSync: (p) => {
      if (fail) throw fail;
      if (p in files) return files[p];
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    },
    writeFileSync: vi.fn(),
    renameSync: vi.fn(),
    randomUUID: () => "test-uuid",
  };
}

test("findProjectRoot walks up to the .git file or directory", () => {
  expect(findProjectRoot("/r/a/b", fakeIo(["/r/.git"]))).toBe("/r");
  expect(findProjectRoot("/r", fakeIo(["/r/.git"]))).toBe("/r");
});
test("findProjectRoot falls back to cwd with no .git", () => {
  expect(findProjectRoot("/x/y", fakeIo([]))).toBe("/x/y");
});
test("projectFilePath is <root>/.lunaroute.json", () => {
  expect(projectFilePath("/r")).toBe(`/r/${PROJECT_FILE}`);
});
test("readProject is tolerant", () => {
  const ok = { "/r/.lunaroute.json": '{"project":"web"}' };
  expect(readProject("/r", fakeIo([], ok))).toBe("web");
  for (const bad of ['{"project":42}', '{"project":"caf\u00e9"}', "junk", "[]", '{"other":1}',
    JSON.stringify({ project: "x".repeat(200) })]) {
    expect(readProject("/r", fakeIo([], { "/r/.lunaroute.json": bad }))).toBeUndefined();
  }
  expect(readProject("/r", fakeIo([], {}, Object.assign(new Error("EACCES"), { code: "EACCES" })))).toBeUndefined();
});
test("writeProject validates and writes atomically", () => {
  const io = fakeIo([]);
  writeProject("/r", "web", io);
  expect(io.writeFileSync).toHaveBeenCalledWith(`/r/${PROJECT_FILE}.test-uuid.tmp`, '{\n  "project": "web"\n}\n');
  expect(io.renameSync).toHaveBeenCalledWith(`/r/${PROJECT_FILE}.test-uuid.tmp`, `/r/${PROJECT_FILE}`);
  expect(() => writeProject("/r", "clear", io)).toThrow(/reserved/);
});
test("writeProject propagates a rename failure", () => {
  const io = { ...fakeIo([]), renameSync: () => { throw new Error("read-only"); } };
  expect(() => writeProject("/r", "web", io)).toThrow("read-only");
});
test("clearProject drops the key", () => {
  const io = fakeIo([], { "/r/.lunaroute.json": '{"project":"web"}' });
  clearProject("/r", io);
  expect(io.writeFileSync).toHaveBeenCalledWith(expect.stringContaining(".tmp"), "{}\n");
});
test("validateProjectName", () => {
  expect(validateProjectName("  lunaroute-web  ")).toEqual({ ok: true, name: "lunaroute-web" });
  expect(validateProjectName("my app")).toEqual({ ok: true, name: "my app" });
  for (const [bad, reason] of [
    ["", /empty/], ["x".repeat(129), /128/], ["a\nb", /printable ASCII/], ["caf\u00e9", /printable ASCII/],
    ["clear", /reserved/], [" Off ", /reserved/],
  ] as const) {
    const r = validateProjectName(bad);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(reason);
  }
});
test("projectHeaders omits the key when unset", () => {
  expect(projectHeaders(undefined)).toEqual({});
  expect(projectHeaders("web")).toEqual({ "LUNAROUTE-PROJECT-ID": "web" });
});
test("readSessionProject is undefined before session_start and follows root changes", () => {
  setSessionRoot(undefined);
  expect(readSessionProject(fakeIo([]))).toBeUndefined();
  setSessionRoot("/r");
  expect(readSessionProject(fakeIo([], { "/r/.lunaroute.json": '{"project":"web"}' }))).toBe("web");
  // resume/fork re-captures the directory: the new root wins immediately
  setSessionRoot("/b");
  expect(readSessionProject(fakeIo([], { "/r/.lunaroute.json": '{"project":"web"}' }))).toBeUndefined();
  setSessionRoot(undefined);
});
```

- [ ] **Step 2: Run to verify it fails** — `npx vitest run tests/project.test.ts` → FAIL, `src/project.js` cannot be resolved.

- [ ] **Step 3: Implement `src/project.ts`**

Tolerant reads mirror `readSettings` (`src/settings.ts:115`): every failure path returns "no project", never throws. `writeProject` is tmp+rename with `io.randomUUID()`, `JSON.stringify({ project: name }, null, 2) + "\n"`. `clearProject` writes `"{}\n"` the same way. Discovery: loop `dir = dirname(dir)` while `dir !== dirname(dir)`, checking `io.existsSync(join(dir, ".git"))`, return the first hit, else the starting `cwd`. Session root is one module-level `let sessionRoot: string | undefined`.

- [ ] **Step 4: Run to verify it passes** — `npx vitest run tests/project.test.ts` → PASS.

- [ ] **Step 5: Commit**

```bash
git add src/project.ts tests/project.test.ts
git commit -m "feat(ga6g): repo-local project file, validation, header helper"
```

---

### Task 2: Tag MCP requests per RPC

**Files:**
- Modify: `src/web-tools.ts` (`McpClientOptions.headers`, `rpc`), `src/index.ts:168`, `src/image-tools.ts:745`, `src/convert-tools.ts:488`, `src/settings-ui.ts:478`, `src/web-tools.ts:638`
- Test: `tests/web-tools.test.ts`

**Interfaces:**
- Consumes: `readSessionProject`, `projectHeaders` from `./project.js`.
- Produces: `McpClientOptions.headers: Record<string, string> | (() => Record<string, string>)` — evaluated inside `rpc`, so a change between calls is visible on the next one. Existing object call sites and test fakes keep working.

- [ ] **Step 1: Write the failing test**

```ts
test("headers as a function are re-evaluated on every rpc", async () => {
  const seen: Record<string, string>[] = [];
  const fetchImpl: FetchLike = async (_url, init) => {
    const h: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => (h[k] = v));
    seen.push(h);
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: seen.length, result: { tools: [] } }),
      { status: 200, headers: { "content-type": "application/json" } });
  };
  let project: string | undefined = "web";
  const client = createLunarouteMcpClient({
    url: "https://mcp.test/mcp",
    headers: () => ({ ...projectHeaders(project) }),
    fetchImpl,
  });
  await client.listTools();
  project = "api";
  await client.listTools();
  project = undefined;
  await client.listTools();
  expect(seen[0]["lunaroute-project-id"]).toBe("web");
  expect(seen[1]["lunaroute-project-id"]).toBe("api");
  expect(seen[2]["lunaroute-project-id"]).toBeUndefined();
});
```

- [ ] **Step 2: Run to verify it fails** — `npx vitest run tests/web-tools.test.ts -t "re-evaluated"` → FAIL (TypeError: opts.headers is not a function).

- [ ] **Step 3: Implement**

In `createLunarouteMcpClient.rpc`, replace `...opts.headers` with `...(typeof opts.headers === "function" ? opts.headers() : opts.headers)`; widen the `McpClientOptions.headers` type. Then change the five call sites from a captured object to `() => ({ "LUNAROUTE-API-KEY": key, ...buildAttributionHeaders(version, sessionId), ...projectHeaders(readSessionProject()) })`, keeping whatever else each site already spreads.

- [ ] **Step 4: Run to verify it passes** — `npx vitest run tests/web-tools.test.ts` → PASS (existing object-headers tests still green).

- [ ] **Step 5: Commit**

```bash
git add src/web-tools.ts src/image-tools.ts src/convert-tools.ts src/settings-ui.ts src/index.ts tests/web-tools.test.ts
git commit -m "feat(ga6g): resolve project header per MCP request"
```

---

### Task 3: Tag model requests

**Files:**
- Modify: `src/lunaroute.ts:470` (`buildRetryingStreamSimple`), `src/index.ts:189-197` and `src/index.ts:266` (`session_start`)
- Test: `tests/lunaroute.test.ts`

**Interfaces:**
- Consumes: `projectHeaders`, `readSessionProject`, `findProjectRoot`, `setSessionRoot` from `./project.js`.
- Produces: `buildRetryingStreamSimple(defaultRetries: number, loadApi: (api: WireApi) => ProviderStreams, getConfiguredRetries?: () => number, getProject?: () => string | undefined)` — 4th parameter optional, so existing callers/tests compile unchanged.

- [ ] **Step 1: Write the failing tests** (fake `ProviderStreams` capturing the options it receives)

```ts
test("adds the project header as a literal request header", async () => {
  // streamSimple fake records options.headers
  await wrap(undefined, () => "web").streamSimple(model, ctx, { headers: { "x-keep": "1" } });
  expect(recorded.headers).toEqual({ "x-keep": "1", "LUNAROUTE-PROJECT-ID": "web" });
});
test("no project: headers untouched", async () => {
  await wrap(undefined, () => undefined).streamSimple(model, ctx, { headers: { "x-keep": "1" } });
  expect(recorded.headers).toEqual({ "x-keep": "1" });
});
test("no options at all: still no header", async () => {
  await wrap(undefined, () => undefined).streamSimple(model, ctx, undefined);
  expect(recorded.headers).toBeUndefined();
});
test("replaces a case-insensitive variant", async () => {
  await wrap(undefined, () => "web").streamSimple(model, ctx, { headers: { "lunaroute-project-id": "old" } });
  expect(recorded.headers).toEqual({ "LUNAROUTE-PROJECT-ID": "web" });
});
test("shell-looking values stay literal", async () => {
  await wrap(undefined, () => "!touch /tmp/ga6g-pwned").streamSimple(model, ctx, undefined);
  expect(recorded.headers["LUNAROUTE-PROJECT-ID"]).toBe("!touch /tmp/ga6g-pwned");
  expect(existsSync("/tmp/ga6g-pwned")).toBe(false);
});
```

- [ ] **Step 2: Run to verify they fail** — `npx vitest run tests/lunaroute.test.ts -t "project header"` → FAIL.

- [ ] **Step 3: Implement**

In the wrapper, after computing `merged`: when `getProject?.()` yields a valid name, copy `options.headers` into a fresh object, delete every key whose lowercase is `lunaroute-project-id`, `Object.assign` the `projectHeaders(value)`, and set `merged.headers`. When there is no project, do not touch `headers` at all. Wire `src/index.ts`: `streamSimple: buildRetryingStreamSimple(LUNAROUTE_DEFAULT_PROVIDER_RETRIES, loadBuiltinApi, () => readSettings(process.env).providerRetries, () => readSessionProject())`, and in `session_start` call `setSessionRoot(findProjectRoot(ctx.cwd))` before anything that can send a request (first line after `currentModel = ctx.model`). Do **not** add the project to `providerConfig.headers` (`src/index.ts:189`).

- [ ] **Step 4: Run to verify they pass** — `npx vitest run tests/lunaroute.test.ts` → PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lunaroute.ts src/index.ts tests/lunaroute.test.ts
git commit -m "feat(ga6g): project header on model requests, session root capture"
```

---

### Task 4: `/lunaroute project` command

**Files:**
- Modify: `src/settings-ui.ts` (`registerLunarouteSettingsCommand` handler + new `runProjectCommand`), `README.md`
- Test: `tests/settings-ui.test.ts`

**Interfaces:**
- Consumes: `findProjectRoot`, `projectFilePath`, `readProject`, `writeProject`, `clearProject`, `validateProjectName`, `PROJECT_FILE`.
- Produces: `export async function runProjectCommand(ctx: { cwd: string; hasUI: boolean; ui: Pick<ExtensionUIContext, "notify" | "select" | "input"> }, arg: string, io?: ProjectIo): Promise<void>`.

- [ ] **Step 1: Write the failing tests**

```ts
test("/lunaroute project <name> writes and reports the path", async () => { /* notify contains ".lunaroute.json" */ });
test("/lunaroute project <bad> refuses and writes nothing", async () => { /* notify "warning", writeFileSync not called */ });
test("bare project offers the folder name and writes the pick", async () => {
  // select called with ["lunaroute-pi-extension", "Enter another name…"] (no current value)
  // select → "lunaroute-pi-extension" ⇒ file written with that name
});
test("bare project lets the user type another name", async () => { /* select → "Enter another name…", input → "billing" ⇒ file has billing */ });
test("bare project cancel writes nothing", async () => { /* select → undefined ⇒ no write, no notify error */ });
test("bare project without a UI only reports", async () => { /* hasUI false ⇒ notify, select not called */ });
test("project clear removes the key", async () => { /* file becomes {} */ });
```

- [ ] **Step 2: Run to verify they fail** — `npx vitest run tests/settings-ui.test.ts -t "project"` → FAIL.

- [ ] **Step 3: Implement**

Handler: `if (sub === "project" || sub.startsWith("project ")) { await runProjectCommand(ctx, sub.slice("project".length).trim()); return; }` placed with the other subcommands; extend the unknown-option message to `… settings, models-refresh, usage or project`. `runProjectCommand`: resolve `root = findProjectRoot(ctx.cwd)`; `clear`/`off` (case-insensitive) → `clearProject` + notify; any other argument → `validateProjectName` then `writeProject`, notify the absolute file path, on invalid notify `reason` as `"warning"` and write nothing; empty argument → notify the effective value and source path, then with `ctx.hasUI` `select("Project for this repo", [current?, basename(root), "Enter another name…"])`, `input("Project name")` for the last option, write the chosen value, and on any `undefined` return silently. Wrap write failures in try/catch → `notify(err.message, "error")`. README: one line under the `/lunaroute usage` docs.

- [ ] **Step 4: Run to verify they pass** — `npx vitest run tests/settings-ui.test.ts` → PASS.

- [ ] **Step 5: Commit**

```bash
git add src/settings-ui.ts tests/settings-ui.test.ts README.md
git commit -m "feat(ga6g): /lunaroute project command with folder-name suggestion"
```

---

### Task 5: Full verification

- [ ] **Step 1:** `npm run check` → typecheck clean, all vitest files pass.
- [ ] **Step 2:** Smoke the real thing from this worktree:

```bash
echo '{"project":"ga6g-smoke"}' > .lunaroute.json
pi -e ./src/index.ts -p "reply with ok" --no-tools
rm .lunaroute.json
```

Then check the LunaRoute dashboard usage view for a `ga6g-smoke` row (the acceptance step). If the dashboard is not available, say so plainly in the kata comment instead of claiming verification.
- [ ] **Step 3:** `git status` clean; stamp the kata (`work.attention ok`) and leave the branch for review.
