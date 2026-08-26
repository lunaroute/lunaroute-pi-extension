import { VERSION, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  LUNAROUTE_PROVIDER,
  buildAttributionHeaders,
  firstRunHint,
  generateSessionId,
  resolveRoutingUrl,
} from "./lunaroute.js";
import { lunarouteOAuth } from "./login.js";
import { createRefreshModels } from "./discovery.js";
import { disposeLunarouteMcp, maybeShowAdapterHint, registerLunarouteMcp } from "./mcp.js";

export default function lunarouteExtension(pi: ExtensionAPI): void {
  const sessionId = generateSessionId();
  const mcpDeps = { env: process.env, version: VERSION, sessionId };

  pi.registerProvider(LUNAROUTE_PROVIDER, {
    name: "LunaRoute",
    baseUrl: resolveRoutingUrl(process.env),
    api: "openai-completions",
    authHeader: true,
    headers: buildAttributionHeaders(VERSION, sessionId),
    // Re-register on login so a rotated key takes effect without restarting
    // Pi: dispose first (the adapter throws on a duplicate server name), then
    // register with the freshly obtained key — no getApiKeyForProvider race.
    // MCP is optional: a registration failure never fails the login.
    oauth: {
      ...lunarouteOAuth,
      async login(callbacks) {
        const creds = await lunarouteOAuth.login(callbacks);
        await disposeLunarouteMcp();
        const { error } = registerLunarouteMcp(pi, creds.access, mcpDeps);
        if (error) console.warn(`LunaRoute MCP re-register failed: ${error.message}`);
        return creds;
      },
    },
    refreshModels: createRefreshModels(process.env),
    models: [],
  });

  pi.on("session_start", async (_event, ctx) => {
    if (ctx.hasUI) {
      const status = ctx.modelRegistry.getProviderAuthStatus(LUNAROUTE_PROVIDER);
      if (!status?.configured) {
        ctx.ui.notify(firstRunHint(), "info");
      }
    }
    const key = await ctx.modelRegistry.getApiKeyForProvider(LUNAROUTE_PROVIDER);
    if (!key) return; // not logged in — silent, no MCP registration
    const { registered, error } = registerLunarouteMcp(pi, key, mcpDeps);
    if (error && ctx.hasUI) {
      ctx.ui.notify(`LunaRoute MCP registration failed: ${error.message}`, "warning");
    } else if (!registered && ctx.hasUI) {
      maybeShowAdapterHint(ctx.ui);
    }
  });

  pi.on("session_shutdown", async () => {
    await disposeLunarouteMcp();
  });
}
