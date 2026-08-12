import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { Credential, OpenAICompletionsCompat, ThinkingLevelMap } from "@earendil-works/pi-ai";
import type { ProviderModelConfig } from "@earendil-works/pi-coding-agent";

export const LUNAROUTE_PROVIDER = "lunaroute";
export const LUNAROUTE_ENV_ROUTING_URL = "LUNAROUTE_ROUTING_URL";
export const LUNAROUTE_ENV_API_URL = "LUNAROUTE_API_URL";
export const LUNAROUTE_ENV_FRONT_URL = "LUNAROUTE_FRONT_URL";

// Production defaults — confirm against the deployed LunaRoute environment before release.
export const DEFAULT_ROUTING_URL = "https://gw.lunaroute.com/v1";
export const DEFAULT_API_URL = "https://api.lunaroute.com";
export const DEFAULT_FRONT_URL = "https://app.lunaroute.com";

export function resolveRoutingUrl(env: NodeJS.ProcessEnv): string {
  return env[LUNAROUTE_ENV_ROUTING_URL] || DEFAULT_ROUTING_URL;
}
export function resolveApiUrl(env: NodeJS.ProcessEnv): string {
  return env[LUNAROUTE_ENV_API_URL] || DEFAULT_API_URL;
}
export function resolveFrontUrl(env: NodeJS.ProcessEnv): string {
  return env[LUNAROUTE_ENV_FRONT_URL] || DEFAULT_FRONT_URL;
}

export function buildAttributionHeaders(version: string, sessionId: string): Record<string, string> {
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

// PKCE — hex sha256 to match LunaRoute's Go backend (sha256hexStr) and lunaroute-cli.
export function generatePkceVerifier(): string {
  return randomBytes(32).toString("hex");
}
export function computePkceChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("hex");
}
export function generateState(): string {
  return randomBytes(16).toString("hex");
}

export function buildPiAuthUrl(frontUrl: string, port: number, state: string, challenge: string): string {
  const params = new URLSearchParams({ port: String(port), state, challenge });
  return `${frontUrl}/pi-auth?${params.toString()}`;
}

export function parseCallbackQuery(callbackUrl: string): { code: string; state: string } {
  const url = new URL(callbackUrl, "http://127.0.0.1");
  return { code: url.searchParams.get("code") ?? "", state: url.searchParams.get("state") ?? "" };
}

export type ExchangeRequest = { code: string; verifier: string; label: string };
export type ExchangeResponse = {
  full_key: string;
  org_id: string;
  user_email: string;
  routing_url?: string;
  api_url?: string;
};

export function buildExchangeBody(req: ExchangeRequest): string {
  return JSON.stringify(req);
}

export function resolveCredentialKey(credential: Credential | undefined): string | undefined {
  if (!credential) return undefined;
  if (credential.type === "oauth") return credential.access;
  if (credential.type === "api_key") return credential.key;
  return undefined;
}

export type GatewayPiBlock = {
  thinkingLevelMap?: ThinkingLevelMap;
  compat?: Pick<OpenAICompletionsCompat, "thinkingFormat" | "maxTokensField" | "supportsReasoningEffort">;
};

export type GatewayModelObject = {
  id: string;
  display_name?: string;
  context_window?: number;
  max_output_tokens?: number;
  capabilities?: Record<string, boolean>;
  pi?: GatewayPiBlock;
};

export type CatalogMappingResult =
  | { ok: true; model: ProviderModelConfig }
  | { ok: false; reason: "reasoning_missing_pi_block"; id: string };

export function mapCatalogEntry(entry: GatewayModelObject): CatalogMappingResult {
  const reasoning = entry.capabilities?.reasoning === true;
  const input: ("text" | "image")[] = entry.capabilities?.vision === true ? ["text", "image"] : ["text"];

  if (reasoning && !entry.pi) {
    return { ok: false, reason: "reasoning_missing_pi_block", id: entry.id };
  }

  const model: ProviderModelConfig = {
    id: entry.id,
    name: entry.display_name ?? entry.id,
    reasoning,
    input,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: entry.context_window ?? 0,
    maxTokens: entry.max_output_tokens ?? 0,
  };
  if (entry.pi?.thinkingLevelMap) model.thinkingLevelMap = entry.pi.thinkingLevelMap;
  if (entry.pi?.compat) model.compat = entry.pi.compat;
  return { ok: true, model };
}

export function missingPiBlockWarning(id: string): string {
  return `LunaRoute model "${id}" supports reasoning but the catalog did not include Pi compatibility metadata. Skipping it. (Requires LunaRoute server issue vkd3.)`;
}

export function firstRunHint(): string {
  return "Run `/login lunaroute` to start using LunaRoute.";
}
