import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type { SettingsIo } from "./settings.js";

/** Repo-local project attribution (kata ga6g).
 *
 * `/lunaroute project <name>` writes `<git root>/.lunaroute.json` and every
 * request carries it as `LUNAROUTE-PROJECT-ID`. The file travels with a
 * cloned repo, so its value is untrusted: it is validated here and only ever
 * injected as a *literal* request header — never into provider config, whose
 * values pi resolves through `resolveConfigValue` (a leading `!` is execSync).
 * See docs/superpowers/specs/2026-11-13-ga6g-project-id-design.md.
 */

export const PROJECT_FILE = ".lunaroute.json";
export const PROJECT_HEADER = "LUNAROUTE-PROJECT-ID";

/** `clear` and `off` are command words, so they cannot also be project names. */
const RESERVED_NAMES = new Set(["clear", "off"]);

export interface ProjectIo extends SettingsIo {
  existsSync(path: string): boolean;
  /** Optional so test fakes stay small; the default implementation provides
   * all of them. */
  readFileBytes?(path: string): Uint8Array;
  unlinkSync?(path: string): void;
}

/** A project file is a two-field config, so anything larger is not one. Keeps
 * a hostile repo from making every request read and parse megabytes. */
export const MAX_PROJECT_FILE_BYTES = 4096;

/** Lenient decoding turns undecodable bytes into U+FFFD, which can still
 * parse as JSON, so bytes are decoded strictly. */
const strictUtf8 = new TextDecoder("utf-8", { fatal: true });

/** Read at most MAX_PROJECT_FILE_BYTES from the opened descriptor.
 *
 * One open, one fstat, one bounded read: the checks and the read see the same
 * inode, so replacing the path with a symlink or growing it after a check
 * cannot turn the read into an unbounded one. O_NOFOLLOW refuses a symlinked
 * file outright — a repo may ship one pointing at /dev/zero or outside the
 * checkout, and devices report size 0. O_NONBLOCK keeps the open itself from
 * waiting on a FIFO; fstat then rejects it. */
function readProjectBytes(path: string): Uint8Array {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_PROJECT_FILE_BYTES) {
      throw new Error("not a readable project file");
    }
    const buffer = Buffer.allocUnsafe(Math.min(stat.size, MAX_PROJECT_FILE_BYTES));
    const n = readSync(fd, buffer, 0, buffer.length, 0);
    return buffer.subarray(0, n);
  } finally {
    closeSync(fd);
  }
}

export const defaultProjectIo: ProjectIo = {
  existsSync,
  unlinkSync,
  readFileBytes: readProjectBytes,
  readFileSync: (path) => readFileSync(path, "utf8"),
  writeFileSync,
  renameSync,
  randomUUID,
};

/** Nearest ancestor of `cwd` holding a `.git` entry (a directory for a normal
 * checkout, a file for a worktree or submodule); `cwd` itself when there is
 * none. */
export function findProjectRoot(cwd: string, io: ProjectIo = defaultProjectIo): string {
  let dir = cwd;
  for (;;) {
    if (io.existsSync(join(dir, ".git"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return cwd;
    dir = parent;
  }
}

export function projectFilePath(root: string): string {
  return join(root, PROJECT_FILE);
}

export type ProjectNameResult = { ok: true; name: string } | { ok: false; reason: string };

/** Trim, then demand 1..128 printable ASCII characters. Controls are header
 * injection; non-ASCII is silently mangled by HTTP headers rather than
 * rejected. */
export function validateProjectName(raw: string): ProjectNameResult {
  const name = raw.trim();
  if (name === "") return { ok: false, reason: "Project name cannot be empty." };
  if (name.length > 128) return { ok: false, reason: "Project name must be 128 characters or fewer." };
  if (!/^[\x20-\x7e]+$/.test(name)) return { ok: false, reason: "Project name must be printable ASCII." };
  if (RESERVED_NAMES.has(name.toLowerCase())) {
    return { ok: false, reason: "`clear` and `off` are reserved project names." };
  }
  return { ok: true, name };
}

/** Read the repo's project, or undefined for every failure mode: missing file,
 * unreadable file, bad JSON, wrong shape, invalid name. Never throws — a
 * broken file must degrade to no header, not break requests. */
export function readProject(root: string, io: ProjectIo = defaultProjectIo): string | undefined {
  const target = projectFilePath(root);
  let raw: string;
  let parsed: unknown;
  try {
    raw = io.readFileBytes ? strictUtf8.decode(io.readFileBytes(target)) : io.readFileSync(target);
    if (raw.length > MAX_PROJECT_FILE_BYTES) return undefined;
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
  const value = (parsed as Record<string, unknown>).project;
  if (typeof value !== "string") return undefined;
  const result = validateProjectName(value);
  return result.ok ? result.name : undefined;
}

function writeProjectFile(root: string, body: unknown, io: ProjectIo): void {
  const target = projectFilePath(root);
  const tmp = `${target}.${io.randomUUID()}.tmp`;
  try {
    io.writeFileSync(tmp, `${JSON.stringify(body, null, 2)}\n`);
    io.renameSync(tmp, target);
  } catch (err) {
    // Best-effort: a failed write or rename must not litter the repo with
    // temp files.
    try {
      io.unlinkSync?.(tmp);
    } catch {
      /* the write/rename error is the one worth reporting */
    }
    throw err;
  }
}

/** Throws on an invalid name; propagates write/rename failures (read-only
 * checkout, permissions) so the caller can report them. */
export function writeProject(root: string, name: string, io: ProjectIo = defaultProjectIo): void {
  const result = validateProjectName(name);
  if (!result.ok) throw new Error(result.reason);
  writeProjectFile(root, { project: result.name }, io);
}

export function clearProject(root: string, io: ProjectIo = defaultProjectIo): void {
  writeProjectFile(root, {}, io);
}

/** The literal header pair, or `{}` when there is no valid project — so
 * spreading it leaves an unset request byte-identical to today. */
export function projectHeaders(project: string | undefined): Record<string, string> {
  if (!project) return {};
  const result = validateProjectName(project);
  return result.ok ? { [PROJECT_HEADER]: result.name } : {};
}

/** Session directory captured at session_start (resume/fork re-captures it).
 * Undefined before then: guessing cwd would attribute a request to the wrong
 * repo. */
let sessionRoot: string | undefined;

export function setSessionRoot(root: string | undefined): void {
  sessionRoot = root;
}

export function readSessionProject(io: ProjectIo = defaultProjectIo): string | undefined {
  return sessionRoot === undefined ? undefined : readProject(sessionRoot, io);
}
