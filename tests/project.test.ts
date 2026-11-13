import { describe, expect, test, vi } from "vitest";
import {
  PROJECT_FILE,
  clearProject,
  findProjectRoot,
  projectFilePath,
  projectHeaders,
  readProject,
  readSessionProject,
  setSessionRoot,
  validateProjectName,
  writeProject,
  type ProjectIo,
} from "../src/project.js";

function fakeIo(exists: string[], files: Record<string, string> = {}, fail?: Error): ProjectIo {
  return {
    existsSync: (p) => exists.includes(p),
    readFileSync: (p) => {
      if (fail) throw fail;
      if (p in files) return files[p];
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    },
    writeFileSync: vi.fn(),
    renameSync: vi.fn(),
    randomUUID: () => "test-uuid",
  };
}

describe("findProjectRoot", () => {
  test("walks up to the .git file or directory", () => {
    expect(findProjectRoot("/r/a/b", fakeIo(["/r/.git"]))).toBe("/r");
    expect(findProjectRoot("/r", fakeIo(["/r/.git"]))).toBe("/r");
  });

  test("falls back to cwd with no .git", () => {
    expect(findProjectRoot("/x/y", fakeIo([]))).toBe("/x/y");
  });
});

describe("projectFilePath", () => {
  test("is <root>/.lunaroute.json", () => {
    expect(projectFilePath("/r")).toBe(`/r/${PROJECT_FILE}`);
  });
});

describe("readProject", () => {
  test("is tolerant of missing, malformed and invalid files", () => {
    const ok = { "/r/.lunaroute.json": '{"project":"web"}' };
    expect(readProject("/r", fakeIo([], ok))).toBe("web");
    for (const bad of [
      '{"project":42}',
      '{"project":"caf\u00e9"}',
      "junk",
      "[]",
      '{"other":1}',
      JSON.stringify({ project: "x".repeat(200) }),
    ]) {
      expect(readProject("/r", fakeIo([], { "/r/.lunaroute.json": bad }))).toBeUndefined();
    }
    const denied = Object.assign(new Error("EACCES"), { code: "EACCES" });
    expect(readProject("/r", fakeIo([], {}, denied))).toBeUndefined();
  });
});

describe("readProject hardening", () => {
  test("skips a file above the size cap without reading it", () => {
    const io = { ...fakeIo([]), statSync: () => ({ size: 10_000_000 }), readFileSync: vi.fn(() => '{"project":"web"}') };
    expect(readProject("/r", io)).toBeUndefined();
    expect(io.readFileSync).not.toHaveBeenCalled();
  });

  test("rejects a file that is not valid UTF-8 anywhere", () => {
    // Node's utf8 decoder substitutes U+FFFD for invalid bytes, so a hostile
    // file can stay parseable JSON while being undecodable.
    const files = { "/r/.lunaroute.json": '{"project":"web","note":"\uFFFD"}' };
    expect(readProject("/r", fakeIo([], files))).toBeUndefined();
  });
});

describe("writeProject", () => {
  test("validates and writes atomically", () => {
    const io = fakeIo([]);
    writeProject("/r", "web", io);
    expect(io.writeFileSync).toHaveBeenCalledWith(
      `/r/${PROJECT_FILE}.test-uuid.tmp`,
      '{\n  "project": "web"\n}\n',
    );
    expect(io.renameSync).toHaveBeenCalledWith(`/r/${PROJECT_FILE}.test-uuid.tmp`, `/r/${PROJECT_FILE}`);
  });

  test("rejects a reserved name", () => {
    const io = fakeIo([]);
    expect(() => writeProject("/r", "clear", io)).toThrow(/reserved/);
    expect(io.writeFileSync).not.toHaveBeenCalled();
  });

  test("propagates a rename failure and removes its temp file", () => {
    const unlinkSync = vi.fn();
    const io: ProjectIo = {
      ...fakeIo([]),
      renameSync: () => {
        throw new Error("read-only");
      },
      unlinkSync,
    };
    expect(() => writeProject("/r", "web", io)).toThrow("read-only");
    expect(unlinkSync).toHaveBeenCalledWith(`/r/${PROJECT_FILE}.test-uuid.tmp`);
  });
});

describe("clearProject", () => {
  test("drops the key and writes atomically", () => {
    const io = fakeIo([], { "/r/.lunaroute.json": '{"project":"web"}' });
    clearProject("/r", io);
    expect(io.writeFileSync).toHaveBeenCalledWith(`/r/${PROJECT_FILE}.test-uuid.tmp`, "{}\n");
    expect(io.renameSync).toHaveBeenCalledWith(`/r/${PROJECT_FILE}.test-uuid.tmp`, `/r/${PROJECT_FILE}`);
  });
});

describe("validateProjectName", () => {
  test("accepts trimmed printable ASCII up to 128 chars", () => {
    expect(validateProjectName("  lunaroute-web  ")).toEqual({ ok: true, name: "lunaroute-web" });
    expect(validateProjectName("my app")).toEqual({ ok: true, name: "my app" });
    expect(validateProjectName("x".repeat(128)).ok).toBe(true);
  });

  test("rejects empty, oversize, non-ASCII, control and reserved values", () => {
    const cases: [string, RegExp][] = [
      ["", /empty/],
      ["x".repeat(129), /128/],
      ["a\nb", /printable ASCII/],
      ["caf\u00e9", /printable ASCII/],
      ["clear", /reserved/],
      [" Off ", /reserved/],
    ];
    for (const [bad, reason] of cases) {
      const r = validateProjectName(bad);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toMatch(reason);
    }
  });
});

describe("projectHeaders", () => {
  test("omits the key when unset and sets it when present", () => {
    expect(projectHeaders(undefined)).toEqual({});
    expect(projectHeaders("")).toEqual({});
    expect(projectHeaders("caf\u00e9")).toEqual({});
    expect(projectHeaders("web")).toEqual({ "LUNAROUTE-PROJECT-ID": "web" });
  });
});

describe("readSessionProject", () => {
  test("is undefined before session_start and follows root changes", () => {
    setSessionRoot(undefined);
    expect(readSessionProject(fakeIo([]))).toBeUndefined();
    setSessionRoot("/r");
    expect(readSessionProject(fakeIo([], { "/r/.lunaroute.json": '{"project":"web"}' }))).toBe("web");
    // resume/fork re-captures the directory: the new root wins immediately
    setSessionRoot("/b");
    expect(readSessionProject(fakeIo([], { "/r/.lunaroute.json": '{"project":"web"}' }))).toBeUndefined();
    setSessionRoot(undefined);
  });
});
