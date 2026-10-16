import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// @ts-expect-error -- plain ESM script without type declarations
import { runGate, stripComments } from "../scripts/ci/assert-ci-safety.mjs";

/**
 * D3D-B1: adversarial tests for the CI safety gate. Runner metadata passes only by exact name and
 * trusted host; everything else that looks like an endpoint or a credential fails closed.
 */
const GATE = join(import.meta.dirname, "..", "scripts", "ci", "assert-ci-safety.mjs");
const HEAD = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
const dir = mkdtempSync(join(tmpdir(), "ci-gate-"));
let n = 0;
const workflowFile = (body: string) => { const file = join(dir, `wf-${++n}.yml`); writeFileSync(file, body); return file; };
const GOOD_WORKFLOW = `# Not pull_request_target; no \${{ secrets.X }} here: comments are ignored.
name: ok
on:
  pull_request:
permissions:
  contents: read
jobs:
  test:
    runs-on: ubuntu-latest
    services:
      postgres:
        env:
          POSTGRES_PASSWORD: \${{ github.run_id }}
    env:
      DATABASE_URL: postgresql://u:\${{ github.run_id }}@127.0.0.1:5432/db
    steps:
      - uses: actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683 # v4.2.2
      - run: echo "a # inside quotes is not a comment"
`;
const good = workflowFile(GOOD_WORKFLOW);
const RUNNER_ENV = {
  GITHUB_SERVER_URL: "https://github.com",
  GITHUB_API_URL: "https://api.github.com",
  GITHUB_GRAPHQL_URL: "https://api.github.com/graphql",
  GITHUB_REPOSITORY: "okoro0704-del/DDI",
  GITHUB_WORKSPACE: "/home/runner/work/DDI/DDI",
  RUNNER_TEMP: "/home/runner/work/_temp",
  ACTIONS_RESULTS_URL: "https://results-receiver.actions.githubusercontent.com/",
  ACTIONS_RUNTIME_TOKEN: "runner-issued",
  DDI_TEST_DATABASE_URL: "postgresql://d3_test:1@127.0.0.1:5432/ddi_test",
};
const runtime = (env: Record<string, string>, workflow = good, pins = [`.=${HEAD}`]) =>
  runGate(["--workflow", workflow, ...pins.flatMap((pin) => ["--pin", pin])], env).failures as string[];
const staticReview = (body: string) => runGate(["--static", "--workflow", workflowFile(body)], {}).failures as string[];
const fails = (failures: string[], pattern: RegExp) => assert.ok(failures.some((f) => pattern.test(f)), `expected ${pattern} in ${JSON.stringify(failures)}`);

describe("CI safety gate — runtime environment", () => {
  test("the runner's own metadata and loopback databases pass", () => {
    assert.deepEqual(runtime(RUNNER_ENV), []);
  });

  test("prefixes grant nothing: ACTIONS_*, GITHUB_* and RUNNER_* lookalikes fail", () => {
    fails(runtime({ ...RUNNER_ENV, ACTIONS_DB_PASSWORD: "hunter2" }), /ACTIONS_DB_PASSWORD looks like a credential/);
    fails(runtime({ ...RUNNER_ENV, ACTIONS_X: "https://evil.example" }), /ACTIONS_X points at non-loopback host evil\.example/);
    fails(runtime({ ...RUNNER_ENV, GITHUB_X: "https://evil.example/hook" }), /GITHUB_X points at non-loopback/);
    fails(runtime({ ...RUNNER_ENV, RUNNER_X: "postgresql://u:p@db.example.com/x" }), /RUNNER_X points at non-loopback/);
    fails(runtime({ ...RUNNER_ENV, GITHUB_TOKEN: "ghs_x" }), /GITHUB_TOKEN looks like a credential/);
    fails(runtime({ ...RUNNER_ENV, ACTIONS_CREDENTIALS: "x" }), /ACTIONS_CREDENTIALS looks like a credential/);
  });

  test("allowlisted runner URLs must point at their trusted host over https", () => {
    for (const value of [
      "https://evil.example",
      "https://api.github.com.evil.example",
      "https://api.github.com@evil.example",
      "https://user:pass@api.github.com",
      "http://api.github.com",
      "not a url",
    ]) fails(runtime({ ...RUNNER_ENV, GITHUB_API_URL: value }), /GITHUB_API_URL (points at an untrusted endpoint|is not a URL)/);
    fails(runtime({ ...RUNNER_ENV, ACTIONS_RESULTS_URL: "https://x.actions.githubusercontent.com.evil.net/" }), /ACTIONS_RESULTS_URL points at an untrusted endpoint/);
    fails(runtime({ ...RUNNER_ENV, GITHUB_SERVER_URL: "https://gateway-production-c3f9.up.railway.app" }), /GITHUB_SERVER_URL names a hosted endpoint/);
    assert.deepEqual(runtime({ ...RUNNER_ENV, ACTIONS_RUNTIME_URL: "https://pipelines.actions.githubusercontent.com/abc/" }), []);
  });

  test("endpoints must be loopback in every form; lookalikes fail", () => {
    for (const ok of ["postgresql://u@LOCALHOST:5432/x", "postgres://u@[::1]:5432/x", "http://127.0.0.1:8080"]) assert.deepEqual(runtime({ ...RUNNER_ENV, DB: ok }), [], ok);
    for (const bad of ["postgresql://u:p@db.prod.example:5432/x", "http://127.0.0.2:80", "http://localhost.evil.example", "mongodb+srv://cluster.example/db", "redis://cache.example:6379", "ok http://127.0.0.1 then https://evil.example"]) {
      fails(runtime({ ...RUNNER_ENV, DB: bad }), /DB points at non-loopback/);
    }
    fails(runtime({ ...RUNNER_ENV, NOTE: "see https://app.getlifeos.app" }), /NOTE names a hosted endpoint/);
  });

  test("every checkout must be at its full pinned commit", () => {
    fails(runtime(RUNNER_ENV, good, [`.=${"0".repeat(40)}`]), /expected 0{40}/);
    fails(runtime(RUNNER_ENV, good, [`.=${HEAD.slice(0, 7)}`]), /must be <dir>=<full 40-hex sha>/);
    fails(runtime(RUNNER_ENV, good, [`${dir}=${HEAD}`]), /is not a git checkout/);
    fails(runtime(RUNNER_ENV, good, []), /no --pin given/);
  });
});

describe("CI safety gate — workflow review", () => {
  test("the repository's cross-repository workflow passes the static review", () => {
    assert.deepEqual(runGate(["--static", "--workflow", join(import.meta.dirname, "..", ".github", "workflows", "d3-cross-repo-acceptance.yml")], {}).failures, []);
  });

  test("secrets are refused however they are written, including behind a quoted #", () => {
    for (const run of ['echo "${{ secrets.X }}"', 'echo " #" ${{ secrets.TOKEN }}', "echo '${{toJSON(secrets)}}'", 'echo "${{ secrets[\'X\'] }}"']) {
      fails(staticReview(GOOD_WORKFLOW.replace('echo "a # inside quotes is not a comment"', run)), /references secrets/);
    }
    fails(staticReview(GOOD_WORKFLOW.replace("    runs-on: ubuntu-latest\n", "    runs-on: ubuntu-latest\n    secrets: inherit\n")), /references secrets/);
  });

  test("privileged triggers, missing or write permissions, and unpinned actions are refused", () => {
    fails(staticReview(GOOD_WORKFLOW.replace("  pull_request:", "  pull_request_target:")), /privileged trigger pull_request_target/);
    fails(staticReview(GOOD_WORKFLOW.replace("  pull_request:", "  workflow_run:")), /privileged trigger workflow_run/);
    fails(staticReview(GOOD_WORKFLOW.replace("permissions:\n  contents: read\n", "")), /does not declare top-level read-only permissions/);
    fails(staticReview(GOOD_WORKFLOW.replace("  contents: read", "  contents: write")), /requests write permissions/);
    fails(staticReview(GOOD_WORKFLOW.replace("permissions:\n  contents: read", "permissions: write-all")), /permissions/);
    for (const use of ["actions/checkout@v4", "actions/checkout@11bd719", "./local-action", "docker://alpine:3"]) {
      fails(staticReview(GOOD_WORKFLOW.replace("actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683", use)), /is not pinned to a full commit SHA/);
    }
  });

  test("workflow assignments must be loopback, non-hosted, and credential-free", () => {
    const withEnv = (line: string) => GOOD_WORKFLOW.replace("      DATABASE_URL:", `      ${line}\n      DATABASE_URL:`);
    fails(staticReview(withEnv("PROD_DB: postgresql://u@db.prod.example:5432/x")), /PROD_DB points at non-loopback/);
    fails(staticReview(withEnv("MD_URL: https://gateway-production-c3f9.up.railway.app")), /MD_URL names a hosted endpoint/);
    fails(staticReview(withEnv("ACTIONS_DB_PASSWORD: hunter2")), /ACTIONS_DB_PASSWORD looks like a credential/);
    fails(staticReview(withEnv("API_KEY: ${{ github.event.pull_request.title }}")), /API_KEY looks like a credential/);
  });

  test("comments are stripped only outside quotes", () => {
    assert.equal(stripComments('run: echo "a # b" # tail'), 'run: echo "a # b" ');
    assert.equal(stripComments("key: 'x#y' # c"), "key: 'x#y' ");
    assert.equal(stripComments("# whole line"), "");
  });
});

describe("CI safety gate — command line", () => {
  const cli = (env: Record<string, string>, args: string[]) => spawnSync(process.execPath, [GATE, ...args], { env: { PATH: process.env.PATH ?? "", SYSTEMROOT: process.env.SYSTEMROOT ?? "", ...env }, encoding: "utf8" });

  test("exits 0 for a clean job and 1 with annotations for an adversarial one", () => {
    const ok = cli(RUNNER_ENV, ["--workflow", good, "--pin", `.=${HEAD}`]);
    assert.equal(ok.status, 0, ok.stderr);
    const bad = cli({ ...RUNNER_ENV, ACTIONS_X: "https://evil.example" }, ["--workflow", good, "--pin", `.=${HEAD}`]);
    assert.equal(bad.status, 1);
    assert.match(bad.stderr, /::error title=CI safety gate::ACTIONS_X points at non-loopback host evil\.example/);
  });
});
