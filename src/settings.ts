import { randomUUID } from "node:crypto";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  LUNAROUTE_DEFAULT_PROVIDER_RETRIES,
  LUNAROUTE_ENV_CONVERT_TOOLS,
  LUNAROUTE_ENV_IMAGE_TOOLS,
  LUNAROUTE_ENV_USAGE_INSIGHTS,
  LUNAROUTE_ENV_WEB_TOOLS,
  agentDirFromEnv,
} from "./lunaroute.js";

/** User-facing settings persisted at `<agentDir>/lunaroute.json` (kata bjy9).
 *
 * Semantics: `"on"` means exactly the pre-settings behavior — including the
 * MCP defer-to-user-config rule and the web-tools auto-backfill rule. An
 * absent file equals DEFAULT_SETTINGS equals the old behavior byte-for-byte.
 * See docs/superpowers/specs/2026-09-08-bjy9-lunaroute-settings-tui-design.md.
 */

export type Toggle = "on" | "off";
/** `server` = omit the provider argument; the LunaRoute server default wins. */
export type SearchProviderSetting = "server" | "brave" | "exa" | "kagi" | "youcom";

export interface LunarouteSettings {
  mcp: Toggle;
  webTools: Toggle;
  searchProvider: SearchProviderSetting;
  imageTools: Toggle;
  convertTools: Toggle;
  /** Provider-level retries for model requests; 0 = off (kata z5y7). */
  providerRetries: number;
  /** Queue/usage messages and `/lunaroute usage`; on by default. */
  usageInsights: Toggle;
}

export const DEFAULT_SETTINGS: LunarouteSettings = {
  mcp: "on",
  webTools: "on",
  searchProvider: "server",
  imageTools: "on",
  convertTools: "on",
  providerRetries: LUNAROUTE_DEFAULT_PROVIDER_RETRIES,
  usageInsights: "on",
};

/** Upper bound for providerRetries — also the `/lunaroute` UI's last option. */
export const PROVIDER_RETRIES_MAX = 5;

/** Static v1 list; the server may support more, the TUI offers these. */
export const SEARCH_PROVIDERS: readonly SearchProviderSetting[] = ["server", "brave", "exa", "kagi", "youcom"] as const;

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

/** Spellings a human or a model actually types for `youcom`. Without this,
 * `"you.com"` was dropped silently and searches went out on the server
 * default (kata ccbw). Canonical value on disk stays `youcom`. A Map, not an
 * object literal: `"constructor"` must fall back, not resolve to a prototype
 * member and reach web_search as a bogus provider. */
const SEARCH_PROVIDER_ALIASES = new Map<string, SearchProviderSetting>([
  ["you", "youcom"],
  ["you.com", "youcom"],
]);

function parseSearchProvider(value: unknown): SearchProviderSetting {
  if (typeof value !== "string") return DEFAULT_SETTINGS.searchProvider;
  const key = value.trim().toLowerCase();
  if ((SEARCH_PROVIDERS as readonly string[]).includes(key)) return key as SearchProviderSetting;
  return SEARCH_PROVIDER_ALIASES.get(key) ?? DEFAULT_SETTINGS.searchProvider;
}

/** Integer number or digits-only string, clamped to [0, PROVIDER_RETRIES_MAX].
 * Anything else keeps the default: a naive Number() would read "" / whitespace
 * as 0 and silently disable retries on a malformed file. */
function parseProviderRetries(value: unknown): number {
  const n =
    typeof value === "number"
      ? value
      : typeof value === "string" && /^\d+$/.test(value)
        ? Number(value)
        : NaN;
  if (!Number.isInteger(n)) return LUNAROUTE_DEFAULT_PROVIDER_RETRIES;
  return Math.min(PROVIDER_RETRIES_MAX, Math.max(0, n));
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
    convertTools: parseToggle(obj.convertTools, DEFAULT_SETTINGS.convertTools),
    providerRetries: parseProviderRetries(obj.providerRetries),
    usageInsights: parseToggle(obj.usageInsights, DEFAULT_SETTINGS.usageInsights),
    searchProvider: parseSearchProvider(obj.searchProvider),
  };
}

/** Atomically write the canonical settings file (tmp + rename).
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

/** Convert tools enabled? Same contract as webToolsEnabled/imageToolsEnabled
 * — the env escape hatch only ever disables; the file is the user knob
 * (kata zpzt). */
export function convertToolsEnabled(env: NodeJS.ProcessEnv, settings: LunarouteSettings): boolean {
  const v = env[LUNAROUTE_ENV_CONVERT_TOOLS];
  if (v === "off" || v === "0" || v === "false") return false;
  return settings.convertTools === "on";
}

/** Master switch for every MCP-backed tool family (kata 4ws9): off means no
 * LunaRoute MCP tools at all; on lets each family's own toggle decide. */
export function mcpEnabled(settings: LunarouteSettings): boolean {
  return settings.mcp === "on";
}

/** Provider to pass to the MCP web_search tool; undefined = server default. */
export function resolveSearchProvider(settings: LunarouteSettings): ConcreteSearchProvider | undefined {
  return settings.searchProvider === "server" ? undefined : settings.searchProvider;
}

/** Usage insights enabled? Same contract as the tool toggles — the env escape
 * hatch only ever disables; the file is the user knob. */
export function usageInsightsEnabled(env: NodeJS.ProcessEnv, settings: LunarouteSettings): boolean {
  const v = env[LUNAROUTE_ENV_USAGE_INSIGHTS];
  if (v === "off" || v === "0" || v === "false") return false;
  return settings.usageInsights === "on";
}
