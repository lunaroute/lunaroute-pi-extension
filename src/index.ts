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
import { disposeLunarouteMcp, isAlreadyRegisteredError, isLunarouteMcpConfigured, maybeShowAdapterHint, maybeShowConfiguredNotice, registerLunarouteMcp } from "./mcp.js";
import { registerWebTools } from "./web-tools.js";
import { registerImageTools } from "./image-tools.js";
import { mcpEnabled, readSettings } from "./settings.js";
import { registerLunarouteSettingsCommand } from "./settings-ui.js";

export default function lunarouteExtension(pi: ExtensionAPI): void {
  const sessionId = generateSessionId();
  const mcpDeps = { env: process.env, version: VERSION, sessionId };
  // Tracks the session's current model so the post-login refresh can tell
  // whether the user already has a model (don't override) or has none yet.
  let currentModel: Model<Api> | undefined;
  // Latest session UI (kata 9v71): lets the auto-pick report what it selected
  // or why it failed. Headless hosts never set it — notifications just skip.
  let latestUi: { notify(message: string, type?: "info" | "warning" | "error"): void } | undefined;
  // Best-effort user notification from the refresh callback: info messages
  // are dropped without a UI; warnings fall back to console.warn. A host UI
  // quirk (omp hardening, kata npw2) must never break the refresh it rides on.
  const notifyUser = (message: string, type: "info" | "warning"): void => {
    try {
      if (latestUi) latestUi.notify(message, type);
      else if (type === "warning") console.warn(message);
    } catch {
      if (type === "warning") {
        try {
          console.warn(message);
        } catch {
          /* terminal unavailable — nothing left to do */
        }
      }
    }
  };

  registerLunarouteSettingsCommand(pi, mcpDeps);

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
        // User settings gate both surfaces (kata bjy9); read fresh — the
        // file may have changed since the factory ran.
        const settings = readSettings(process.env);
        if (!mcpEnabled(settings)) {
          // User turned MCP off (kata bjy9): skip re-registration but still
          // set up web tools below.
        } else if (await isLunarouteMcpConfigured(process.env)) {
          // A user-configured LunaRoute MCP wins: skip registration (the
          // adapter would reject ours by name anyway).
          maybeShowConfiguredNotice({ notify: (m) => callbacks.onProgress?.(m) });
        } else {
          const { registered, error } = registerLunarouteMcp(pi, creds.access, mcpDeps);
          if (error) console.warn(`LunaRoute MCP re-register failed: ${error.message}`);
          else if (!registered) maybeShowAdapterHint({ notify: (m) => callbacks.onProgress?.(m) });
        }
        // First-class web tools too (kata akyg): a fresh login means the
        // session_start path may have skipped registration (no key then).
        // Fire-and-forget — registerWebTools never throws.
        void registerWebTools(pi, { key: creds.access, ...mcpDeps, settings }).catch(() => {});
        // Same for the image tools (kata e30g).
        void registerImageTools(pi, { key: creds.access, ...mcpDeps, settings }).catch(() => {});
        return creds;
      },
    },
    refreshModels: createRefreshModels(process.env, {
      // After a refresh, if the user has no model selected (first /login
      // lunaroute, before any default is saved), auto-pick the first
      // LunaRoute model so they don't have to run /model manually — from the
      // fresh catalog, or the persisted one when the network attempt failed
      // (kata 9v71). setModel also saves it as the default, which persist+
      // restore then remembers on every later launch. The one-time "no
      // default model is configured for provider 'lunaroute'" notice Pi
      // shows before this refresh runs is a core limitation (its
      // defaultModelPerProvider map is static and not extensible for dynamic
      // providers) — so we say clearly what we picked right after it.
      onCatalogRefreshed: (models) => {
        if (!models.length) return;
        const noModel = !currentModel || (currentModel.provider === "unknown" && currentModel.id === "unknown");
        if (!noModel) return;
        void pi
          .setModel(toStoredModel(models[0], resolveRoutingUrl(process.env)))
          .then((applied) => {
            // false = auth not configured yet (e.g. unauthenticated
            // refresh) — benign, nothing to report.
            if (!applied) return;
            notifyUser(`LunaRoute: set ${models[0].name ?? models[0].id} as default model (change with /model)`, "info");
          })
          .catch((error: unknown) => {
            const message = error instanceof Error ? error.message : String(error);
            notifyUser(`LunaRoute: could not auto-select a default model: ${message}`, "warning");
          });
      },
    }),
    models: readPersistedModels(process.env),
  });

  pi.on("session_start", async (_event, ctx) => {
    currentModel = ctx.model;
    if (ctx.hasUI) latestUi = ctx.ui;
    const settings = readSettings(process.env);
    const key = await ctx.modelRegistry.getApiKeyForProvider(LUNAROUTE_PROVIDER);
    // Hint derives from the key lookup (works on hosts without
    // getProviderAuthStatus, e.g. oh-my-pi): a resolvable key — stored OAuth
    // or ambient apiKey — means the user is configured.
    if (ctx.hasUI && !key) {
      ctx.ui.notify(firstRunHint(), "info");
    }
    if (!key) return; // not logged in — silent, no MCP registration
    // User turned MCP off (kata bjy9): silent skip, defer notice included.
    if (mcpEnabled(settings)) {
      // A user-configured LunaRoute MCP server wins (the adapter keeps the
      // configured server and rejects ours by name): defer to it.
      if (await isLunarouteMcpConfigured(process.env)) {
        if (ctx.hasUI) maybeShowConfiguredNotice(ctx.ui);
      } else {
        const { registered, error } = registerLunarouteMcp(pi, key, mcpDeps);
        if (error && isAlreadyRegisteredError(error) && ctx.hasUI) {
          // Raced: the config appeared (or a custom --mcp-config was used) after
          // our check. Same defer outcome, same one-time notice.
          maybeShowConfiguredNotice(ctx.ui);
        } else if (error && ctx.hasUI) {
          ctx.ui.notify(`LunaRoute MCP registration failed: ${error.message}`, "warning");
        } else if (!registered && ctx.hasUI) {
          maybeShowAdapterHint(ctx.ui);
        }
      }
    }
    // First-class web_search/web_fetch (kata akyg): register only what is
    // missing locally and offered by the hosted MCP server. Never throws.
    await registerWebTools(pi, { key, ...mcpDeps, settings });
    // First-class image tools (kata e30g): no local detection — the server's
    // tools/list gates entitlement/policy. Never throws.
    await registerImageTools(pi, { key, ...mcpDeps, settings });
  });

  pi.on("model_select", (event) => {
    currentModel = event.model;
  });

  pi.on("session_shutdown", async () => {
    await disposeLunarouteMcp();
  });
}
