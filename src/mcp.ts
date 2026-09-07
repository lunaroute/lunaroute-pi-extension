import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { buildAttributionHeaders, resolveMcpUrl } from "./lunaroute.js";

// Versioned runtime-register contract with pi-mcp-adapter (verified against
// 2.28.0). The adapter listens on the shared EventBus and writes
// request.result synchronously; an unset result means the adapter is not
// installed. Emit, then read request.result immediately — EventBus.emit is
// synchronous (see pi's event-bus.d.ts).
export const MCP_RUNTIME_REGISTER_EVENT = "pi-mcp-adapter:runtime-register:v1" as const;
export const MCP_RUNTIME_REGISTER_VERSION = 1 as const;
export const LUNAROUTE_MCP_SERVER_NAME = "lunaroute";

export const MCP_INSTALL_HINT =
  "Install pi-mcp-adapter to use LunaRoute tools (image generation): pi install npm:pi-mcp-adapter";

export const MCP_CONFIGURED_NOTICE =
  "LunaRoute MCP is already configured in your MCP config — the extension skips its own registration to avoid a conflict. Your config's key/auth is used; note that /login key rotation won't update it.";

export type McpServerRegistration = { dispose(): Promise<void> };

export type McpRuntimeRegistrationResult =
  | { ok: true; registration: McpServerRegistration }
  | { ok: false; error: Error };

/** Minimal shape of the adapter's merged config we care about. */
type AdapterMcpConfig = { mcpServers?: Record<string, { url?: string }> };

async function defaultLoadAdapterConfig(): Promise<AdapterMcpConfig | null> {
  try {
    // ponytail: variable specifier dodges the type checker — pi-mcp-adapter is
    // an optional runtime peer (sibling in ~/.pi/agent/npm/node_modules) that
    // is absent in dev; a literal import fails `tsc` here. If the adapter
    // ever changes loadMcpConfig's shape this degrades to null and we just
    // register as before (adapter still rejects by name).
    const specifier = "pi-mcp-adapter/config";
    const mod = (await import(specifier)) as { loadMcpConfig(): AdapterMcpConfig };
    return mod.loadMcpConfig();
  } catch {
    return null; // adapter not installed — nothing to defer to
  }
}

let loadAdapterConfig: () => Promise<AdapterMcpConfig | null> = defaultLoadAdapterConfig;

/** True when `servers` already defines the LunaRoute MCP server — by name, or
 * by exact URL under a different name (duplicate tool surfaces). */
export function isLunarouteServerConfigured(
  servers: Record<string, { url?: string }> | undefined,
  mcpUrl: string,
): boolean {
  if (!servers) return false;
  if (Object.hasOwn(servers, LUNAROUTE_MCP_SERVER_NAME)) return true;
  return Object.values(servers).some((s) => typeof s?.url === "string" && s.url === mcpUrl);
}

/** True when the effective MCP config (the adapter's full precedence chain:
 * shared global, pi global, project files) already defines the LunaRoute MCP
 * server. The adapter keeps the configured server and rejects ours by name,
 * so a manually-configured LunaRoute MCP wins — we defer to it. */
export async function isLunarouteMcpConfigured(env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  let config: AdapterMcpConfig | null;
  try {
    config = await loadAdapterConfig();
  } catch {
    return false; // adapter absent or config unreadable — nothing to defer to
  }
  if (!config) return false;
  return isLunarouteServerConfigured(config.mcpServers, resolveMcpUrl(env));
}

let configNoticeShown = false;

/** Show the defer-to-user-config notice exactly once per process. */
export function maybeShowConfiguredNotice(
  ui: { notify(message: string, type?: "info" | "warning" | "error"): void },
): boolean {
  if (configNoticeShown) return false;
  configNoticeShown = true;
  ui.notify(MCP_CONFIGURED_NOTICE, "info");
  return true;
}

/** The adapter rejects a runtime register whose name exists in the user's
 * config — that outcome is the defer case, not a failure. */
export function isAlreadyRegisteredError(err: Error): boolean {
  return err.message.includes("already registered");
}

export interface McpRuntimeRegistrationRequest {
  version: typeof MCP_RUNTIME_REGISTER_VERSION;
  name: string;
  definition: {
    url: string;
    headers: Record<string, string>;
    auth: false;
  };
  result?: McpRuntimeRegistrationResult;
}

export interface McpRegisterDeps {
  env: NodeJS.ProcessEnv;
  version: string;
  sessionId: string;
}

// ponytail: single module-scoped handle — this extension loads once per
// process; key per-ExtensionAPI if multi-session-per-process ever shows up.
let registration: McpServerRegistration | null = null;
let hintShown = false;

export function buildMcpDefinition(key: string, deps: McpRegisterDeps) {
  return {
    url: resolveMcpUrl(deps.env),
    headers: {
      "LUNAROUTE-API-KEY": key,
      ...buildAttributionHeaders(deps.version, deps.sessionId),
    },
    auth: false as const,
  };
}

/** Ensure the lunaroute MCP server is registered with the given key.
 * Idempotent: a no-op if already registered this process — call disposeLunarouteMcp
 * first to force re-registration with a rotated key. Returns three states:
 * registered (ok or already-registered), absent (no adapter listener), or
 * adapter-rejected (ok:false). The caller must not throw on failure — MCP is optional. */
export function registerLunarouteMcp(
  pi: ExtensionAPI,
  key: string,
  deps: McpRegisterDeps,
): { registered: boolean; error?: Error } {
  if (registration) return { registered: true }; // already registered
  const request: McpRuntimeRegistrationRequest = {
    version: MCP_RUNTIME_REGISTER_VERSION,
    name: LUNAROUTE_MCP_SERVER_NAME,
    definition: buildMcpDefinition(key, deps),
  };
  try {
    pi.events.emit(MCP_RUNTIME_REGISTER_EVENT, request);
  } catch (err) {
    // A throwing listener must not break login/session start (MCP is optional).
    return { registered: false, error: err instanceof Error ? err : new Error(String(err)) };
  }
  const result = request.result;
  if (!result) return { registered: false }; // adapter not installed
  if (!result.ok) return { registered: false, error: result.error };
  registration = result.registration;
  return { registered: true };
}

/** Dispose the current registration (no-op when nothing is registered;
 * never throws — MCP is optional and must not break session shutdown). */
export async function disposeLunarouteMcp(): Promise<void> {
  const r = registration;
  registration = null;
  if (!r) return;
  try {
    await r.dispose();
  } catch (err) {
    console.warn(`LunaRoute MCP dispose failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Show the install-pi-mcp-adapter hint exactly once per process, only at the
 * call site (which is gated on a key being present). Returns true if shown.
 */
export function maybeShowAdapterHint(
  ui: { notify(message: string, type?: "info" | "warning" | "error"): void },
): boolean {
  if (hintShown) return false;
  hintShown = true;
  ui.notify(MCP_INSTALL_HINT, "info");
  return true;
}

/** Test-only: reset module-scoped state. */
export function _resetMcpState(): void {
  registration = null;
  hintShown = false;
  configNoticeShown = false;
  loadAdapterConfig = defaultLoadAdapterConfig;
}

/** Test-only: stub the adapter-config loader. */
export function _setAdapterConfigLoader(fn: () => Promise<AdapterMcpConfig | null>): void {
  loadAdapterConfig = fn;
}
