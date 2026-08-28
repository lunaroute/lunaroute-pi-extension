import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Api, Credential, Model, OpenAICompletionsCompat, ThinkingLevelMap } from "@earendil-works/pi-ai";
import type { ProviderModelConfig } from "@earendil-works/pi-coding-agent";

export const LUNAROUTE_ENV_AGENT_DIR = "PI_CODING_AGENT_DIR";

export const LUNAROUTE_PROVIDER = "lunaroute";
// Every LunaRoute model is served over the OpenAI-completions API; this is also
// set on the provider config, so toStoredModel mirrors what applyExtension
// would produce and the catalog round-trips through Pi's ModelsStore.
export const LUNAROUTE_API = "openai-completions" as const;
export const LUNAROUTE_ENV_ROUTING_URL = "LUNAROUTE_ROUTING_URL";
export const LUNAROUTE_ENV_API_URL = "LUNAROUTE_API_URL";
export const LUNAROUTE_ENV_FRONT_URL = "LUNAROUTE_FRONT_URL";
export const LUNAROUTE_ENV_MCP_URL = "LUNAROUTE_MCP_URL";

// Production defaults — confirm against the deployed LunaRoute environment before release.
export const DEFAULT_ROUTING_URL = "https://gw.lunaroute.com/v1";
export const DEFAULT_API_URL = "https://api.lunaroute.com";
export const DEFAULT_FRONT_URL = "https://app.lunaroute.com";
export const DEFAULT_MCP_URL = "https://mcp.lunaroute.com/mcp";

export function resolveRoutingUrl(env: NodeJS.ProcessEnv): string {
  return env[LUNAROUTE_ENV_ROUTING_URL] || DEFAULT_ROUTING_URL;
}
export function resolveApiUrl(env: NodeJS.ProcessEnv): string {
  return env[LUNAROUTE_ENV_API_URL] || DEFAULT_API_URL;
}
export function resolveFrontUrl(env: NodeJS.ProcessEnv): string {
  return env[LUNAROUTE_ENV_FRONT_URL] || DEFAULT_FRONT_URL;
}
export function resolveMcpUrl(env: NodeJS.ProcessEnv): string {
  return env[LUNAROUTE_ENV_MCP_URL] || DEFAULT_MCP_URL;
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
  // Canonical unified device-auth route (lunaroute-saas kata yxjy); the legacy
  // /pi-auth page remains as backcompat for older deployed extensions.
  return `${frontUrl}/device-auth/pi?${params.toString()}`;
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

export type GatewayPiBlock = Partial<OpenAICompletionsCompat> & {
  thinkingLevelMap?: ThinkingLevelMap;
  compat?: OpenAICompletionsCompat;
};

export type GatewayModelObject = {
  id: string;
  display_name?: string;
  context_window?: number;
  max_output_tokens?: number;
  capabilities?: Record<string, boolean>;
  client_compat?: { pi?: GatewayPiBlock } | null;
  pi?: GatewayPiBlock;
};

export type CatalogMappingResult =
  | { ok: true; model: ProviderModelConfig }
  | { ok: false; reason: "reasoning_missing_pi_block"; id: string };

function normalizeGatewayPiBlock(pi: GatewayPiBlock): {
  thinkingLevelMap?: ThinkingLevelMap;
  compat?: OpenAICompletionsCompat;
} {
  const { thinkingLevelMap, compat: nestedCompat, ...flatCompat } = pi;
  return {
    thinkingLevelMap,
    compat: nestedCompat ?? (Object.keys(flatCompat).length > 0 ? flatCompat : undefined),
  };
}

export function mapCatalogEntry(entry: GatewayModelObject): CatalogMappingResult {
  const reasoning = entry.capabilities?.reasoning === true;
  const input: ("text" | "image")[] = entry.capabilities?.vision === true ? ["text", "image"] : ["text"];
  const gatewayPi = entry.client_compat?.pi ?? entry.pi;

  if (reasoning && !gatewayPi) {
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
  if (reasoning && gatewayPi) {
    const { thinkingLevelMap, compat } = normalizeGatewayPiBlock(gatewayPi);
    if (thinkingLevelMap) model.thinkingLevelMap = thinkingLevelMap;
    if (compat) model.compat = compat;
  }
  return { ok: true, model };
}

export function missingPiBlockWarning(id: string): string {
  return `LunaRoute model "${id}" supports reasoning but the catalog did not include Pi compatibility metadata. Skipping it. (Requires LunaRoute server issue vkd3.)`;
}

/** Build the persisted Model object for a mapped catalog entry.
 * Mirrors provider-composer's applyExtension output (api/provider/baseUrl
 * filled from the provider config) so the entry survives a structuredClone
 * through the ModelsStore and re-applies cleanly on the next launch. */
export function toStoredModel(model: ProviderModelConfig, baseUrl: string): Model<Api> {
  return {
    id: model.id,
    name: model.name,
    api: model.api ?? LUNAROUTE_API,
    provider: LUNAROUTE_PROVIDER,
    baseUrl: model.baseUrl ?? baseUrl,
    reasoning: model.reasoning,
    thinkingLevelMap: model.thinkingLevelMap,
    input: model.input,
    cost: model.cost,
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
    compat: model.compat,
  };
}

function agentDirFromEnv(env: NodeJS.ProcessEnv): string {
  const value = env[LUNAROUTE_ENV_AGENT_DIR];
  return typeof value === "string" && value ? value : join(homedir(), ".pi", "agent");
}

/**
 * Synchronously read the persisted LunaRoute snapshot from Pi's ModelsStore so
 * registerProvider can seed the registry with a non-empty model list.
 *
 * Why: refreshModels results are applied asynchronously (generation-checked
 * publish), and in at least one Pi runtime (the compiled RPC sidecar) the
 * post-startup publications can be superseded and dropped, leaving the
 * provider with its registration-time list — which was `[]` — until the next
 * fully successful refresh. Seeding from the store at registration makes the
 * registry non-empty deterministically; a successful refresh replaces it.
 * ponytail: reads Pi's models-store.json layout directly; if Pi ever changes
 * that file's schema this silently degrades to [] and the old race returns.
 */
export function readPersistedModels(env: NodeJS.ProcessEnv): Model<Api>[] {
  try {
    const raw = readFileSync(join(agentDirFromEnv(env), "models-store.json"), "utf8");
    const parsed = JSON.parse(raw) as Record<string, { models?: unknown }>;
    const models = parsed[LUNAROUTE_PROVIDER]?.models;
    if (!Array.isArray(models)) return [];
    return models.filter(
      (m): m is Model<Api> =>
        typeof m === "object" && m !== null &&
        typeof (m as Model<Api>).id === "string" &&
        typeof (m as Model<Api>).api === "string",
    );
  } catch {
    return [];
  }
}

export function firstRunHint(): string {
  return "Run `/login lunaroute` to start using LunaRoute.";
}
