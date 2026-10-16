import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { parse } from "yaml";

async function yaml(path) {
  return parse(await readFile(new URL(path, import.meta.url), "utf8"));
}

async function raw(path) {
  return readFile(new URL(path, import.meta.url), "utf8");
}

function externalStepActions(workflow) {
  return Object.values(workflow.jobs ?? {}).flatMap((job) => job.steps ?? [])
    .map((step) => step.uses).filter((value) => typeof value === "string" && !value.startsWith("./"));
}

function assertImmutableActions(workflow) {
  const actions = externalStepActions(workflow);
  assert.ok(actions.length > 0, "Workflow must use at least one external Action");
  for (const action of actions) {
    assert.match(action, /^[^@\s]+\/[^@\s]+@[0-9a-f]{40}$/, `Action must use a full commit SHA: ${action}`);
  }
}

function assertHardenedCheckout(workflow) {
  for (const [jobName, job] of Object.entries(workflow.jobs ?? {})) {
    if (!job.steps) continue;
    const checkouts = job.steps.filter((step) => step.uses?.startsWith("actions/checkout@"));
    if (checkouts.length === 0) continue;
    for (const checkout of checkouts) {
      assert.equal(
        checkout.with?.["persist-credentials"],
        false,
        `Every checkout in ${jobName} must disable credential persistence`,
      );
    }
  }
}

// Comments do not survive YAML compilation, so the version-comment rule is a
// text check: every SHA-pinned `uses:` line carries a trailing `# v...` comment.
async function assertVersionComments(path) {
  const text = await raw(path);
  const lines = text.split("\n");
  for (const line of lines) {
    const match = line.match(/uses:\s*[^\s]+@[0-9a-f]{40}/);
    if (match) {
      assert.match(line, /#[^#\n]*\bv/i, `SHA-pinned action must carry a version comment: ${line.trim()}`);
    }
  }
}

it("defines the check gate with least privilege", async () => {
  const workflow = await yaml("../.github/workflows/check.yml");
  assert.deepEqual(workflow.permissions, { contents: "read" });
  assert.deepEqual(workflow.on.push, { branches: ["main"] });
  assert.ok(Object.hasOwn(workflow.on, "pull_request"));
  assert.ok(workflow.concurrency, "check must cancel superseded runs");
  assert.equal(workflow.concurrency["cancel-in-progress"], true);
  const runs = JSON.stringify(workflow.jobs.check.steps);
  for (const command of ["npm ci", "npm run check", "node scripts/pack-assert.mjs"]) {
    assert.ok(runs.includes(command), `check must run: ${command}`);
  }
  assert.equal(workflow.jobs.check["timeout-minutes"], 15);
  const serialized = JSON.stringify(workflow);
  assert.doesNotMatch(serialized, /continue-on-error/i);
  assert.doesNotMatch(serialized, /\$\{\{\s*secrets\./);
  assertImmutableActions(workflow);
  assertHardenedCheckout(workflow);
  await assertVersionComments("../.github/workflows/check.yml");
});

it("publishes only from version tags, without cancellation and with metadata gates", async () => {
  const workflow = await yaml("../.github/workflows/publish.yml");
  assert.deepEqual(Object.keys(workflow.on).sort(), ["push"]);
  assert.deepEqual(workflow.on.push, { tags: ["v*"] });
  assert.deepEqual(workflow.permissions, { contents: "read", "id-token": "write" });
  assert.equal(workflow.concurrency, undefined, "a cancelled publish can consume a version: no concurrency on publish.yml");
  const steps = workflow.jobs.publish.steps;
  const releaseTag = steps.find((step) => (step.run ?? "").includes("scripts/release-tag.mjs"));
  const publish = steps.find((step) => (step.run ?? "").includes("npm publish"));
  assert.ok(releaseTag, "publish must run scripts/release-tag.mjs");
  assert.ok(publish, "publish must run npm publish");
  assert.ok(
    steps.indexOf(releaseTag) < steps.indexOf(publish),
    "release metadata must be validated before npm publish",
  );
  assert.equal(workflow.jobs.publish["timeout-minutes"], 15);
  const serialized = JSON.stringify(workflow);
  assert.doesNotMatch(serialized, /continue-on-error/i);
  assert.doesNotMatch(serialized, /\$\{\{\s*secrets\./);
  assert.doesNotMatch(serialized, /NPM_TOKEN/);
  assertImmutableActions(workflow);
  assertHardenedCheckout(workflow);
  await assertVersionComments("../.github/workflows/publish.yml");
});

it("notifies on a red main without write credentials in the gate", async () => {
  const workflow = await yaml("../.github/workflows/notify-red-main.yml");
  assert.deepEqual(workflow.permissions, { contents: "read", issues: "write" });
  assert.ok(workflow.jobs.notify.if.includes("failure"), "notify must fire on failure");
  assert.equal(workflow.jobs.notify["timeout-minutes"], 5);
  assertImmutableActions(workflow);
  assertHardenedCheckout(workflow);
  await assertVersionComments("../.github/workflows/notify-red-main.yml");
});

it("checks GitHub Action updates weekly", async () => {
  const config = await yaml("../.github/dependabot.yml");
  assert.equal(config.version, 2);
  assert.deepEqual(config.updates, [{
    "package-ecosystem": "github-actions",
    directory: "/",
    schedule: { interval: "weekly" },
  }]);
});
