import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// @ts-expect-error -- plain ESM script without type declarations
import { parseWorkflowYaml, runGate, stripComments } from "../scripts/ci/assert-ci-safety.mjs";

/**
 * D3D-B1 adversarial tests for the CI safety gate. Each case applies one hostile edit to the real
 * cross-repository workflow (or its directory) and expects the gate to fail closed; the unchanged
 * workflow must pass. The gate never executes the files it reviews.
 */
const REPO = join(import.meta.dirname, "..");
const GATE = join(REPO, "scripts", "ci", "assert-ci-safety.mjs");
const HEAD = execFileSync("git", ["-C", REPO, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
const NAME = "d3-cross-repo-acceptance.yml";
const REAL = readFileSync(join(REPO, ".github", "workflows", NAME), "utf8").replace(/\r\n/g, "\n");
const SELF = readFileSync(join(REPO, ".github", "workflows", "ci-safety-gate.yml"), "utf8");

// Work in a private directory: the gate only accepts relative paths inside its working directory.
const work = mkdtempSync(join(tmpdir(), "ci-gate-"));
process.chdir(work);
let n = 0;
/** Writes a workflow under a fresh `case-N/.github/workflows/` and returns its relative path. */
const caseFile = (body: string, name = NAME) => {
  const dir = join(`case-${++n}`, ".github", "workflows");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), body);
  return `${dir.replace(/\\/g, "/")}/${name}`;
};
const edit = (from: string | RegExp, to: string) => {
  const out = REAL.replace(from, to);
  assert.notEqual(out, REAL, `test edit did not apply: ${from}`);
  return out;
};
const review = (body: string, name = NAME) => runGate(["--static", "--workflow", caseFile(body, name)], {}).failures as string[];
const fails = (failures: string[], pattern: RegExp) => assert.ok(failures.some((f) => pattern.test(f)), `expected ${pattern} in ${JSON.stringify(failures)}`);
const GATE_STEP = /      - name: Safety gate[\s\S]*?--pin elfcom=\$\{\{ env\.ELFCOM_SHA \}\}\n/;
const TRUSTED_REF = "${{ github.event.repository.default_branch }}";
const OLD_BASE_REF = "${{ github.event.pull_request.base.sha || github.sha }}";

const RUNNER_ENV = {
  GITHUB_SERVER_URL: "https://github.com",
  GITHUB_API_URL: "https://api.github.com",
  GITHUB_GRAPHQL_URL: "https://api.github.com/graphql",
  GITHUB_REPOSITORY: "okoro0704-del/DDI",
  RUNNER_TEMP: "/home/runner/work/_temp",
  ACTIONS_RESULTS_URL: "https://results-receiver.actions.githubusercontent.com/",
  ACTIONS_RUNTIME_TOKEN: "runner-issued",
  DDI_TEST_DATABASE_URL: "postgresql://d3_test:1@127.0.0.1:5432/ddi_test",
};
const realFile = caseFile(REAL);
const runtime = (env: Record<string, string>, pins = [`${REPO}=${HEAD}`]) =>
  runGate(["--workflow", realFile, ...pins.flatMap((pin) => ["--pin", pin])], env).failures as string[];

describe("runtime gate step is required, trusted and cannot be bypassed", () => {
  test("valid unchanged workflow passes", () => {
    assert.deepEqual(review(REAL), []);
  });

  test("gate step removed", () => {
    fails(review(edit(GATE_STEP, "")), /gate step must run trusted-gate\/scripts\/ci\/assert-ci-safety\.mjs/);
  });

  test("gate renamed: a different trusted directory or script fails; only the display name is free", () => {
    fails(review(REAL.replaceAll("trusted-gate", "gate-two")), /exactly one checkout must use path 'trusted-gate'/);
    fails(review(edit("node trusted-gate/scripts/ci/assert-ci-safety.mjs", "node trusted-gate/scripts/ci/safety.mjs")), /gate step must run/);
    assert.deepEqual(review(edit("- name: Safety gate (trusted copy;", "- name: Renamed gate (trusted copy;")), [], "a display-name change keeps every structural guarantee");
  });

  test("gate disabled: if, continue-on-error, shell, working-directory, defaults, job if, || true, early exit", () => {
    const at = "        run: |\n          if [ ! -f trusted-gate";
    fails(review(edit(at, `        if: \${{ false }}\n${at}`)), /gate step may not set if/);
    fails(review(edit(at, `        continue-on-error: true\n${at}`)), /gate step may not set continue-on-error/);
    fails(review(edit(at, `        shell: python {0}\n${at}`)), /gate step may not set shell/);
    fails(review(edit(at, `        working-directory: ddi\n${at}`)), /gate step may not set working-directory/);
    fails(review(edit("jobs:\n", "defaults:\n  run:\n    working-directory: ddi\njobs:\n")), /workflow 'defaults' are not allowed/);
    fails(review(edit("    runs-on: ubuntu-latest", "    if: false\n    runs-on: ubuntu-latest")), /'if' is not allowed/);
    fails(review(edit("--pin elfcom=${{ env.ELFCOM_SHA }}\n", "--pin elfcom=${{ env.ELFCOM_SHA }} || true\n")), /unexpected gate argument/);
    fails(review(edit("          node trusted-gate/scripts", "          exit 0\n          node trusted-gate/scripts")), /gate step must run/);
  });

  test("gate redirected to the pull request head, a fork, or a second trusted-gate checkout", () => {
    fails(review(edit(`ref: ${TRUSTED_REF}`, "ref: ${{ github.event.pull_request.head.sha }}")), /must check out the default branch/);
    fails(review(edit(`ref: ${TRUSTED_REF}`, `ref: ${TRUSTED_REF}\n          repository: attacker/DDI`)), /may set only ref, path, sparse-checkout and persist-credentials/);
    fails(review(edit("          path: ddi\n", "          path: trusted-gate\n")), /exactly one checkout must use path 'trusted-gate'/);
  });

  test("trusted default-branch ref replaced, including by the former base-commit ref", () => {
    fails(review(edit(`ref: ${TRUSTED_REF}`, `ref: ${OLD_BASE_REF}`)), /must check out the default branch/);
    fails(review(edit(`ref: ${TRUSTED_REF}`, "ref: ${{ github.sha }}")), /must check out the default branch/);
    fails(review(edit(`ref: ${TRUSTED_REF}`, `ref: ${HEAD}`)), /must check out the default branch/);
    fails(review(edit("sparse-checkout: scripts/ci", "sparse-checkout: scripts")), /must be sparse on scripts\/ci/);
  });

  test("trusted script path replaced with a pull-request path", () => {
    fails(review(REAL.replace(/(if \[ ! -f |node )trusted-gate\/scripts/g, "$1ddi/scripts")), /gate step must run/);
    fails(review(edit(`--workflow ddi/.github/workflows/${NAME}`, "--workflow ddi/.github/workflows/other.yml")), /gate must review this workflow/);
  });

  test("nothing may run before the gate or hijack the interpreter", () => {
    fails(review(edit("      # The gate runs from the default", "      - run: cp evil.mjs trusted-gate/scripts/ci/assert-ci-safety.mjs\n      # The gate runs from the default")), /only pinned checkout and setup-node steps may come before the gate|gate step must run/);
    fails(review(edit("env:\n  PORTAL_SHA:", "env:\n  NODE_OPTIONS: --require ./ddi/evil.js\n  PORTAL_SHA:")), /NODE_OPTIONS can change what the gate runs/);
    fails(review(edit("    env:\n      NODE_ENV: test", "    env:\n      BASH_ENV: ddi/evil.sh\n      NODE_ENV: test")), /BASH_ENV can change what the gate runs/);
    fails(review(edit("    runs-on: ubuntu-latest", "    runs-on: ubuntu-latest\n    container: attacker/node")), /'container' is not allowed/);
    fails(review(edit("          node-version: 22", "          node-version: 22\n          node-version-file: ddi/.nvmrc")), /setup-node before the gate may set only node-version/);
  });

  test("service containers (which start before any step) cannot reach the workspace", () => {
    const image = /image: postgres:16-alpine@sha256:[0-9a-f]{64}/;
    fails(review(edit(image, "image: attacker/rewriter:latest")), /only the digest-pinned postgres:16-alpine image/);
    fails(review(edit("        options: >-", "        volumes:\n          - /home/runner/work:/w\n        options: >-")), /may not set volumes/);
    fails(review(edit("--health-retries 12", "--health-retries 12 -v /home/runner/work:/w")), /options may only set --health-\* checks/);
    fails(review(edit("--health-retries 12", "--health-retries 12 --privileged")), /options may only set --health-\* checks/);
  });

  test("external checkouts come only from approved repositories", () => {
    fails(review(edit("repository: okoro0704-del/MasternDistribution", "repository: attacker/MasternDistribution")), /not an approved dependency/);
  });

  test("pins must cover every external checkout", () => {
    fails(review(edit("--pin trustid=${{ env.TRUSTID_SHA }} \\\n", "")), /gate must pin checkout 'trustid'|pins must match/);
    fails(review(edit("ref: ${{ env.MD_SHA }}", "ref: main")), /external checkouts must use ref/);
  });

  test("unsupported YAML is refused rather than guessed", () => {
    fails(review(edit("on:\n", "on: &triggers\n")), /not in the supported workflow syntax/);
    // Even on a free-text field, anchors and aliases are refused rather than read as plain text.
    fails(review(edit("- name: Safety gate (trusted copy;", "- name: &label Safety gate (trusted copy;")), /anchors, aliases, tags/);
    fails(review(edit("- name: Safety gate (trusted copy;", "- name: *label Safety gate (trusted copy;")), /anchors, aliases, tags/);
    fails(review(REAL.replace(/^on:\n[\s\S]*?\n(?=permissions:)/m, "on: { pull_request: {} }\n")), /not in the supported workflow syntax/);
    fails(review(edit("permissions:\n  contents: read\n", "permissions:\n  contents: read\npermissions:\n  contents: read\n")), /duplicate or forbidden key/);
    fails(review(edit("    runs-on: ubuntu-latest", "\truns-on: ubuntu-latest")), /tab indentation/);
  });

  test("workflows pull requests cannot trigger only need to parse and avoid privileged triggers", () => {
    const push = "name: push\non:\n  push:\njobs:\n  x:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n";
    assert.deepEqual(review(push, "push.yml"), []);
    fails(review(push.replace("  push:", "  pull_request_target:"), "push.yml"), /privileged trigger pull_request_target/);
    fails(review(push.replace("  push:", "  push:\n  pull_request:"), "push.yml"), /runtime safety gate step is missing|not pinned/);
  });
});

describe("workflow paths are never followed or escaped", () => {
  const tree = (files: Record<string, string>) => {
    const root = `tree-${++n}`;
    const dir = join(root, ".github", "workflows");
    mkdirSync(dir, { recursive: true });
    for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body);
    return { root, dir: `${root}/.github/workflows` };
  };
  const scan = (dir: string, extra: string[] = []) => runGate(["--static", "--workflows-dir", dir, "--exclude", "ci-safety-gate.yml", "--require", NAME, ...extra], {}).failures as string[];

  test("a valid workflows directory passes, including the unchanged trusted review", () => {
    const { dir } = tree({ [NAME]: REAL, "ci-safety-gate.yml": SELF });
    const self = tree({ "ci-safety-gate.yml": SELF });
    assert.deepEqual(scan(dir, ["--self", `${self.dir}/ci-safety-gate.yml`]), []);
  });

  test("symlinked workflow file", () => {
    const { dir } = tree({ "real.yml": REAL });
    symlinkSync("real.yml", join(dir, NAME), "file");
    fails(scan(dir), new RegExp(`${NAME} is a symlink`));
    fails(runGate(["--static", "--workflow", `${dir}/${NAME}`], {}).failures, /is a symlink/);
  });

  test("symlinked directory component", () => {
    const { root } = tree({ [NAME]: REAL });
    const linked = `linked-${++n}`;
    mkdirSync(linked);
    symlinkSync(join(work, root, ".github"), join(linked, ".github"), "junction");
    fails(scan(`${linked}/.github/workflows`), /'\.github' is a symlink/);
    fails(runGate(["--static", "--workflow", `${linked}/.github/workflows/${NAME}`], {}).failures, /'\.github' is a symlink/);
  });

  test("path traversal and absolute paths", () => {
    const { dir } = tree({ [NAME]: REAL });
    fails(scan(`${dir}/../workflows`), /'\.\.' path components are not allowed/);
    fails(scan(`../${dir}`), /'\.\.' path components are not allowed/);
    fails(runGate(["--static", "--workflow", join(work, dir, NAME)], {}).failures, /absolute/);
    fails(runGate(["--static", "--workflow", `${dir}//${NAME}`], {}).failures, /empty or '\.\.' path components/);
  });

  test("unexpected file types and names", () => {
    const { dir } = tree({ [NAME]: REAL, "notes.txt": "x" });
    mkdirSync(join(dir, "nested"));
    const failures = scan(dir);
    fails(failures, /notes\.txt is not an expected workflow file name/);
    fails(failures, /nested is not a regular file/);
  });

  test("the required workflow and the trusted review cannot be removed or changed", () => {
    const self = tree({ "ci-safety-gate.yml": SELF });
    const missing = tree({ "ci-safety-gate.yml": SELF });
    fails(scan(missing.dir, ["--self", `${self.dir}/ci-safety-gate.yml`]), new RegExp(`${NAME} is required and missing`));
    const changed = tree({ [NAME]: REAL, "ci-safety-gate.yml": `${SELF}\n# tampered\n` });
    fails(scan(changed.dir, ["--self", `${self.dir}/ci-safety-gate.yml`]), /changes the trusted safety review/);
    const removed = tree({ [NAME]: REAL });
    fails(scan(removed.dir, ["--self", `${self.dir}/ci-safety-gate.yml`]), /removes the trusted safety review/);
  });
});

describe("removals are judged against the pull request's base (D3D-A security closure)", () => {
  const tree = (files: Record<string, string>) => {
    const root = `base-${++n}`;
    const dir = join(root, ".github", "workflows");
    mkdirSync(dir, { recursive: true });
    for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body);
    return `${root}/.github/workflows`;
  };
  const trusted = tree({ "ci-safety-gate.yml": SELF });
  const PUSH = readFileSync(join(REPO, ".github", "workflows", "ddi-postgres-verification.yml"), "utf8");
  const judge = (pr: string, base: string) =>
    runGate(["--static", "--workflows-dir", pr, "--base-workflows-dir", base, "--exclude", "ci-safety-gate.yml", "--require", NAME, "--self", `${trusted}/ci-safety-gate.yml`], {}).failures as string[];

  test("a branch that predates the gate: neither the required workflow nor the trusted review is demanded", () => {
    const base = tree({ "ddi-postgres-verification.yml": PUSH });
    assert.deepEqual(judge(tree({ "ddi-postgres-verification.yml": PUSH }), base), []);
    assert.deepEqual(judge(tree({ "ddi-postgres-verification.yml": PUSH }), `missing-${++n}/.github/workflows`), [], "a base without workflows has nothing to remove");
  });

  test("what the base has cannot be removed", () => {
    const base = tree({ [NAME]: REAL, "ci-safety-gate.yml": SELF });
    fails(judge(tree({ "ci-safety-gate.yml": SELF }), base), new RegExp(`${NAME} is required and missing \\(the base has it\\)`));
    fails(judge(tree({ [NAME]: REAL }), base), /removes the trusted safety review/);
    assert.deepEqual(judge(tree({ [NAME]: REAL, "ci-safety-gate.yml": SELF }), base), []);
  });

  test("a pull request that adds the trusted review must add the trusted copy, whatever the base", () => {
    const base = tree({ "ddi-postgres-verification.yml": PUSH });
    fails(judge(tree({ [NAME]: REAL, "ci-safety-gate.yml": `${SELF}\n# tampered\n` }), base), /changes the trusted safety review/);
    assert.deepEqual(judge(tree({ [NAME]: REAL, "ci-safety-gate.yml": SELF, "ddi-postgres-verification.yml": PUSH }), base), []);
  });

  test("the base directory is read as safely as the pull request's", () => {
    const real = tree({ [NAME]: REAL });
    const linked = `linked-base-${++n}`;
    mkdirSync(linked);
    symlinkSync(join(work, real.split("/")[0], ".github"), join(linked, ".github"), "junction");
    fails(judge(tree({ [NAME]: REAL }), `${linked}/.github/workflows`), /base workflows directory: .*'\.github' is a symlink/);
    fails(runGate(["--static", "--base-workflows-dir", real, "--workflow", `${real}/${NAME}`], {}).failures, /--base-workflows-dir needs --workflows-dir/);
  });

  test("the repository's own workflows pass the trusted review", () => {
    const own = tree({ [NAME]: REAL, "ci-safety-gate.yml": SELF, "ddi-postgres-verification.yml": PUSH });
    assert.deepEqual(judge(own, own), []);
  });
});

describe("nothing in a pull request can report under the trusted review's name", () => {
  const dir = (files: Record<string, string>) => {
    const root = `names-${++n}`;
    const at = join(root, ".github", "workflows");
    mkdirSync(at, { recursive: true });
    for (const [name, body] of Object.entries(files)) writeFileSync(join(at, name), body);
    return `${root}/.github/workflows`;
  };
  const trusted = dir({ "ci-safety-gate.yml": SELF });
  const scan = (files: Record<string, string>) =>
    runGate(["--static", "--workflows-dir", dir({ ...files, "ci-safety-gate.yml": SELF }), "--exclude", "ci-safety-gate.yml", "--self", `${trusted}/ci-safety-gate.yml`], {}).failures as string[];
  const push = (job: string, extra = "") =>
    `name: push\non:\n  push:\n${extra}jobs:\n${job}    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683\n`;

  test("an ordinary push workflow passes", () => {
    assert.deepEqual(scan({ "push.yml": push("  build:\n") }), []);
  });

  test("a job id or display name equal to the trusted check, in any case, fails", () => {
    fails(scan({ "push.yml": push("  ddi-trusted-ci-review:\n") }), /would publish a check named like the trusted review \(ddi-trusted-ci-review\)/);
    fails(scan({ "push.yml": push("  build:\n    name: DDI-Trusted-CI-Review\n") }), /would publish a check named like the trusted review \(DDI-Trusted-CI-Review\)/);
  });

  test("job names cannot be computed", () => {
    fails(scan({ "push.yml": push("  build:\n    name: ${{ github.event.inputs.label }}\n") }), /job names may not use expressions/);
  });

  test("no workflow may grant checks or statuses write", () => {
    fails(scan({ "push.yml": push("  build:\n", "permissions:\n  statuses: write\n") }), /grants checks or statuses write/);
    fails(scan({ "push.yml": push("  build:\n    permissions:\n      checks: write\n") }), /grants checks or statuses write/);
    fails(scan({ "push.yml": push("  build:\n", "permissions: write-all\n") }), /grants checks or statuses write/);
  });
});

describe("runtime environment (unchanged guarantees)", () => {
  test("the runner's own metadata and loopback databases pass", () => {
    assert.deepEqual(runtime(RUNNER_ENV), []);
  });

  test("prefixes grant nothing; allowlisted runner URLs are host-pinned", () => {
    fails(runtime({ ...RUNNER_ENV, ACTIONS_DB_PASSWORD: "hunter2" }), /ACTIONS_DB_PASSWORD looks like a credential/);
    fails(runtime({ ...RUNNER_ENV, ACTIONS_X: "https://evil.example" }), /ACTIONS_X points at non-loopback host evil\.example/);
    fails(runtime({ ...RUNNER_ENV, GITHUB_TOKEN: "ghs_x" }), /GITHUB_TOKEN looks like a credential/);
    for (const value of ["https://evil.example", "https://api.github.com.evil.example", "https://api.github.com@evil.example", "https://user:pass@api.github.com", "http://api.github.com"]) {
      fails(runtime({ ...RUNNER_ENV, GITHUB_API_URL: value }), /GITHUB_API_URL points at an untrusted endpoint/);
    }
    fails(runtime({ ...RUNNER_ENV, DB: "postgresql://u:p@db.prod.example:5432/x" }), /DB points at non-loopback/);
    fails(runtime({ ...RUNNER_ENV, NOTE: "see https://app.getlifeos.app" }), /NOTE names a hosted endpoint/);
  });

  test("every checkout must be at its full pinned commit", () => {
    fails(runtime(RUNNER_ENV, [`${REPO}=${"0".repeat(40)}`]), /expected 0{40}/);
    fails(runtime(RUNNER_ENV, [`${REPO}=${HEAD.slice(0, 7)}`]), /must be <dir>=<full 40-hex sha>/);
    fails(runtime(RUNNER_ENV, []), /no --pin given/);
  });

  test("secrets in any spelling, including behind a quoted #", () => {
    for (const run of ['echo "${{ secrets.X }}"', 'echo " #" ${{ secrets.TOKEN }}', "echo '${{toJSON(secrets)}}'"]) {
      fails(review(edit("          node --input-type=module -e \"", `          ${run}\n          node --input-type=module -e "`)), /references secrets/);
    }
  });

  test("helpers: comments stripped only outside quotes; the parser reads the real workflow", () => {
    assert.equal(stripComments('run: echo "a # b" # tail'), 'run: echo "a # b" ');
    const doc = parseWorkflowYaml(REAL);
    assert.equal(doc.jobs.acceptance.steps[6].with.ref, TRUSTED_REF);
  });
});

describe("command line", () => {
  test("exits 0 for the clean job and 1 with annotations for an adversarial one", () => {
    const cli = (env: Record<string, string>) => spawnSync(process.execPath, [GATE, "--workflow", realFile, "--pin", `${REPO}=${HEAD}`], { cwd: work, env: { PATH: process.env.PATH ?? "", SYSTEMROOT: process.env.SYSTEMROOT ?? "", ...env }, encoding: "utf8" });
    const ok = cli(RUNNER_ENV);
    assert.equal(ok.status, 0, ok.stderr);
    const bad = cli({ ...RUNNER_ENV, ACTIONS_X: "https://evil.example" });
    assert.equal(bad.status, 1);
    assert.match(bad.stderr, /::error title=CI safety gate::ACTIONS_X points at non-loopback host evil\.example/);
  });
});
