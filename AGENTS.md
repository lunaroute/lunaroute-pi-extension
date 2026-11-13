# lunaroute-pi-extension

Pi extension for LunaRoute: `/login lunaroute` browser/paste login, live model
catalog sync, request attribution, and first-class tools (`web_search`,
`generate_image`, `convert_document`) backed by the hosted LunaRoute MCP
server. Source in `src/`, unit tests in `tests/` (vitest), CI-config tests in
`scripts/*.node-test.mjs` (node:test); `npm run check` runs typecheck plus both
suites, `pi -e .` runs the working tree locally.

## Releasing

Releases are tag-driven: a `v*` tag triggers `publish.yml`, which validates
release metadata before `npm publish`. Before tagging, run every item in
[docs/smoke-checklist.md](docs/smoke-checklist.md) against production; the
tagged commit must carry a `smoke: <YYYY-MM-DD> <all-pass|exceptions>` line
naming the checklist's result, and the publish gate fails without it.
