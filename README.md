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

When you are logged in, the extension auto-registers the hosted LunaRoute MCP
server (`https://mcp.lunaroute.com/mcp`) with
[pi-mcp-adapter](https://github.com/nicobailon/pi-mcp-adapter), so LunaRoute
tools (in v1: `generate_image`) become callable from Pi. The registration is
in-memory only and never written to any `mcp.json` — it lives for the Pi
process and is disposed when the session ends. Your `lr_` key is never
persisted to any MCP config.

- **Requires pi-mcp-adapter.** Tools surface through the adapter's `mcp()`
  proxy tool, not as first-class Pi tools. Install it with
  `pi install npm:pi-mcp-adapter`. It is declared as an *optional* peer
  dependency (`>=2.28.0`) — metadata only: installing the extension never
  pulls the adapter in, and everything degrades gracefully without it.
- **Logged out**: no registration occurs (silent). Log in with
  `/login lunaroute`.
- **Logged in but adapter not installed**: you get a one-time install hint
  (`pi install npm:pi-mcp-adapter`) when you log in and again at the next
  session start — once per Pi process, never nagging.
- **After `/login lunaroute`** with a rotated key: the prior registration is
  disposed and re-registered with the new key, so rotation takes effect
  without restarting Pi.
- Org/user/tool policy is enforced server-side and shapes `tools/list` — an
  empty tool list is a valid outcome, not an error.
- **Already configured LunaRoute MCP yourself?** Your config wins. The
  extension detects a `lunaroute` server (or any server pointing at the
  hosted LunaRoute MCP URL) in your MCP config and skips its own
  registration — no duplicate tools, no warnings, just a one-time notice.
  Note your config's key is static: `/login lunaroute` rotation won't update
  it, so edit the config yourself when you rotate.
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

## Configuration

The gateway, API, and front URLs default to production and are overridable
for dev/staging via environment variables before starting Pi:

| Variable | Default | Purpose |
|---|---|---|
| `LUNAROUTE_ROUTING_URL` | `https://gw.lunaroute.com/v1` | Gateway base URL (provider `baseUrl` + `/models`) |
| `LUNAROUTE_API_URL` | `https://api.lunaroute.com` | API host for `/v1/auth/exchange` |
| `LUNAROUTE_FRONT_URL` | `https://app.lunaroute.com` | Web app host for `/device-auth/pi` browser login |
| `LUNAROUTE_MCP_URL` | `https://mcp.lunaroute.com/mcp` | Hosted MCP server URL registered with pi-mcp-adapter |

## Troubleshooting

- **No models appear after login**: the gateway may be unreachable, or the key
  may be stale. Re-run `/login lunaroute`.
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
6. With pi-mcp-adapter installed, `/login lunaroute`, then `/mcp` should list
   the `lunaroute` server; call `generate_image` end-to-end.
7. Without pi-mcp-adapter, logged in, confirm the one-time
   `pi install npm:pi-mcp-adapter` hint; logged out, confirm silence.
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
