#!/usr/bin/env node
// Asserts the npm tarball contains exactly: every git-tracked src/**/*.ts,
// plus package.json, README.md, and LICENSE, and nothing else.
// A new tracked source file therefore passes with no workflow edit, and a
// leak under tests/ or an unexpected extra file fails the check by name.
import { execFileSync } from "node:child_process";

const ALWAYS_PACKED = ["LICENSE", "README.md", "package.json"];

function trackedExpected() {
  const out = execFileSync("git", ["ls-files"], { encoding: "utf8" });
  const tracked = out.split("\n").filter(Boolean);
  const sources = tracked.filter((p) => p.startsWith("src/") && p.endsWith(".ts"));
  const extras = ALWAYS_PACKED.filter((p) => tracked.includes(p));
  return new Set([...sources, ...extras]);
}

function packedFiles() {
  const out = execFileSync("npm", ["pack", "--dry-run", "--json"], { encoding: "utf8" });
  let parsed;
  try {
    parsed = JSON.parse(out);
  } catch {
    // npm occasionally prefixes the JSON with notices; find the array.
    const start = out.indexOf("[");
    const end = out.lastIndexOf("]");
    if (start === -1 || end === -1) throw new Error("npm pack --json produced no parseable output");
    parsed = JSON.parse(out.slice(start, end + 1));
  }
  const files = parsed?.[0]?.files;
  if (!Array.isArray(files)) throw new Error("npm pack --json output has no files array");
  return new Set(files.map((f) => f.path).filter((p) => !p.endsWith("/")));
}

const expected = trackedExpected();
const actual = packedFiles();

const missing = [...expected].filter((p) => !actual.has(p)).sort();
const unexpected = [...actual].filter((p) => !expected.has(p)).sort();
const leakedTests = [...actual].filter((p) => p.startsWith("tests/")).sort();

if (missing.length > 0) {
  console.error(`ERROR: expected files missing from the packed tarball:\n  ${missing.join("\n  ")}`);
}
if (unexpected.length > 0) {
  console.error(`ERROR: unexpected files in the packed tarball:\n  ${unexpected.join("\n  ")}`);
  console.error("If a non-src file is deliberately packed, update scripts/pack-assert.mjs.");
}
if (leakedTests.length > 0) {
  console.error(`ERROR: tests/ files leaked into the packed tarball:\n  ${leakedTests.join("\n  ")}`);
}

if (missing.length + unexpected.length + leakedTests.length > 0) process.exit(1);
console.log(`OK: ${expected.size} files, no tests.`);
