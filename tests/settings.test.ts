import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, test, vi } from "vitest";
import {
  DEFAULT_SETTINGS,
  convertToolsEnabled,
  imageToolsEnabled,
  mcpEnabled,
  readSettings,
  resolveSearchProvider,
  settingsPath,
  webToolsEnabled,
  writeSettings,
  type SettingsIo,
} from "../src/settings.js";

function fakeIo(files: Record<string, string>): SettingsIo {
  return {
    readFileSync: (path) => {
      if (path in files) return files[path];
      throw new Error("ENOENT");
    },
    writeFileSync: vi.fn(),
    renameSync: vi.fn(),
    randomUUID: () => "test-uuid",
  };
}

const ENV = { PI_CODING_AGENT_DIR: "/tmp/agent" } as NodeJS.ProcessEnv;

describe("settingsPath", () => {
  test("lives in the agent dir", () => {
    expect(settingsPath(ENV)).toBe(join("/tmp/agent", "lunaroute.json"));
  });

  test("respects PI_CODING_AGENT_DIR absence via homedir fallback", () => {
    // Same contract as agentDirFromEnv (lunaroute.ts) — spot-check only.
    expect(settingsPath({})).toContain("lunaroute.json");
  });
});

describe("readSettings (tolerant reader)", () => {
  const path = settingsPath(ENV);

  test("missing file → defaults", () => {
    expect(readSettings(ENV, fakeIo({}))).toEqual(DEFAULT_SETTINGS);
  });

  test("invalid JSON → defaults", () => {
    expect(readSettings(ENV, fakeIo({ [path]: "{not json" }))).toEqual(DEFAULT_SETTINGS);
  });

  test("non-object JSON (array / string / null) → defaults", () => {
    expect(readSettings(ENV, fakeIo({ [path]: "[]" }))).toEqual(DEFAULT_SETTINGS);
    expect(readSettings(ENV, fakeIo({ [path]: '"nope"' }))).toEqual(DEFAULT_SETTINGS);
    expect(readSettings(ENV, fakeIo({ [path]: "null" }))).toEqual(DEFAULT_SETTINGS);
  });

  test("partial file → per-key fallback, valid keys kept", () => {
    expect(readSettings(ENV, fakeIo({ [path]: '{"mcp":"off"}' }))).toEqual({
      mcp: "off",
      webTools: "on",
      searchProvider: "server",
      imageTools: "on",
      convertTools: "on",
    });
  });

  test("invalid per-key values fall back per key only", () => {
    const file = '{"mcp":"maybe","webTools":"off","searchProvider":"google","imageTools":"maybe","convertTools":"maybe"}';
    expect(readSettings(ENV, fakeIo({ [path]: file }))).toEqual({
      mcp: "on",
      webTools: "off",
      searchProvider: "server",
      imageTools: "on",
      convertTools: "on",
    });
  });

  test("extra keys are ignored on read", () => {
    const file = '{"mcp":"off","webTools":"on","searchProvider":"kagi","future":"x"}';
    expect(readSettings(ENV, fakeIo({ [path]: file })).searchProvider).toBe("kagi");
  });

  test("full valid file round-trips", () => {
    const file = '{"mcp":"off","webTools":"off","searchProvider":"brave","imageTools":"off","convertTools":"off"}';
    expect(readSettings(ENV, fakeIo({ [path]: file }))).toEqual({
      mcp: "off",
      webTools: "off",
      searchProvider: "brave",
      imageTools: "off",
      convertTools: "off",
    });
  });
});

describe("writeSettings (atomic, canonical)", () => {
  test("writes tmp then renames over target; canonical 4-key JSON + newline", () => {
    const io = fakeIo({});
    writeSettings(ENV, { mcp: "off", webTools: "on", searchProvider: "kagi", imageTools: "off", convertTools: "on" }, io);
    const target = settingsPath(ENV);
    const tmp = `${target}.test-uuid.tmp`;
    const expected = `${JSON.stringify({ mcp: "off", webTools: "on", searchProvider: "kagi", imageTools: "off", convertTools: "on" }, null, 2)}\n`;
    expect(io.writeFileSync).toHaveBeenCalledWith(tmp, expected);
    expect(io.renameSync).toHaveBeenCalledWith(tmp, target);
  });

  test("real round-trip: file exists, no tmp leftovers, read-back equals", () => {
    const dir = mkdtempSync(join(tmpdir(), "bjy9-settings-"));
    const env = { PI_CODING_AGENT_DIR: dir } as NodeJS.ProcessEnv;
    const settings = { mcp: "off" as const, webTools: "on" as const, searchProvider: "exa" as const, imageTools: "on" as const, convertTools: "on" as const };
    writeSettings(env, settings);
    expect(readSettings(env)).toEqual(settings);
    expect(readdirSync(dir)).toEqual(["lunaroute.json"]);
    expect(readFileSync(join(dir, "lunaroute.json"), "utf8")).toBe(
      `${JSON.stringify(settings, null, 2)}\n`,
    );
  });

  test("real write does not preserve unknown keys (file is ours)", () => {
    const dir = mkdtempSync(join(tmpdir(), "bjy9-settings-"));
    const env = { PI_CODING_AGENT_DIR: dir } as NodeJS.ProcessEnv;
    const path = join(dir, "lunaroute.json");
    writeFileSync(path, '{"mcp":"on","webTools":"on","searchProvider":"server","stale":"keep-me"}');
    writeSettings(env, DEFAULT_SETTINGS);
    expect(readFileSync(path, "utf8")).not.toContain("stale");
  });
});

describe("decisions", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  test("webToolsEnabled: file on → on; file off → off", () => {
    expect(webToolsEnabled({}, DEFAULT_SETTINGS)).toBe(true);
    expect(webToolsEnabled({}, { ...DEFAULT_SETTINGS, webTools: "off" })).toBe(false);
  });

  test("webToolsEnabled: env off|0|false wins over file on", () => {
    for (const v of ["off", "0", "false"]) {
      expect(webToolsEnabled({ LUNAROUTE_WEB_TOOLS: v }, DEFAULT_SETTINGS)).toBe(false);
    }
  });

  test("webToolsEnabled: env never enables past a file off (env only disables)", () => {
    expect(webToolsEnabled({ LUNAROUTE_WEB_TOOLS: "on" }, { ...DEFAULT_SETTINGS, webTools: "off" })).toBe(false);
  });

  test("imageToolsEnabled: file on → on; file off → off", () => {
    expect(imageToolsEnabled({}, DEFAULT_SETTINGS)).toBe(true);
    expect(imageToolsEnabled({}, { ...DEFAULT_SETTINGS, imageTools: "off" })).toBe(false);
  });

  test("imageToolsEnabled: env off|0|false wins over file on", () => {
    for (const v of ["off", "0", "false"]) {
      expect(imageToolsEnabled({ LUNAROUTE_IMAGE_TOOLS: v }, DEFAULT_SETTINGS)).toBe(false);
    }
  });

  test("imageToolsEnabled: env never enables past a file off (env only disables)", () => {
    expect(imageToolsEnabled({ LUNAROUTE_IMAGE_TOOLS: "on" }, { ...DEFAULT_SETTINGS, imageTools: "off" })).toBe(false);
  });

  test("convertToolsEnabled: file on → on; file off → off", () => {
    expect(convertToolsEnabled({}, DEFAULT_SETTINGS)).toBe(true);
    expect(convertToolsEnabled({}, { ...DEFAULT_SETTINGS, convertTools: "off" })).toBe(false);
  });

  test("convertToolsEnabled: env off|0|false wins over file on; never enables past file off", () => {
    for (const v of ["off", "0", "false"]) {
      expect(convertToolsEnabled({ LUNAROUTE_CONVERT_TOOLS: v }, DEFAULT_SETTINGS)).toBe(false);
    }
    expect(convertToolsEnabled({ LUNAROUTE_CONVERT_TOOLS: "on" }, { ...DEFAULT_SETTINGS, convertTools: "off" })).toBe(false);
  });

  test("mcpEnabled", () => {
    expect(mcpEnabled(DEFAULT_SETTINGS)).toBe(true);
    expect(mcpEnabled({ ...DEFAULT_SETTINGS, mcp: "off" })).toBe(false);
  });

  test("resolveSearchProvider: server → undefined; concrete passes through", () => {
    expect(resolveSearchProvider(DEFAULT_SETTINGS)).toBeUndefined();
    expect(resolveSearchProvider({ ...DEFAULT_SETTINGS, searchProvider: "kagi" })).toBe("kagi");
    expect(resolveSearchProvider({ ...DEFAULT_SETTINGS, searchProvider: "brave" })).toBe("brave");
    expect(resolveSearchProvider({ ...DEFAULT_SETTINGS, searchProvider: "exa" })).toBe("exa");
  });
});
