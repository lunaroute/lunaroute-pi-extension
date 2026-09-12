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
import { registerWebTools } from "./web-tools.js";
import { registerImageTools } from "./image-tools.js";
import { registerConvertTools } from "./convert-tools.js";
import { mcpEnabled, readSettings } from "./settings.js";
import { registerLunarouteSettingsCommand } from "./settings-ui.js";
import { createRequire } from "node:module";

// One-time-per-process migration notice (kata 4ws9): the extension no longer
// uses pi-mcp-adapter — first-class tools cover the hosted server directly.
// Users who installed the adapter at our old hint can remove it; stay soft
// because the adapter may still serve their OTHER MCP servers.
export const ADAPTER_MIGRATION_NOTICE =
  "LunaRoute no longer uses pi-mcp-adapter. Remove it with `pi remove npm:pi-mcp-adapter` unless other MCP servers need it.";

let adapterNoticeShown = false;
let adapterInstalledOverride: (() => boolean) | undefined;

export function isPiMcpAdapterInstalled(): boolean {
  if (adapterInstalledOverride) return adapterInstalledOverride();
  let resolve: (spec: string) => string;
  try {
    resolve = createRequire(import.meta.url).resolve;
  } catch {
    return false;
  }
  try {
    resolve("pi-mcp-adapter");
    return true;
  } catch (e) {
    // ERR_PACKAGE_PATH_NOT_EXPORTED still means "package found".
    return (e as NodeJS.ErrnoException).code !== "MODULE_NOT_FOUND";
  }
}

function maybeShowAdapterMigrationNotice(ui: {
  notify(message: string, type?: "info" | "warning" | "error"): void;
}): void {
  if (adapterNoticeShown) return;
  if (!isPiMcpAdapterInstalled()) return;
  adapterNoticeShown = true;
  ui.notify(ADAPTER_MIGRATION_NOTICE, "info");
}

export function _resetAdapterNoticeState(): void {
  adapterNoticeShown = false;
  adapterInstalledOverride = undefined;
}

/** Test-only: force the adapter-presence answer. */
export function _setAdapterInstalledOverride(fn: (() => boolean) | undefined): void {
  adapterInstalledOverride = fn;
}

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
        // First-class tools on a fresh login (kata akyg/e30g/zpzt): the
        // session_start path may have skipped registration (no key then).
        // Master-gated by the mcp toggle (kata 4ws9); family toggles apply
        // inside each register* call. Fire-and-forget — register* never throw.
        const settings = readSettings(process.env);
        if (mcpEnabled(settings)) {
          void registerWebTools(pi, { key: creds.access, ...mcpDeps, settings }).catch(() => {});
          // Settings re-read at each call site: several awaits separate these
          // from the read above, and a /lunaroute toggle in between must win
          // (roborev job 1670).
          void registerImageTools(pi, { key: creds.access, ...mcpDeps, settings: readSettings(process.env) }).catch(() => {});
          void registerConvertTools(pi, { key: creds.access, ...mcpDeps, settings: readSettings(process.env) }).catch(() => {});
        }
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
    if (!key) return; // not logged in — silent, no tool registration
    maybeShowAdapterMigrationNotice(ctx.ui);
    if (mcpEnabled(settings)) {
      // Master gate (kata 4ws9): the mcp toggle governs every MCP-backed
      // family; each family's own toggle applies inside register*.
      await registerWebTools(pi, { key, ...mcpDeps, settings });
      // Settings are read AT each call site: the key lookup above awaited,
      // and a /lunaroute toggle landing in that window must not be bypassed
      // by a stale "on" snapshot (roborev job 1670).
      await registerImageTools(pi, { key, ...mcpDeps, settings: readSettings(process.env) });
      await registerConvertTools(pi, { key, ...mcpDeps, settings: readSettings(process.env) });
    }
  });

  pi.on("model_select", (event) => {
    currentModel = event.model;
  });
}
