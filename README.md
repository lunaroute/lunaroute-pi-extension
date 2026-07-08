# LunaRoute for Pi

Make Pi easy to recognize, route, and troubleshoot when it talks to LunaRoute.

This Pi extension adds LunaRoute-friendly request attribution and session headers to your Pi traffic. If you use Pi with a LunaRoute provider, this helps LunaRoute understand that requests are coming from Pi, which Pi version is being used, and which requests belong to the same Pi session.

## Why install it?

Without this extension, Pi may look like a generic OpenAI SDK client when it calls LunaRoute. With this extension, LunaRoute receives clear client signals:

- **Better attribution** — LunaRoute can identify requests as `pi/<version>` instead of only seeing the underlying SDK.
- **Stable session routing** — all requests in one Pi runtime share a generated session ID for LunaRoute affinity/routing features.
- **Cleaner diagnostics** — logs, usage analysis, and future LunaRoute features can distinguish Pi traffic from other clients.
- **No secret handling** — the extension may check whether auth is configured, but it does not print, log, display, or store API key values.

## What it sends

For the Pi provider named exactly `lunaroute`, the extension adds:

```http
lunaroute-agent: pi/<pi-version>
x-lunaroute-session: <session-uuid>
lunaroute-session-id: <session-uuid>
```

The same generated session UUID is used for both session headers during one extension runtime.

## What it does not do

- It does **not** change `User-Agent`.
- It does **not** target `lunaroute11111` or any other test provider.
- It does **not** target generic OpenAI-compatible providers.
- It does **not** create, fetch, or modify your LunaRoute model list.
- It does **not** print, log, display, or store API key values.

## Quick start

Install dependencies for local development or local loading:

```bash
npm install
npm run check
pi -e .
```

For normal use after publishing:

```bash
pi install npm:@lunaroute/pi-extension
```

Or from a git source:

```bash
pi install git:github.com/lunaroute/lunaroute-pi-extension
```

## Configure LunaRoute in Pi

You need a Pi provider named exactly `lunaroute`, usually in `~/.pi/agent/models.json`.

Example:

```json
{
  "providers": {
    "lunaroute": {
      "baseUrl": "https://gw.lunaroute.com/v1",
      "api": "openai-completions",
      "apiKey": "$LUNAROUTE_API_KEY",
      "models": [
        {
          "id": "glm-5.2",
          "input": ["text"],
          "contextWindow": 1048576,
          "reasoning": true,
          "thinkingLevelMap": {
            "off": null,
            "minimal": "high",
            "low": "high",
            "medium": "high",
            "high": "high",
            "xhigh": "max"
          },
          "compat": {
            "thinkingFormat": "zai",
            "maxTokensField": "max_tokens",
            "supportsReasoningEffort": false
          }
        }
      ]
    }
  }
}
```

## API key setup

Preferred setup:

```bash
export LUNAROUTE_API_KEY=lr_...
```

Then reference it from `~/.pi/agent/models.json`:

```json
"apiKey": "$LUNAROUTE_API_KEY"
```

You can also store a Pi credential for provider `lunaroute`.

Important: this extension standardizes LunaRoute auth to either Pi stored auth or `LUNAROUTE_API_KEY`. Arbitrary existing direct `apiKey` values in the `lunaroute` `models.json` provider config are not preserved by the extension override.

## Helpful startup warnings

The extension shows non-blocking warnings when:

- no provider named `lunaroute` is configured, or
- provider `lunaroute` exists but neither `LUNAROUTE_API_KEY` nor Pi provider auth appears configured.

Warnings are informational only. They do not block Pi startup or requests.

## Who is this for?

Install this if you:

- use Pi with LunaRoute as a model provider,
- want LunaRoute dashboards/logs to distinguish Pi traffic,
- want LunaRoute to keep a Pi runtime’s requests grouped by session, or
- are testing LunaRoute routing/attribution features from Pi.

You probably do not need this if you do not use LunaRoute from Pi.

## Development

```bash
npm install
npm run check
pi -e .
```

Package dry run:

```bash
npm pack --dry-run
```

## License

MIT License. See [LICENSE](./LICENSE).
