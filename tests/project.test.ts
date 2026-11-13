import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test, vi } from "vitest";
import {
  MAX_PROJECT_FILE_BYTES,
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
  test("rejects bytes that are not valid UTF-8", () => {
    // Decoded leniently, invalid bytes become U+FFFD and can still parse as
    // JSON — the file must be rejected instead.
    const dir = mkdtempSync(join(tmpdir(), "ga6g-utf8-"));
    try {
      writeFileSync(join(dir, ".lunaroute.json"), Buffer.from([0x7b, 0x22, 0xff, 0x22, 0x3a, 0x31, 0x7d]));
      expect(readProject(dir)).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("accepts a literal U+FFFD in an otherwise valid file", () => {
    const body = '{"project":"web","note":"\uFFFD"}';
    const io = { ...fakeIo([], { "/r/.lunaroute.json": body }), readFileBytes: () => Buffer.from(body, "utf8") };
    expect(readProject("/r", io)).toBe("web");
  });

  test("rejects a symlinked project file", () => {
    // A repo can commit .lunaroute.json as a symlink to /dev/zero or to a file
    // outside the checkout; the read must not follow it.
    const dir = mkdtempSync(join(tmpdir(), "ga6g-link-"));
    try {
      const target = join(dir, "real.json");
      writeFileSync(target, '{"project":"web"}');
      symlinkSync(target, join(dir, ".lunaroute.json"));
      expect(readProject(dir)).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("rejects an oversized project file without reading it into memory", () => {
    const dir = mkdtempSync(join(tmpdir(), "ga6g-big-"));
    try {
      writeFileSync(join(dir, ".lunaroute.json"), `{"project":"web"}${" ".repeat(MAX_PROJECT_FILE_BYTES)}`);
      expect(readProject(dir)).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
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
