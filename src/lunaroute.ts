import { randomUUID } from "node:crypto";

export const LUNAROUTE_PROVIDER = "lunaroute";
export const LUNAROUTE_ENV_VAR = "LUNAROUTE_API_KEY";

export type MinimalModel = {
  provider?: string;
};

export type MinimalAuthStatus = {
  configured?: boolean;
};

export function buildLunarouteHeaders(version: string, sessionId: string): Record<string, string> {
  return {
    "lunaroute-agent": `pi/${version}`,
    "x-lunaroute-session": sessionId,
    "lunaroute-session-id": sessionId,
  };
}

export function generateSessionId(
  randomUuid: () => string = randomUUID,
  now: () => number = Date.now,
  random: () => number = Math.random,
): string {
  try {
    return randomUuid();
  } catch {
    return `lunaroute-pi-${now()}-${random().toString(36).slice(2, 10)}`;
  }
}

export function hasLunarouteProvider(models: MinimalModel[]): boolean {
  return models.some((model) => model.provider === LUNAROUTE_PROVIDER);
}

export function hasLunarouteAuth(env: NodeJS.ProcessEnv, authStatus: MinimalAuthStatus): boolean {
  return Boolean(env[LUNAROUTE_ENV_VAR]) || authStatus.configured === true;
}

export function missingProviderWarning(): string {
  return "LunaRoute Pi extension loaded, but no provider named `lunaroute` is configured.";
}

export function missingApiKeyWarning(): string {
  return [
    "LunaRoute provider is configured, but no API key was found.",
    "",
    "Set one of:",
    "1. Environment variable: export LUNAROUTE_API_KEY=lr_...",
    "   and in ~/.pi/agent/models.json use \"apiKey\": \"$LUNAROUTE_API_KEY\".",
    "2. Stored Pi credential for provider \"lunaroute\".",
    "3. Direct ~/.pi/agent/models.json apiKey value, supported but less preferred.",
  ].join("\n");
}
