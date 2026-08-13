# LunaRoute for Pi

A Pi extension that makes LunaRoute easy to use from Pi: log in, and your
LunaRoute models appear automatically with the right context window, max
tokens, reasoning, and reasoning-effort configuration. No `~/.pi/agent/models.json`
editing, and your API key is stored in `~/.pi/agent/auth.json` — never in any
models file.

## Requirements

- Pi **>= 0.84.1**.
- A LunaRoute account with access to at least one organization.
- A LunaRoute gateway that exposes the Pi compatibility block on `GET /v1/models`
  (LunaRoute server issue `vkd3` or later).

## Quick start

```bash
pi install npm:@lunaroute/pi-extension
```

Then in Pi:

```
/login lunaroute
```

Choose **Log in with browser** (a browser opens to LunaRoute; after you approve,
an API key is issued and stored) or **Paste an API key** (paste an existing
`lr_...` key). After login, run `/model` and pick a `lunaroute/*` model.

## What it does

- Registers a `lunaroute` provider with Pi.
- Offers browser-based login (PKCE + loopback) or pasting an API key. The
  `lr_` key is stored in `~/.pi/agent/auth.json` keyed by `lunaroute`.
- Syncs the model list from `GET {gateway}/v1/models` and maps each entry to a
  Pi model: `context_window` → `contextWindow`, `max_output_tokens` →
  `maxTokens`, `capabilities.reasoning` → `reasoning`, `capabilities.vision` →
  `input: ["text","image"]`, and the server-provided `pi` block
  (`thinkingLevelMap`, `compat`).
- Adds attribution headers to every LunaRoute request:
  ```http
  lunaroute-agent: pi/<pi-version>
  x-lunaroute-session: <session-uuid>
  lunaroute-session-id: <session-uuid>
  ```
  One session UUID per Pi runtime, shared by both session headers.

## What it does not do

- It does not write your API key or models to `~/.pi/agent/models.json`.
- It does not modify the HTTP `User-Agent` header.
- It does not target `lunaroute11111` or other test providers.
- It does not persist the model catalog across restarts (it re-fetches on
  refresh).

## Configuration

The gateway, API, and front URLs default to production and are overridable for
dev/staging via environment variables before starting Pi:

| Variable | Default | Purpose |
|---|---|---|
| `LUNAROUTE_ROUTING_URL` | `https://gw.lunaroute.com/v1` | Gateway base URL (provider `baseUrl` + `/models`) |
| `LUNAROUTE_API_URL` | `https://api.lunaroute.com` | API host for `/v1/auth/exchange` |
| `LUNAROUTE_FRONT_URL` | `https://app.lunaroute.com` | Web app host for `/pi-auth` browser login |

## Troubleshooting

- **No models appear after login**: the gateway may be unreachable, or the key
  may be stale. Re-run `/login lunaroute`. Reasoning models without a server
  `pi` block are skipped (requires LunaRoute server issue `vkd3`).
- **First-run hint**: if you have not logged in, `session_start` shows
  `Run /login lunaroute to start using LunaRoute.`

## Development

```bash
npm install
npm run check
pi -e .
```

Manual smoke test:

1. On Pi >= 0.84.1 against a `vkd3`-patched LunaRoute, run `pi -e .`.
2. `/login lunaroute`, pick browser, complete the flow.
3. Confirm a reasoning model (e.g. `glm-5.2`) appears in `/model`.
4. Send a request; confirm LunaRoute receives the three attribution headers.
5. Repeat with the paste path.
6. On a fresh profile with no key, confirm the first-run hint appears and no
   error is thrown.

Package dry run:

```bash
npm pack --dry-run
```

## License

MIT License. See [LICENSE](./LICENSE).
