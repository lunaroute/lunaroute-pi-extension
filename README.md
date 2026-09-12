# LunaRoute for Pi

Use LunaRoute from [Pi](https://github.com/nicobailon/pi) in under a minute: log
in, and every LunaRoute model shows up automatically — correctly configured and
ready to use. No hand-editing model files, no copying API keys around. The
hosted LunaRoute MCP server (image generation and more) is wired up for you too.

## Why

- **Zero-config models.** LunaRoute's model catalog is synced into Pi
  automatically — context windows, token limits, reasoning, and vision
  capabilities all come through pre-mapped. Run `/model` and pick a
  `lunaroute/*` model. Re-fetched on every refresh, so new models appear as
  soon as they ship.
- **First-class web search.** When no other extension provides web search,
  a real `web_search` Pi tool is registered, backed by the hosted LunaRoute
  MCP server — collapsed rows, expandable sources, parallel calls. A
  `web_fetch` companion lights up automatically once the server offers one.
- **Login that doesn't leak keys.** Browser-based login (PKCE) issues a fresh
  `lr_` key and stores it in `~/.pi/agent/auth.json` — never in a models file.
  Prefer a key you already have? Paste it.
- **LunaRoute MCP built in.** When you're logged in, the hosted LunaRoute MCP
  server is auto-registered so tools like `generate_image` are callable from Pi.
  Nothing is written to your MCP config; registration lives only for the Pi
  process.
- **Attribution on every request.** Each LunaRoute request carries a per-session
  agent + session id so traffic is traceable on the LunaRoute side.

## Requirements

- Mainline pi (`@earendil-works/pi-coding-agent`) **>= 0.84.1** — the supported
  host. The version floor and the support guarantee below apply to mainline pi.
- A LunaRoute account with access to at least one organization.

**Host compatibility:** the [omp](https://github.com/can1357/oh-my-pi) fork is
best-effort and not integration-tested on a real omp host: login and startup
no longer crash on it, but (a) the raw-API-key paste option is mainline-only —
omp logins use the browser flow; and (b) omp does not refresh the model
catalog live — an omp-only install has an empty model list until the store is
populated by running `/login lunaroute` once on mainline pi on the same
machine. Report omp-specific issues at
<https://github.com/lunaroute/lunaroute-pi-extension/issues>.

## Quick start

```bash
pi install npm:@lunaroute/pi-extension
```

Then in Pi:

```
/login lunaroute
```

Choose **Log in with browser** (a browser opens to LunaRoute; after you
approve, an API key is issued and stored) or **Paste an API key** (paste an
existing `lr_...` key). After login, the first `lunaroute/*` model is selected
for you and remembered across restarts — run `/model` only if you want to pick a
different one.

## LunaRoute MCP tools

When you are logged in, the extension registers first-class Pi tools backed by
the hosted LunaRoute MCP server (`https://mcp.lunaroute.com/mcp`) over a
direct Streamable HTTP connection — no MCP adapter extension involved:

- `web_search` / `web_fetch` (when no other extension already provides them)
- `generate_image` / `edit_image` / `upload_image`
- `convert_document`

Your `lr_` key is sent per request and never persisted to any MCP config.

- **Logged out**: no registration occurs (silent). Log in with
  `/login lunaroute`.
- **After `/login lunaroute`** with a rotated key: the tools' shared client is
  swapped to the fresh key, so rotation takes effect without restarting Pi.
- Org/user/tool policy is enforced server-side and shapes `tools/list` — an
  empty tool list is a valid outcome, not an error.
- The **MCP tools** toggle in `/lunaroute` is the master switch for every
  MCP-backed tool family; each family below has its own toggle too.
- **Coming from an older release?** The extension no longer uses
  [pi-mcp-adapter](https://github.com/nicobailon/pi-mcp-adapter). Remove it
  with `pi remove npm:pi-mcp-adapter` unless you use it for other MCP
  servers. (One-time session notice when it is still installed.)
- Overriding `LUNAROUTE_MCP_URL` sends your `lr_` key to that endpoint; prefer
  HTTPS in production (HTTP is intended only for local development).

## Web tools

When you are logged in and **no other extension already provides web
search**, the extension registers a first-class `web_search` Pi tool that
calls the hosted LunaRoute MCP server directly (Streamable HTTP) with your
`lr_` key and the usual attribution headers — no `pi-mcp-adapter` install
required.

- **Detect-and-backfill.** At `session_start` the extension checks every
  registered tool (built-ins, other extensions, adapter-prefixed names such
  as `lunaroute_web_search`). If a web search tool already exists — e.g.
  from pi-web-access or pi-web-search — LunaRoute stays silent: pi resolves
  cross-extension tool-name conflicts first-registration-wins, so a
  duplicate registration would be a silent no-op anyway.
- **Server-gated.** The tool set is registered only for capabilities the
  hosted MCP server actually offers (`tools/list` is consulted once).
  As of v0.5.0 the server exposes `web_search`
  (`{ query, count?, provider? }` → normalized results); `web_fetch` will
  register automatically once the server ships it.
- **Parallel by default.** Pi executes sibling tool calls concurrently — the
  tool description nudges the model to batch multiple `web_search` calls in
  one message. Output is truncated per pi's tool rules (50 KB / 2000 lines)
  and oversized results are spilled to a temp file the model can read.
- **Rendering.** Collapsed one-line summaries (`✓ 5 results · brave`),
  expandable to the full result list (title / URL / snippet), spinner while
  searching. Headless modes skip rendering; the text content still reaches
  the model.
- **Kill switch.** Set `LUNAROUTE_WEB_TOOLS=off` to disable. Tool-name
  overrides: `LUNAROUTE_MCP_WEB_SEARCH_TOOL`,
  `LUNAROUTE_MCP_WEB_FETCH_TOOL`.
- Logged out: no tools are registered (silent), mirroring MCP registration.

If both this extension and another web-search extension are active, pi's
first-wins rule decides who owns the plain `web_search` name; use
`--exclude-tools` if you need to pick manually.

## Image tools

When you are logged in, the extension registers first-class
`generate_image`, `edit_image`, and `upload_image` Pi tools backed by the
hosted LunaRoute MCP server — the same direct Streamable HTTP transport as
the web tools, no `pi-mcp-adapter` install required.

- **No local detection.** Unlike `web_search`, these names are
  LunaRoute-specific: the extension registers whatever the hosted server
  offers for your org (`tools/list` gates entitlement, policy, and the
  image kill switch server-side).
- **Files on disk.** Generated and edited images are saved to a per-
  installation folder — `<agentDir>/lunaroute-images/` (default
  `~/.pi/agent/lunaroute-images/`) — named `img_<id>.<format>`. The tool
  result tells the model the absolute path, the `img_…` id (for later
  `edit_image` calls), and the time-limited URL. Relocate the folder with
  `LUNAROUTE_IMAGE_DIR`.
- **Model awareness.** The per-org model enum and each model's limits
  (default size, step range, formats) are baked into the tool schema from
  `tools/list`, so the model picks valid parameters instead of guessing.
- **Uploads.** `upload_image` takes a local `path` (the extension does the
  base64) or a `url`; the server sniffs the codec. Files over the 11 MiB
  server ceiling are rejected before upload. The returned `img_…` id feeds
  `edit_image`'s `image_ids`.
- **Kill switch.** `/lunaroute` → *Image tools* toggle, or
  `LUNAROUTE_IMAGE_TOOLS=off`. Logged out: nothing registers (silent).

## Convert tools

When you are logged in, the extension registers a first-class
`convert_document` Pi tool backed by the hosted LunaRoute MCP server —
documents (Word, PowerPoint, Excel, OpenDocument, RTF, EPUB, CSV, PDF) and
raster images (OCR'd) become Markdown the model can work with.

- **Inputs.** A local `path` (the extension reads and base64s it) or an
  http(s) `url`; `filename` is derived from the path and can be set
  explicitly (required for CSV); `ocr: true` runs the configured OCR
  backend on scanned PDFs (the server answers `needs_ocr` when a scan
  requires it — retry with `ocr: true`).
- **Format guard.** Binary formats are magic-sniffed locally (ZIP-family,
  PDF, RTF, images) and text must be valid UTF-8 — unrecognized input is
  rejected before any bytes leave the machine.
- **Output.** Markdown comes back inline (truncated per pi's tool rules,
  spilled to a temp `.md` for big documents). When the server reports
  `output_too_large`, the tool automatically retries with the
  stored-artifact path and saves the full markdown to a per-installation
  folder — `LUNAROUTE_DOCS_DIR` (default `<agentDir>/lunaroute-docs`) —
  returning the path and a head. Note: with the server's stock size caps
  this fallback only succeeds on deployments that raise
  `MCP_DOC_MAX_OUTPUT_BYTES` above the embed cap; otherwise the error is
  surfaced cleanly.
- **Kill switch.** `/lunaroute` → *Convert tools* toggle, or
  `LUNAROUTE_CONVERT_TOOLS=off`.

## Settings

Run `/lunaroute` in Pi to open the settings UI (interactive mode):

- **MCP tools** — on/off. Off skips the hosted LunaRoute MCP registration
  (a server you configured yourself is always left alone).
- **Web search tools** — on/off. Off removes `web_search` / `web_fetch`
  immediately; on restores them without a restart.
- **Search provider** — server / brave / exa / kagi. The default provider
  used for every `web_search`; the model can still override it per call.
- **Image tools** — on/off. Off removes `generate_image` / `edit_image` /
  `upload_image` immediately; on restores them without a restart.
- **Convert tools** — on/off. Off removes `convert_document` immediately;
  on restores it without a restart (revalidating the server catalog).

Settings persist in `~/.pi/agent/lunaroute.json`:

```json
{ "mcp": "on", "webTools": "on", "searchProvider": "server", "imageTools": "on", "convertTools": "on" }
```

Missing keys fall back to these defaults (which equal the pre-settings
behavior), and invalid values are ignored per key. Outside interactive mode,
edit the file directly. The `LUNAROUTE_WEB_TOOLS` environment variable (see
below) still wins over the file.

## Configuration

The gateway, API, and front URLs default to production and are overridable
for dev/staging via environment variables before starting Pi:

| Variable | Default | Purpose |
|---|---|---|
| `LUNAROUTE_ROUTING_URL` | `https://gw.lunaroute.com/v1` | Gateway base URL (provider `baseUrl` + `/models`) |
| `LUNAROUTE_API_URL` | `https://api.lunaroute.com` | API host for `/v1/auth/exchange` |
| `LUNAROUTE_FRONT_URL` | `https://app.lunaroute.com` | Web app host for `/device-auth/pi` browser login |
| `LUNAROUTE_MCP_URL` | `https://mcp.lunaroute.com/mcp` | Hosted MCP server URL behind the first-class MCP-backed tools |
| `LUNAROUTE_IMAGE_DIR` | `<agentDir>/lunaroute-images` | Where generated/edited images are saved (kata e30g) |
| `LUNAROUTE_IMAGE_TOOLS` | *(unset)* | Set to `off`/`0`/`false` to disable the first-class image tools |
| `LUNAROUTE_DOCS_DIR` | `<agentDir>/lunaroute-docs` | Where oversized converted documents are saved (kata zpzt) |
| `LUNAROUTE_CONVERT_TOOLS` | *(unset)* | Set to `off`/`0`/`false` to disable the first-class convert_document tool |

## Troubleshooting

- **No models appear after login**: the gateway may be unreachable, or the key
  may be stale. Re-run `/login lunaroute`. A model the gateway lists without a
  context window is skipped rather than shown with a zero window.
- **Requests fail with 401**: the stored key was rotated or revoked. Pi warns
  once per session; run `/login lunaroute` to store a new one.
- **First-run hint**: if you have not logged in, `session_start` shows
  `Run /login lunaroute to start using LunaRoute.`

## Development

```bash
npm install
npm run check
pi -e .
```

Manual smoke test:

1. Run `pi -e .`, then `/login lunaroute`, pick browser, complete the flow.
2. Confirm a model appears in `/model`.
3. Send a request; confirm LunaRoute receives the attribution headers.
4. Repeat with the paste path.
5. On a fresh profile with no key, confirm the first-run hint appears and no
   error is thrown.
6. Logged in, confirm the first-class LunaRoute tools appear (`/tools`) and
   `generate_image` works end-to-end.
7. With pi-mcp-adapter still installed, confirm the one-time migration notice
   at session start; logged out, confirm silence.
8. Web tools: logged in with no other web-search extension installed, ask
   the agent to search the web — the `web_search` tool should appear in the
   tool list, run, and render collapsed with expandable sources. With
   pi-web-access installed, confirm LunaRoute registers nothing
   (`pi.getAllTools()` shows the other extension's `web_search`).

Package dry run:

```bash
npm pack --dry-run
```

## License

MIT License. See [LICENSE](./LICENSE).
