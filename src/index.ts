import { VERSION, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  LUNAROUTE_PROVIDER,
  buildLunarouteHeaders,
  generateSessionId,
  hasLunarouteAuth,
  hasLunarouteProvider,
  missingApiKeyWarning,
  missingProviderWarning,
} from "./lunaroute.js";

export function registerLunarouteExtension(
  pi: ExtensionAPI,
  version: string,
  env: NodeJS.ProcessEnv,
  sessionId = generateSessionId(),
): void {
  pi.registerProvider(LUNAROUTE_PROVIDER, {
    headers: buildLunarouteHeaders(version, sessionId),
  });

  pi.on("session_start", (_event, ctx) => {
    const hasProvider = hasLunarouteProvider(ctx.modelRegistry.getAll());

    if (!hasProvider) {
      if (ctx.hasUI) {
        ctx.ui.notify(missingProviderWarning(), "warning");
      }
      return;
    }

    const authStatus = ctx.modelRegistry.getProviderAuthStatus(LUNAROUTE_PROVIDER);
    if (!hasLunarouteAuth(env, authStatus) && ctx.hasUI) {
      ctx.ui.notify(missingApiKeyWarning(), "warning");
    }
  });
}

export default function lunarouteExtension(pi: ExtensionAPI): void {
  registerLunarouteExtension(pi, VERSION, process.env);
}
