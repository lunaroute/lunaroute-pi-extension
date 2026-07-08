# LunaRoute Pi Extension

Pi extension for LunaRoute request attribution and session affinity.

## What it does

When loaded in Pi, this extension targets only the provider named `lunaroute` and adds these headers to provider requests:

```http
lunaroute-agent: pi/<pi-version>
x-lunaroute-session: <session-uuid>
lunaroute-session-id: <session-uuid>
```

The same generated session UUID is used for both session headers during one extension runtime.

## What it does not do

- It does not change `User-Agent`.
- It does not target `lunaroute11111` or any other test provider.
- It does not create or discover LunaRoute models.
- It may check whether API key configuration exists, but it does not print, log, display, or store API key values.

## Requirements

Configure a Pi provider named exactly `lunaroute`, usually in `~/.pi/agent/models.json`.

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

Preferred environment-variable setup:

```bash
export LUNAROUTE_API_KEY=lr_...
```

Then reference it from `~/.pi/agent/models.json`:

```json
"apiKey": "$LUNAROUTE_API_KEY"
```

Alternatively, store a Pi credential for provider `lunaroute`. V1 standardizes request auth to Pi stored auth or `LUNAROUTE_API_KEY`; arbitrary existing direct `apiKey` values in the `lunaroute` `models.json` provider config are not preserved by the extension override.

## Warnings

On session start, the extension shows non-blocking warnings when:

- no provider named `lunaroute` is configured, or
- provider `lunaroute` exists but neither `LUNAROUTE_API_KEY` nor Pi provider auth appears configured.

Warnings do not block Pi startup or requests.

## Local development

```bash
npm install
npm run check
pi -e .
```

## Private publishing

This package is intended to be publishable as a closed/private npm package.

Use restricted scoped npm publishing:

```bash
npm publish --access restricted
```

Do not set `"private": true` if publishing to npm; that flag prevents publishing.
