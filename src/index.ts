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

export default function lunarouteExtension(pi: ExtensionAPI): void {
  const sessionId = generateSessionId();

  pi.registerProvider(LUNAROUTE_PROVIDER, {
    name: "LunaRoute",
    baseUrl: resolveRoutingUrl(process.env),
    api: "openai-completions",
    authHeader: true,
    headers: buildAttributionHeaders(VERSION, sessionId),
    oauth: lunarouteOAuth,
    refreshModels: createRefreshModels(process.env),
    models: [],
  });

  pi.on("session_start", (_event, ctx) => {
    if (!ctx.hasUI) return;
    const status = ctx.modelRegistry.getProviderAuthStatus(LUNAROUTE_PROVIDER);
    if (!status?.configured) {
      ctx.ui.notify(firstRunHint(), "info");
    }
  });
}
