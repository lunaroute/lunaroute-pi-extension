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

- Pi **>= 0.84.1**.
- A LunaRoute account with access to at least one organization.

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
  `pi install npm:pi-mcp-adapter`.
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
- Overriding `LUNAROUTE_MCP_URL` sends your `lr_` key to that endpoint; prefer
  HTTPS in production (HTTP is intended only for local development).

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

Package dry run:

```bash
npm pack --dry-run
```

## License

MIT License. See [LICENSE](./LICENSE).
