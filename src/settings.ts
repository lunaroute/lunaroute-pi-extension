import { randomUUID } from "node:crypto";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { LUNAROUTE_ENV_IMAGE_TOOLS, LUNAROUTE_ENV_WEB_TOOLS, agentDirFromEnv } from "./lunaroute.js";

/** User-facing settings persisted at `<agentDir>/lunaroute.json` (kata bjy9).
 *
 * Semantics: `"on"` means exactly the pre-settings behavior — including the
 * MCP defer-to-user-config rule and the web-tools auto-backfill rule. An
 * absent file equals DEFAULT_SETTINGS equals the old behavior byte-for-byte.
 * See docs/superpowers/specs/2026-09-08-bjy9-lunaroute-settings-tui-design.md.
 */

export type Toggle = "on" | "off";
/** `server` = omit the provider argument; the LunaRoute server default wins. */
export type SearchProviderSetting = "server" | "brave" | "exa" | "kagi";

export interface LunarouteSettings {
  mcp: Toggle;
  webTools: Toggle;
  searchProvider: SearchProviderSetting;
  imageTools: Toggle;
}

export const DEFAULT_SETTINGS: LunarouteSettings = {
  mcp: "on",
  webTools: "on",
  searchProvider: "server",
  imageTools: "on",
};

/** Static v1 list; the server may support more, the TUI offers these. */
export const SEARCH_PROVIDERS: readonly SearchProviderSetting[] = ["server", "brave", "exa", "kagi"] as const;

/** Concrete provider sent to the MCP tool; undefined = server default. */
export type ConcreteSearchProvider = Exclude<SearchProviderSetting, "server">;

// ============================================================================
// IO (injectable for tests; default = node:fs)
// ============================================================================

export interface SettingsIo {
  readFileSync(path: string): string;
  writeFileSync(path: string, data: string): void;
  renameSync(from: string, to: string): void;
  randomUUID(): string;
}

const defaultIo: SettingsIo = {
  readFileSync: (path) => readFileSync(path, "utf8"),
  writeFileSync,
  renameSync,
  randomUUID,
};

export function settingsPath(env: NodeJS.ProcessEnv): string {
  return join(agentDirFromEnv(env), "lunaroute.json");
}

function parseToggle(value: unknown, fallback: Toggle): Toggle {
  return value === "on" || value === "off" ? value : fallback;
}

function parseSearchProvider(value: unknown): SearchProviderSetting {
  return typeof value === "string" && (SEARCH_PROVIDERS as readonly string[]).includes(value)
    ? (value as SearchProviderSetting)
    : DEFAULT_SETTINGS.searchProvider;
}

/** Read settings, tolerantly: missing file, invalid JSON, or invalid values
 * fall back per key. Extra keys are ignored. Never throws. */
export function readSettings(env: NodeJS.ProcessEnv, io: SettingsIo = defaultIo): LunarouteSettings {
  let raw: string;
  try {
    raw = io.readFileSync(settingsPath(env));
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { ...DEFAULT_SETTINGS };
  }
  const obj = parsed as Record<string, unknown>;
  return {
    mcp: parseToggle(obj.mcp, DEFAULT_SETTINGS.mcp),
    webTools: parseToggle(obj.webTools, DEFAULT_SETTINGS.webTools),
    imageTools: parseToggle(obj.imageTools, DEFAULT_SETTINGS.imageTools),
    searchProvider: parseSearchProvider(obj.searchProvider),
  };
}

/** Atomically write the canonical three-key settings file (tmp + rename).
 * The file is ours: unknown keys read earlier are not preserved. */
export function writeSettings(
  env: NodeJS.ProcessEnv,
  settings: LunarouteSettings,
  io: SettingsIo = defaultIo,
): void {
  const target = settingsPath(env);
  const tmp = `${target}.${io.randomUUID()}.tmp`;
  io.writeFileSync(tmp, `${JSON.stringify(settings, null, 2)}\n`);
  io.renameSync(tmp, target);
}

// ============================================================================
// Decisions (pure)
// ============================================================================

/** Web tools enabled? The env escape hatch wins; the file is the user knob.
 * Env only ever disables (off|0|false) — mirroring the pre-settings contract. */
export function webToolsEnabled(env: NodeJS.ProcessEnv, settings: LunarouteSettings): boolean {
  const v = env[LUNAROUTE_ENV_WEB_TOOLS];
  if (v === "off" || v === "0" || v === "false") return false;
  return settings.webTools === "on";
}

/** Image tools enabled? Same contract as webToolsEnabled — the env escape
 * hatch only ever disables; the file is the user knob (kata e30g). */
export function imageToolsEnabled(env: NodeJS.ProcessEnv, settings: LunarouteSettings): boolean {
  const v = env[LUNAROUTE_ENV_IMAGE_TOOLS];
  if (v === "off" || v === "0" || v === "false") return false;
  return settings.imageTools === "on";
}

/** MCP registration enabled? (The user-config defer rule is orthogonal and
 * stays in the registration orchestration — see mcp.ts.) */
export function mcpEnabled(settings: LunarouteSettings): boolean {
  return settings.mcp === "on";
}

/** Provider to pass to the MCP web_search tool; undefined = server default. */
export function resolveSearchProvider(settings: LunarouteSettings): ConcreteSearchProvider | undefined {
  return settings.searchProvider === "server" ? undefined : settings.searchProvider;
}
