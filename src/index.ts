import { VERSION, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";
import {
  LUNAROUTE_API,
  LUNAROUTE_PROVIDER,
  buildAttributionHeaders,
  firstRunHint,
  generateSessionId,
  readPersistedModels,
  resolveRoutingUrl,
  toStoredModel,
} from "./lunaroute.js";
import { lunarouteOAuth } from "./login.js";
import { createRefreshModels } from "./discovery.js";
import { disposeLunarouteMcp, maybeShowAdapterHint, registerLunarouteMcp } from "./mcp.js";

export default function lunarouteExtension(pi: ExtensionAPI): void {
  const sessionId = generateSessionId();
  const mcpDeps = { env: process.env, version: VERSION, sessionId };
  // Tracks the session's current model so the post-login refresh can tell
  // whether the user already has a model (don't override) or has none yet.
  let currentModel: Model<Api> | undefined;

  pi.registerProvider(LUNAROUTE_PROVIDER, {
    name: "LunaRoute",
    baseUrl: resolveRoutingUrl(process.env),
    api: LUNAROUTE_API,
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
        const { registered, error } = registerLunarouteMcp(pi, creds.access, mcpDeps);
        if (error) console.warn(`LunaRoute MCP re-register failed: ${error.message}`);
        else if (!registered) maybeShowAdapterHint({ notify: (m) => callbacks.onProgress?.(m) });
        return creds;
      },
    },
    refreshModels: createRefreshModels(process.env, {
      // After a successful network refresh, if the user has no model selected
      // (first /login lunaroute, before any default is saved), auto-pick the
      // first LunaRoute model so they don't have to run /model manually.
      // setModel also saves it as the default, which persist+restore then
      // remembers on every later launch. The one-time "no default model is
      // configured for provider 'lunaroute'" notice Pi shows before this
      // refresh runs is a core limitation (its defaultModelPerProvider map is
      // static and not extensible for dynamic providers).
      onCatalogRefreshed: (models) => {
        if (!models.length) return;
        const noModel = !currentModel || (currentModel.provider === "unknown" && currentModel.id === "unknown");
        if (!noModel) return;
        void pi.setModel(toStoredModel(models[0], resolveRoutingUrl(process.env))).catch(() => {});
      },
    }),
    models: readPersistedModels(process.env),
  });

  pi.on("session_start", async (_event, ctx) => {
    currentModel = ctx.model;
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

  pi.on("model_select", (event) => {
    currentModel = event.model;
  });

  pi.on("session_shutdown", async () => {
    await disposeLunarouteMcp();
  });
}
