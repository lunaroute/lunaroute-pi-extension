# Smoke Checklist: @lunaroute/pi-extension (Pi)

**Status: headless items verified 2026-10-22 against production with the
stored `lr_` credential from `~/.pi/agent/auth.json`; manual/TTY items below
remain pending and must be run before the next release.**

Run against production before every release. No environment setup is needed:
the extension's baked-in defaults point at the production services
(`gw.lunaroute.com`, `api.lunaroute.com`, `app.lunaroute.com`,
`mcp.lunaroute.com`; see `src/lunaroute.ts`). There is no staging
environment; every item below is runnable against production or a local Pi
profile, and anything that could not be run that way has been deleted rather
than left pending.

The release commit carries a `smoke: <date> <all-pass|exceptions>` line
naming the result of this checklist; `all-pass` claims every item below was
run and its expected observation held (see *Release record* for the exact
contract), so no item here can be aspirational.

Where to look while running the items:

- **Gateway logs** (production, via the server's log access): the
  attribution triple, `lunaroute-agent: pi/<version>`, `x-lunaroute-session`,
  and `lunaroute-session-id` (built in `src/lunaroute.ts`
  `buildAttributionHeaders`), plus `Authorization: Bearer lr_...` on model
  requests.
- **Hosted MCP server logs**: `LUNAROUTE-API-KEY` header plus the attribution
  headers on `tools/list` and `tools/call` requests.
- **Local profile files** (all under the agent dir; `PI_CODING_AGENT_DIR`
  overrides it for an isolated profile): `auth.json` (stored credential),
  `lunaroute.json` (settings toggles), `models-store.json` (persisted
  catalog), `lunaroute-images/` (generated images), `lunaroute-docs/`
  (oversized conversions).

## Verified headless (2026-10-22)

- [x] **Gateway catalog**: `curl -sS -H "Authorization: Bearer <key>"
  https://gw.lunaroute.com/v1/models` with the stored credential returns 69
  entries; every chat-capable entry carries `context_window` and
  `max_output_tokens`; `glm-5.3-flash` (the post-login auto-pick) is present.
  The non-chat entries are rejected by design: `whisper-large-v3` by the
  `transcription` capability tag, the `meta-muse/*` entries by the
  missing-window-metadata guard, `clef-flash`/`djev` diverted to classifier
  registration via `systemone`.
- [x] **Hosted MCP catalog**: `POST https://mcp.lunaroute.com/mcp` with
  `LUNAROUTE-API-KEY` + attribution headers, method `tools/list` →
  `generate_image`, `edit_image`, `upload_image`, `convert_document`,
  `web_search` (plus `transcribe_audio`, which this extension does not
  consume). The list is org-policy-shaped: a key without image entitlement
  returns a shorter list, and that is a valid outcome, not an error.
- [x] **`web_search` executes**: `tools/call` with
  `{"query": "...", "count": 1}` returns normalized results
  (`provider`, `query`, `results[]` with `title`/`url`/`snippet`).
- [x] **Unit + config suites**: `npm run check` green (typecheck, vitest,
  `node --test scripts/*.node-test.mjs`).
- [x] **Tarball list**: `node scripts/pack-assert.mjs` passes: the tarball
  contains exactly the tracked `src/**/*.ts` plus `package.json`, `README.md`,
  `LICENSE`, nothing else.

## Pending (need a TTY / browser / logged-in session; run before the next release)

All manual items run from the worktree: `pi -e .` loads the working tree.
For an isolated profile use `PI_CODING_AGENT_DIR=$(mktemp -d)` (honored by the
host for config storage and by the extension for its files).

- [ ] **Fresh keyless profile**: `PI_CODING_AGENT_DIR=$(mktemp -d) pi -e .` →
  first-run hint `Run /login lunaroute to start using LunaRoute.`; no
  LunaRoute tools registered; no error.
- [ ] **Browser login roundtrip**: `/login lunaroute` → *Log in with browser*
  → approve at `app.lunaroute.com/device-auth/pi` → the browser shows
  "LunaRoute authorized."; an `lr_` credential appears in the profile's
  `auth.json`; the auto-pick message `LunaRoute: set <model> as default model
  (change with /model)` names the flash tier, not the flagship.
- [ ] **Paste login**: `/login lunaroute` → *Paste an API key* → paste an
  `lr_...` key → models refresh; same observations as the browser path.
- [ ] **Model list + live refresh**: `/model` lists `lunaroute/*` models with
  context windows; `/lunaroute models-refresh` re-pulls the catalog without
  restarting Pi (a network failure is reported as an error and the last
  catalog stays in use).
- [ ] **Chat request + attribution**: send any prompt on a `lunaroute/*`
  model; the gateway logs show `Authorization: Bearer lr_...` plus the
  attribution triple on the request.
- [ ] **First-class tools end-to-end**: `/tools` lists `generate_image`,
  `edit_image`, `upload_image`, `convert_document`, `web_search`; generate a
  small image → a file named `img_<id>.<format>` lands in
  `<agentDir>/lunaroute-images/` and the tool result reports the absolute
  path; convert a local `.docx` with `convert_document` → Markdown returns.
- [ ] **Settings toggles**: `/lunaroute` → *Settings* → toggle *Image tools*
  off → the tool disappears immediately and `lunaroute.json` records
  `"imageTools": "off"`; toggle on → restored without a restart. Spot-check
  one other family and the *MCP tools* master switch the same way.
- [ ] **Usage command**: `/lunaroute usage` prints the usage report. As of
  2026-10-22 the server does not offer `get_usage`, so expect the session
  measurement fallback rather than the plan snapshot.
- [ ] **Classifier registration (Pi >= 0.99.0)**: after login or
  `/lunaroute models-refresh`, the profile's `models-store.json`
  `lunaroute.models` contains `clef-flash` and `djev` with
  `"type": "classifier"` / `"api": "typesafe-system-one"`, and neither appears
  in `/model`:
  `python3 -c "import json;print([m for m in json.load(open('$PI_CODING_AGENT_DIR/models-store.json'))['lunaroute']['models'] if m.get('type')=='classifier'])"`
- [ ] **Adapter migration notice** (only if `pi-mcp-adapter` is installed):
  `pi install npm:pi-mcp-adapter` → start a logged-in session → the one-time
  notice `LunaRoute no longer uses pi-mcp-adapter...` appears once →
  `pi remove npm:pi-mcp-adapter`.
- [ ] **Published package**: after `npm publish` completes,
  `PI_CODING_AGENT_DIR=$(mktemp -d) pi install
  npm:@lunaroute/pi-extension@<version>` → `/login lunaroute` → models appear
  and the tool families register (post-publish check; the tarball itself is
  covered by `pack-assert` above).

## Per-Pi-bump regression (cheap)

The extension compiles against the 0.84.1 floor but rides hosts far newer
(image resize >= 0.87, classifier models >= 0.99.0). On every Pi release that
will be in common use:

- [ ] `pi -e .` loads without an error; `/model` lists `lunaroute/*` models.
- [ ] One chat request reaches the gateway with `Authorization` + attribution
  headers; `models-store.json` classifier entries still round-trip on a
  >= 0.99 host (and stay absent below it).

## Release record (machine-checked)

The release commit (the commit the `v*` tag points at) must carry a line:

```
smoke: <YYYY-MM-DD> <all-pass|exceptions>[ note...]
```

`all-pass` attests that every checklist item above was run against production
(or an isolated local profile, where the item says so) on or shortly before
the date in the line, and every expected observation held; `exceptions` must
be followed by a short note naming each item left open and why. The publish
workflow enforces the line's presence and shape via `scripts/release-tag.mjs`
before `npm publish` runs; a tag whose commit lacks a valid smoke line fails
the release. Enforcement begins with the first release tagged after
2026-10-22 (v0.18.1, the release that ships this gate).
