import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { validateTagForm, validateVersions, validateSmokeLine, loadVersions } from "./release-tag.mjs";

describe("validateTagForm", () => {
  it("accepts bare and prerelease version tags", () => {
    assert.deepEqual(validateTagForm("v0.15.1"), []);
    assert.deepEqual(validateTagForm("v1.2.3-beta.1"), []);
  });

  it("rejects malformed tags", () => {
    assert.ok(validateTagForm("0.15.1").length > 0, "missing v prefix");
    assert.ok(validateTagForm("v0.15").length > 0, "missing patch");
    assert.ok(validateTagForm("release-v1.2.3").length > 0, "prefix junk");
    assert.ok(validateTagForm("v01.2.3").length > 0, "leading zero");
  });
});

describe("validateVersions", () => {
  it("accepts an agreeing set", () => {
    assert.deepEqual(
      validateVersions({ refName: "v0.15.1", packageVersion: "0.15.1", lockVersion: "0.15.1", lockRootVersion: "0.15.1" }),
      [],
    );
  });

  it("names the tag/package.json mismatch", () => {
    const errors = validateVersions({ refName: "v0.15.1", packageVersion: "0.15.0", lockVersion: "0.15.0", lockRootVersion: "0.15.0" });
    assert.ok(errors.some((e) => e.includes("tag version 0.15.1 != package.json version 0.15.0")));
  });

  it("names the lockfile mismatch", () => {
    const errors = validateVersions({ refName: "v0.15.1", packageVersion: "0.15.1", lockVersion: "0.15.0", lockRootVersion: "0.15.0" });
    assert.ok(errors.some((e) => e.includes('package-lock.json version 0.15.0 != package.json version 0.15.1')));
    assert.ok(errors.some((e) => e.includes('packages[""].version 0.15.0 != package.json version 0.15.1')));
  });

  it("reports every mismatch at once", () => {
    const errors = validateVersions({ refName: "bogus", packageVersion: "0.15.0", lockVersion: "0.14.0", lockRootVersion: "0.14.0" });
    assert.ok(errors.length >= 3, `expected tag form + tag/version + lock errors, got: ${errors.join("; ")}`);
  });
});

describe("validateSmokeLine", () => {
  it("accepts all-pass and exceptions with a date", () => {
    assert.deepEqual(validateSmokeLine("chore: release\n\nsmoke: 2026-10-16 all-pass\n"), []);
    assert.deepEqual(validateSmokeLine("chore: release\n\nsmoke: 2026-10-16 exceptions (browser OAuth deferred)\n"), []);
  });

  it("rejects missing, undated, and free-form lines", () => {
    assert.ok(validateSmokeLine("chore: release\n").length > 0, "missing line");
    assert.ok(validateSmokeLine("smoke: yesterday all-pass\n").length > 0, "non-ISO date");
    assert.ok(validateSmokeLine("smoke: 2026-10-16 done\n").length > 0, "unrecognized verdict");
  });
});

describe("repository state", () => {
  it("package.json and package-lock.json agree right now", async () => {
    const versions = await loadVersions(new URL("..", import.meta.url).pathname);
    assert.equal(versions.lockVersion, versions.packageVersion);
    assert.equal(versions.lockRootVersion, versions.packageVersion);
  });
});
