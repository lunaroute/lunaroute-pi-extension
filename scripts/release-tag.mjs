#!/usr/bin/env node
// Release metadata gate, run by publish.yml before `npm publish`.
// Shape ported from lunadesktop/scripts/release-tag.mjs: fails closed and
// names every mismatch. Validates, for a v* tag push:
//   1. the tag is a bare version tag (v<major.minor.patch> with optional prerelease);
//   2. the tag's version equals package.json#version exactly;
//   3. package-lock.json's version fields equal package.json#version;
//   4. the tagged commit's message carries a smoke line:
//      `smoke: <YYYY-MM-DD> <all-pass|exceptions>[ note...]`
//      (docs/smoke-checklist.md defines what the line asserts).
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const TAG = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-[0-9A-Za-z.-]+)?$/;
const SMOKE = /^smoke: (\d{4}-\d{2}-\d{2}) (all-pass|exceptions)(?:\s+.*)?$/m;

export function validateTagForm(refName) {
  if (!TAG.test(refName)) {
    return [`tag ${JSON.stringify(refName)} must match vX.Y.Z with an optional prerelease suffix`];
  }
  return [];
}

export function validateVersions({ refName, packageVersion, lockVersion, lockRootVersion }) {
  const errors = validateTagForm(refName);
  const tagVersion = refName.replace(/^v/, "");
  if (tagVersion !== packageVersion) {
    errors.push(`tag version ${tagVersion} != package.json version ${packageVersion}`);
  }
  if (lockVersion !== packageVersion) {
    errors.push(`package-lock.json version ${lockVersion} != package.json version ${packageVersion}`);
  }
  if (lockRootVersion !== undefined && lockRootVersion !== packageVersion) {
    errors.push(`package-lock.json packages[""].version ${lockRootVersion} != package.json version ${packageVersion}`);
  }
  return errors;
}

export function validateSmokeLine(message) {
  const match = message.match(SMOKE);
  if (!match) {
    return [
      'tagged commit message must carry a smoke line: "smoke: <YYYY-MM-DD> <all-pass|exceptions>" — see docs/smoke-checklist.md',
    ];
  }
  return [];
}

export async function loadVersions(rootDir) {
  const packageJson = JSON.parse(await readFile(resolve(rootDir, "package.json"), "utf8"));
  const lock = JSON.parse(await readFile(resolve(rootDir, "package-lock.json"), "utf8"));
  return {
    packageVersion: packageJson.version,
    lockVersion: lock.version,
    lockRootVersion: lock.packages?.[""]?.version,
  };
}

export function taggedCommitMessage() {
  return execFileSync("git", ["log", "-1", "--pretty=%B"], { encoding: "utf8" });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const refName = process.env.GITHUB_REF_NAME;
  if (!refName) throw new Error("GITHUB_REF_NAME is required");
  const versions = await loadVersions(process.cwd());
  const errors = [
    ...validateVersions({ refName, ...versions }),
    ...validateSmokeLine(taggedCommitMessage()),
  ];
  if (errors.length > 0) {
    console.error(`Release metadata failed validation:`);
    for (const error of errors) console.error(`  - ${error}`);
    process.exit(1);
  }
  console.log(`Release metadata OK: ${refName} matches package.json@${versions.packageVersion}, smoke line present.`);
}
