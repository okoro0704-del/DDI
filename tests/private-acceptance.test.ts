import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
// @ts-expect-error -- plain ESM script without type declarations
import { parseWorkflowYaml, RESERVED_CHECK_NAMES } from "../scripts/ci/assert-ci-safety.mjs";
// @ts-expect-error -- plain ESM script without type declarations
import { CHECK_NAME, reviewPrivateAcceptance, runReview } from "../scripts/ci/assert-private-acceptance.mjs";

/**
 * Stage 5C adversarial tests for the private acceptance runner. Static cases apply one hostile edit to
 * the real template and expect the review to fail closed; the unchanged template passes. Behaviour
 * cases run the template's own trusted scripts (resolve, archive, verify, credential check, report)
 * against local fixtures, with `gh` replaced and git confined to local repositories: no network, no
 * GitHub, no credential.
 */
const REPO = join(import.meta.dirname, "..");
const TEMPLATE_PATH = join(REPO, "docs", "ci", "private-acceptance", "ddi-private-acceptance.yml");
const PUBLIC_PATH = join(REPO, ".github", "workflows", "d3-cross-repo-acceptance.yml");
const TEMPLATE = readFileSync(TEMPLATE_PATH, "utf8").replace(/\r\n/g, "\n");
const PUBLIC = readFileSync(PUBLIC_PATH, "utf8").replace(/\r\n/g, "\n");
const DOC = parseWorkflowYaml(TEMPLATE);
const PINS = { ...DOC.env } as Record<string, string>;

const review = (body: string, pub: string = PUBLIC) => reviewPrivateAcceptance(body, pub) as string[];
const fails = (failures: string[], pattern: RegExp) => assert.ok(failures.some((f) => pattern.test(f)), `expected ${pattern} in ${JSON.stringify(failures)}`);
const edit = (from: string, to: string) => {
  const out = TEMPLATE.replace(from, to);
  assert.notEqual(out, TEMPLATE, `test edit did not apply: ${from}`);
  return out;
};
const ACC_ENV = "    env:\n      HEAD_SHA: ${{ needs.resolve.outputs.head_sha }}\n";
const ARCHIVE_LINE = "          echo \"archive_sha256=$(sha256sum portal.tar.gz | cut -d' ' -f1)\" >> \"$GITHUB_OUTPUT\"\n";
const REPORT_START = "          conclusion=failure\n";
const ELFCOM_FETCH = '          fetch https://github.com/okoro0704-del/elfCOM.git "$ELFCOM_SHA" elfcom\n';

// ---- behaviour harness: the template's scripts, run by bash in private directories ----------------
const BASH = process.platform === "win32" ? ["C:\\Program Files\\Git\\usr\\bin\\bash.exe", "C:\\Program Files\\Git\\bin\\bash.exe"].find(existsSync) : "bash";
const noBash = BASH ? false : "Git Bash is not installed";
const work = mkdtempSync(join(tmpdir(), "private-acceptance-"));
let n = 0;
const fresh = (label: string) => { const dir = join(work, `${label}-${++n}`); mkdirSync(dir, { recursive: true }); return dir; };
const write = (path: string, body: string) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, body); };
const GIT_ENV = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", HOME: work, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@invalid" };
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, env: GIT_ENV, encoding: "utf8" }).trim();
const commitAll = (cwd: string, message: string) => { git(cwd, "add", "-A", "-f"); git(cwd, "commit", "-q", "-m", message); return git(cwd, "rev-parse", "HEAD"); };

/** A fake `gh` on PATH: records its arguments, prints the configured pull-request fields. */
const bin = fresh("bin");
writeFileSync(join(bin, "gh"), "#!/usr/bin/env bash\nprintf '%s\\n' \"$@\" >> \"$GH_LOG\"\n[ -z \"${FAKE_PR_FIELDS:-}\" ] || printf '%s\\n' \"$FAKE_PR_FIELDS\"\n", { mode: 0o755 });
const script = (job: string, name: RegExp) => {
  const step = DOC.jobs[job].steps.find((s: { name?: string; run?: string }) => s.run !== undefined && name.test(s.name ?? ""));
  assert.ok(step, `no ${name} step in ${job}`);
  return String(step.run);
};
const run = (body: string, cwd: string, env: Record<string, string>) => {
  const r = spawnSync(BASH as string, ["--noprofile", "--norc", "-c", body], {
    cwd, encoding: "utf8",
    env: { PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`, SYSTEMROOT: process.env.SYSTEMROOT ?? "", HOME: work, GIT_CONFIG_NOSYSTEM: "1", ...env },
  });
  return { status: r.status, text: `${r.stdout}${r.stderr}` };
};

/** A local stand-in for okoro0704-del/DDI: `master` (base) and a candidate head one commit ahead. */
function ddiOrigin({ pub = PUBLIC, template = TEMPLATE as string | null, behind = false } = {}) {
  const origin = fresh("ddi-origin");
  git(origin, "init", "-q", "-b", "master");
  git(origin, "config", "uploadpack.allowAnySHA1InWant", "true");
  write(join(origin, ".github", "workflows", "d3-cross-repo-acceptance.yml"), pub);
  if (template !== null) write(join(origin, "docs", "ci", "private-acceptance", "ddi-private-acceptance.yml"), template);
  commitAll(origin, "base");
  git(origin, "checkout", "-q", "-b", "candidate");
  write(join(origin, "candidate.txt"), "candidate\n");
  const head = commitAll(origin, "candidate");
  git(origin, "checkout", "-q", "master");
  if (behind) { write(join(origin, "later.txt"), "later\n"); commitAll(origin, "later"); }
  return { origin: origin.replace(/\\/g, "/"), head };
}

function resolve(fixture: { origin: string; head: string }, { env = {} as Record<string, string>, runner = TEMPLATE } = {}) {
  const cwd = fresh("resolve");
  write(join(cwd, "runner", ".github", "workflows", "ddi-private-acceptance.yml"), runner);
  const output = join(cwd, "github-output");
  writeFileSync(output, "");
  const r = run(script("resolve", /^Resolve/), cwd, {
    GH_LOG: join(cwd, "gh.log"), GITHUB_OUTPUT: output, GH_TOKEN: "test-not-a-token",
    REF: "refs/heads/main", PR: "11", HEAD_SHA: fixture.head, BASE: "master",
    FAKE_PR_FIELDS: ["open", "okoro0704-del/DDI", "master", fixture.head].join("\t"),
    // Every fetch of github.com/okoro0704-del/DDI goes to the local stand-in; any other remote is refused.
    GIT_ALLOW_PROTOCOL: "file", GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: `url.${fixture.origin}.insteadOf`, GIT_CONFIG_VALUE_0: "https://github.com/okoro0704-del/DDI.git",
    ...PINS, ...env,
  });
  return { ...r, outputs: readFileSync(output, "utf8") };
}

/** A local Portal repository: one commit, including a force-added file under an ignored directory. */
function portalOrigin() {
  const dir = fresh("portal-origin");
  git(dir, "init", "-q", "-b", "main");
  write(join(dir, "package.json"), '{ "name": "portal-fixture" }\n');
  write(join(dir, "apps", "portal-api", "index.ts"), "export const ok = true;\n");
  write(join(dir, ".gitignore"), "dist/\n");
  write(join(dir, "dist", "kept.js"), "export {};\n");
  const sha = commitAll(dir, "portal");
  return { dir, sha, tree: git(dir, "rev-parse", "HEAD^{tree}") };
}

function archive(portal: { dir: string; sha: string; tree: string }, env: Record<string, string> = {}) {
  const cwd = fresh("fetch-portal");
  git(cwd, "clone", "-q", portal.dir, "portal");
  const output = join(cwd, "github-output");
  writeFileSync(output, "");
  const r = run(script("fetch-portal", /^Archive/), cwd, { GITHUB_OUTPUT: output, PORTAL_SHA: portal.sha, PORTAL_TREE: portal.tree, ...env });
  return { ...r, file: join(cwd, "portal.tar.gz"), digest: /archive_sha256=([0-9a-f]{64})/.exec(readFileSync(output, "utf8"))?.[1] ?? "" };
}

function verify(file: string, digest: string, portal: { sha: string; tree: string }) {
  const cwd = fresh("verify");
  mkdirSync(join(cwd, "portal-archive"));
  copyFileSync(file, join(cwd, "portal-archive", "portal.tar.gz"));
  return { ...run(script("acceptance", /^Verify the Portal archive/), cwd, { PORTAL_ARCHIVE_SHA256: digest, PORTAL_TREE: portal.tree, PORTAL_SHA: portal.sha }), cwd };
}

/** Repacks a verified archive after `change` runs in its extracted tree; returns the new file and digest. */
function repack(file: string, change: string) {
  const cwd = fresh("repack");
  copyFileSync(file, join(cwd, "source.tar.gz")); // relative paths: tar reads "C:" as a remote host
  const r = run(`set -euo pipefail\ntar -xzf source.tar.gz\n${change}\ntar -czf tampered.tar.gz portal`, cwd, {});
  assert.equal(r.status, 0, r.text);
  const out = join(cwd, "tampered.tar.gz");
  return { file: out, digest: createHash("sha256").update(readFileSync(out)).digest("hex") };
}

function report(fetch: string, acceptance: string, env: Record<string, string> = {}) {
  const cwd = fresh("report");
  const log = join(cwd, "gh.log");
  const r = run(script("report", /^Report/), cwd, {
    GH_LOG: log, GH_TOKEN: "test-not-a-token", GITHUB_STEP_SUMMARY: join(cwd, "summary"),
    PR: "11", BASE: "master", HEAD_SHA: "a".repeat(40), BASE_SHA: "b".repeat(40), MERGE_TREE: "c".repeat(40),
    WORKFLOW_BLOB: "d".repeat(40), WORKFLOW_SHA: "e".repeat(40), FETCH_RESULT: fetch, ACCEPTANCE_RESULT: acceptance,
    RUN_ID: "1", RUN_ATTEMPT: "1", ...PINS, ...env,
  });
  return { ...r, args: existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean) : [] };
}

describe("the unchanged template passes and agrees with DDI", () => {
  test("the template passes, from source and from the command line", () => {
    assert.deepEqual(review(TEMPLATE), []);
    assert.deepEqual(runReview(["--workflow", TEMPLATE_PATH, "--public-workflow", PUBLIC_PATH]), []);
  });

  test("the check it reports is the name DDI's gate reserves", () => {
    assert.equal(CHECK_NAME, "ddi-private-acceptance");
    assert.ok(RESERVED_CHECK_NAMES.has(CHECK_NAME));
  });
});

describe("untrusted jobs cannot obtain credentials", () => {
  test("no secret, variable or token reaches the acceptance job", () => {
    fails(review(edit(ACC_ENV, `${ACC_ENV}      LEAK: \${{ secrets.DDI_REPORTER_PRIVATE_KEY }}\n`)), /LEAK: .*not an allowed expression here/);
    fails(review(edit(ACC_ENV, `${ACC_ENV}      GH_TOKEN: \${{ github.token }}\n`)), /env GH_TOKEN looks like a credential/);
    fails(review(edit(ACC_ENV, `${ACC_ENV}      APP: \${{ vars.DDI_REPORTER_APP_ID }}\n`)), /not an allowed expression here/);
    fails(review(edit("run-name: ddi-private-acceptance pr=", "run-name: ${{ toJSON(secrets) }} pr=")), /toJSON\(secrets\) .*not an allowed expression/);
  });

  test("the acceptance job gets no environment, no permissions and no outputs", () => {
    const head = "  acceptance:\n    needs: [resolve, fetch-portal]\n";
    fails(review(edit(head, `${head}    environment: ddi-acceptance-report\n`)), /job acceptance: (must set exactly|environment must be absent)/);
    fails(review(edit("    permissions: {}\n    services:", "    permissions:\n      contents: read\n    services:")), /job acceptance: permissions must be exactly \{\}/);
    fails(review(edit(head, `${head}    outputs:\n      verdict: success\n`)), /job acceptance: must set exactly/);
  });

  test("credentials stay in their slots: no outputs, no extra env, no inherited secrets", () => {
    fails(review(edit("      archive_sha256: ${{ steps.archive.outputs.archive_sha256 }}\n", "      archive_sha256: ${{ steps.archive.outputs.archive_sha256 }}\n      portal_token: ${{ steps.portal-reader.outputs.token }}\n")), /outputs\.portal_token: .*not an allowed expression|would carry a credential/);
    fails(review(edit("        id: archive\n        run: |", "        id: archive\n        env:\n          KEY: ${{ secrets.PORTAL_READER_PRIVATE_KEY }}\n        run: |")), /env\.KEY: .*not an allowed expression here/);
    fails(review(edit("  report:\n    needs: [resolve, fetch-portal, acceptance]\n", "  report:\n    needs: [resolve, fetch-portal, acceptance]\n    secrets: inherit\n")), /job report: must set exactly/);
    // Each credentialed job reaches only its own environment's key.
    fails(review(edit("    environment: ddi-acceptance-report\n", "    environment: ddi-acceptance-portal-read\n")), /job report: environment must be ddi-acceptance-report/);
  });

  test("no Portal or candidate code runs beside a credential", () => {
    fails(review(edit(ARCHIVE_LINE, `          (cd portal && npm ci)\n${ARCHIVE_LINE}`)), /runs an interpreter, package manager or fetcher/);
    fails(review(edit(ARCHIVE_LINE, `          [ "$(node portal/build.js)" = ok ]\n${ARCHIVE_LINE}`)), /command substitution .*not allowlisted|runs an interpreter/);
    fails(review(edit(ARCHIVE_LINE, `          git -C portal -c core.fsmonitor=hook status\n${ARCHIVE_LINE}`)), /not an allowlisted git command/);
    fails(review(edit(REPORT_START, `          git -C ddi fetch -q https://github.com/okoro0704-del/DDI.git "$HEAD_SHA"\n${REPORT_START}`)), /not an allowlisted git command/);
    fails(review(edit(REPORT_START, `          rm -rf / && conclusion=success\n${REPORT_START}`)), /is not an allowlisted command/);
    const setupNode = "      - uses: actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020 # v4.4.0\n        with:\n          node-version: 22\n";
    fails(review(edit("      - name: Report ddi-private-acceptance", `${setupNode}      - name: Report ddi-private-acceptance`)), /setup-node may not run in report/);
  });

  test("nothing but a manual dispatch can start it", () => {
    for (const trigger of ["push", "pull_request", "pull_request_target", "workflow_run", "issue_comment", "schedule", "repository_dispatch"]) {
      fails(review(edit("on:\n  workflow_dispatch:\n", `on:\n  ${trigger}:\n  workflow_dispatch:\n`)), /the only trigger must be workflow_dispatch/);
    }
  });

  test("behaviour: the first acceptance step refuses any credential-shaped variable and never prints its value", { skip: noBash }, () => {
    const check = script("acceptance", /^No credentials/);
    assert.equal(run(check, fresh("creds"), {}).status, 0);
    const leaked = run(check, fresh("creds"), { DDI_REPORTER_PRIVATE_KEY: "-----BEGIN FAKE KEY-----" });
    assert.equal(leaked.status, 1);
    assert.match(leaked.text, /credential-shaped variables present: DDI_REPORTER_PRIVATE_KEY/);
    assert.doesNotMatch(leaked.text, /BEGIN FAKE KEY/);
    assert.equal(run(check, fresh("creds"), { GH_TOKEN: "x" }).status, 1);
  });
});

describe("a missing credential or failed fetch fails closed", () => {
  test("no step or job can be made optional, and failure is the default verdict", () => {
    fails(review(edit("        id: portal-reader\n", "        id: portal-reader\n        continue-on-error: true\n")), /may not set continue-on-error/);
    fails(review(edit("        id: archive\n", "        id: archive\n        if: false\n")), /may not set if/);
    fails(review(edit("    if: always() && needs.resolve.result == 'success'\n", "    if: always()\n")), /if must be exactly/);
    fails(review(edit(REPORT_START, "          conclusion=success\n")), /conclusion=failure.* is missing or changed|success may be set only/);
    fails(review(edit('[ "$FETCH_RESULT" = success ] && [ "$ACCEPTANCE_RESULT" = success ]', '[ "$FETCH_RESULT" = success ] || [ "$ACCEPTANCE_RESULT" = success ]')), /is missing or changed/);
  });

  test("behaviour: only fetch success and acceptance success report success; anything else reports failure", { skip: noBash }, () => {
    const ok = report("success", "success");
    assert.equal(ok.status, 0, ok.text);
    for (const arg of ["--method", "POST", "repos/okoro0704-del/DDI/check-runs", `name=${CHECK_NAME}`, `head_sha=${"a".repeat(40)}`, "status=completed", "conclusion=success"]) assert.ok(ok.args.includes(arg), `${arg} in ${ok.args}`);
    // A missing or rejected Portal credential fails fetch-portal, which skips acceptance.
    for (const [fetch, acceptance] of [["failure", "skipped"], ["success", "failure"], ["success", "cancelled"], ["cancelled", "skipped"], ["skipped", "success"]]) {
      const r = report(fetch, acceptance);
      assert.equal(r.status, 0, r.text);
      assert.ok(r.args.includes("conclusion=failure") && !r.args.includes("conclusion=success"), `${fetch}/${acceptance}: ${r.args}`);
    }
  });

  test("behaviour: an unverifiable head or a forged input posts nothing", { skip: noBash }, () => {
    const forged: Record<string, string>[] = [{ HEAD_SHA: "main" }, { HEAD_SHA: `${"a".repeat(40)} -f conclusion=success` }, { PR: "11; true" }, { MERGE_TREE: "" }];
    for (const env of forged) {
      const r = report("success", "success", env);
      assert.notEqual(r.status, 0);
      assert.deepEqual(r.args, [], `${JSON.stringify(env)} must not reach gh`);
    }
  });

  test("behaviour: the Portal archive step refuses a checkout at any other commit or tree", { skip: noBash }, () => {
    const portal = portalOrigin();
    assert.equal(archive(portal, { PORTAL_SHA: "f".repeat(40) }).status, 1);
    assert.equal(archive(portal, { PORTAL_TREE: "f".repeat(40) }).status, 1);
  });
});

describe("no repository beyond the approved ones can be fetched", () => {
  test("each App token: one owner, one repository, one read or write permission, revoked at job end", () => {
    const token = /App token must be exactly/;
    fails(review(edit("          repositories: LifeOS-Portal\n", "          repositories: LifeOS-Portal,DDI\n")), token);
    fails(review(edit("          owner: okoro0704-del\n          repositories: LifeOS-Portal", "          owner: someone-else\n          repositories: LifeOS-Portal")), token);
    fails(review(edit("          permission-contents: read\n", "          permission-contents: write\n")), token);
    fails(review(edit("          permission-contents: read\n", "          permission-contents: read\n          permission-actions: read\n")), token);
    fails(review(edit("          permission-contents: read\n", "          permission-contents: read\n          skip-token-revoke: true\n")), token);
    fails(review(edit("          permission-checks: write\n", "          permission-statuses: write\n")), token);
  });

  test("the Portal checkout is the only credentialed fetch, and only of LifeOS-Portal", () => {
    fails(review(edit("          repository: okoro0704-del/LifeOS-Portal\n", "          repository: okoro0704-del/another-private-repo\n")), /checkout must be exactly/);
    fails(review(edit(ELFCOM_FETCH, `${ELFCOM_FETCH}          fetch https://github.com/okoro0704-del/LifeOS-Portal.git "$PORTAL_SHA" direct\n`)), /names LifeOS-Portal outside its checkout and token|not an approved public repository/);
    fails(review(edit(ELFCOM_FETCH, `${ELFCOM_FETCH}          fetch https://github.com/attacker/elfCOM.git "$ELFCOM_SHA" other\n`)), /not an approved public repository/);
    fails(review(edit(ELFCOM_FETCH, `${ELFCOM_FETCH}          fetch https://evil.example/elfCOM.git "$ELFCOM_SHA" other\n`)), /non-loopback host evil\.example/);
    fails(review(edit(ELFCOM_FETCH, `${ELFCOM_FETCH}          fetch git@github.com:okoro0704-del/elfCOM.git "$ELFCOM_SHA" other\n`)), /uses an ssh remote/);
    fails(review(edit(ACC_ENV, `${ACC_ENV}      NOTE: https://app.getlifeos.app\n`)), /names a hosted endpoint/);
  });

  test("behaviour: resolve fetches nothing but the DDI pull request it was given", { skip: noBash }, () => {
    const fixture = ddiOrigin();
    const ok = resolve(fixture);
    assert.equal(ok.status, 0, ok.text);
    assert.match(ok.outputs, new RegExp(`head_sha=${fixture.head}`));
    fails([resolve(fixture, { env: { FAKE_PR_FIELDS: ["open", "attacker/DDI", "master", fixture.head].join("\t") } }).text], /does not come from okoro0704-del\/DDI/);
    fails([resolve(fixture, { env: { PR: "11 --method POST" } }).text], /pr must be a pull request number/);
    fails([resolve(fixture, { env: { BASE: "main" } }).text], /base must be master or pdi/);
  });
});

describe("secrets never reach logs, env files or artifacts", () => {
  test("no tracing, environment dumps, credential names in scripts or persisted env", () => {
    fails(review(edit(REPORT_START, `          set -x\n${REPORT_START}`)), /traces commands/);
    fails(review(edit(REPORT_START, `          echo "$GH_TOKEN"\n${REPORT_START}`)), /names a credential/);
    fails(review(edit(ARCHIVE_LINE, `          env | sort\n${ARCHIVE_LINE}`)), /prints the environment/);
    fails(review(edit(REPORT_START, `          echo "T=1" >> "$GITHUB_ENV"\n${REPORT_START}`)), /persists values into later steps/);
    fails(review(edit(ARCHIVE_LINE, `          echo "$(cat /proc/1/environ)"\n${ARCHIVE_LINE}`)), /reads process memory or environment/);
  });

  test("the only artifact is the one-day Portal archive file", () => {
    const only = /the only artifact is/;
    fails(review(edit("          path: portal.tar.gz\n", "          path: portal\n")), only);
    fails(review(edit("          compression-level: 0\n", "          compression-level: 0\n          include-hidden-files: true\n")), only);
    fails(review(edit("          retention-days: 1\n", "          retention-days: 90\n")), only);
    const upload = "      - uses: actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02 # v4.6.2\n        with:\n          name: portal-source\n          path: portal.tar.gz\n          retention-days: 1\n          if-no-files-found: error\n          compression-level: 0\n";
    fails(review(edit("      - uses: actions/setup-node", `${upload}      - uses: actions/setup-node`)), /upload-artifact may not run in acceptance/);
  });

  test("behaviour: the archive carries tracked files only, never git metadata or credentials", { skip: noBash }, () => {
    const portal = portalOrigin();
    const made = archive(portal);
    assert.equal(made.status, 0, made.text);
    const list = fresh("list");
    copyFileSync(made.file, join(list, "portal.tar.gz"));
    const listing = run("tar -tzf portal.tar.gz", list, {});
    assert.equal(listing.status, 0, listing.text);
    const entries = listing.text.split("\n").filter((e) => e && !e.endsWith("/"));
    assert.deepEqual(entries.sort(), ["portal/.gitignore", "portal/apps/portal-api/index.ts", "portal/dist/kept.js", "portal/package.json"]);
  });
});

describe("dependency revisions cannot drift silently", () => {
  test("pins are full SHAs and equal to the public acceptance workflow's", () => {
    fails(review(edit("  MD_SHA: e46366696e1b75062dde0a27fa8dca0074ef724c\n", `  MD_SHA: ${"1".repeat(40)}\n`)), /MD_SHA is 1{40} here but e46366696e1b75062dde0a27fa8dca0074ef724c in the public acceptance workflow/);
    fails(review(TEMPLATE, PUBLIC.replace("env:\n  MD_SHA:", `env:\n  PORTAL_SHA: ${"2".repeat(40)}\n  MD_SHA:`)), /PORTAL_SHA is .* but 2{40}/);
    fails(review(edit(`  PORTAL_TREE: ${PINS.PORTAL_TREE}\n`, "  PORTAL_TREE: main\n")), /full-SHA pins/);
    fails(review(edit(`  ELFCOM_SHA: ${PINS.ELFCOM_SHA}\n`, `  ELFCOM_SHA: ${PINS.ELFCOM_SHA}\n  EXTRA: x\n`)), /full-SHA pins/);
    fails(review(edit("          ref: ${{ env.PORTAL_SHA }}\n", "          ref: main\n")), /checkout must be exactly/);
  });

  test("actions are pinned to their allowlisted commits, and nothing is cached", () => {
    fails(review(TEMPLATE.replace("actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683", "actions/checkout@v4")), /actions\/checkout@v4 is not an allowlisted action/);
    fails(review(edit("actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02", `actions/upload-artifact@${"0".repeat(40)}`)), /is not an allowlisted action/);
    const cache = `      - uses: actions/cache@${"1".repeat(40)}\n        with:\n          path: ~/.npm\n          key: npm\n`;
    fails(review(edit("      - uses: actions/setup-node", `${cache}      - uses: actions/setup-node`)), /actions\/cache@1{40} is not an allowlisted action/);
    fails(review(edit("          node-version: 22\n\n      - name: Install", "          node-version: 22\n          cache: npm\n\n      - name: Install")), /setup-node may set only node-version 22/);
  });

  test("resolve's pin and runner-copy checks cannot be removed", () => {
    fails(review(edit('            [ "$declared" = "${!pin}" ] || fail', '            [ "$declared" = "$declared" ] || fail')), /is missing or changed/);
    fails(review(edit('| cmp -s - "$own" || fail', '| cmp -s - "$own" || true')), /is missing or changed/);
  });

  test("behaviour: resolve refuses a candidate whose pins or runner copy differ", { skip: noBash }, () => {
    const pins = resolve(ddiOrigin({ pub: PUBLIC.replace(`  MD_SHA: ${PINS.MD_SHA}`, `  MD_SHA: ${"1".repeat(40)}`) }));
    fails([pins.text], new RegExp(`the candidate pins MD_SHA=1{40}; this runner pins ${PINS.MD_SHA}`));
    const copy = resolve(ddiOrigin({ template: `${TEMPLATE}# drift\n` }));
    fails([copy.text], /this runner's workflow differs from the candidate's docs\/ci\/private-acceptance\/ddi-private-acceptance\.yml/);
    // A candidate from before the template (such as PR #11) must declare every pin, Portal included.
    const legacyPublic = PUBLIC.replace("env:\n  MD_SHA:", `env:\n  PORTAL_SHA: ${PINS.PORTAL_SHA}\n  MD_SHA:`);
    assert.equal(resolve(ddiOrigin({ pub: legacyPublic, template: null })).status, 0);
    fails([resolve(ddiOrigin({ template: null })).text], /the candidate pins PORTAL_SHA=none/);
    fails([resolve(ddiOrigin({ pub: legacyPublic.replace(PINS.PORTAL_SHA, "4".repeat(40)), template: null })).text], /the candidate pins PORTAL_SHA=4{40}/);
  });

  test("behaviour: verification refuses a tampered, substituted or git-bearing Portal archive", { skip: noBash }, () => {
    const portal = portalOrigin();
    const made = archive(portal);
    assert.equal(made.status, 0, made.text);
    const ok = verify(made.file, made.digest, portal);
    assert.equal(ok.status, 0, ok.text);
    assert.equal(git(join(ok.cwd, "portal"), "rev-parse", "HEAD^{tree}"), portal.tree);
    assert.equal(verify(made.file, "0".repeat(64), portal).status, 1, "digest mismatch");
    const edited = repack(made.file, 'echo "// injected" >> portal/apps/portal-api/index.ts');
    assert.equal(verify(edited.file, edited.digest, portal).status, 1, "a re-digested archive with changed content fails the tree check");
    const withGit = repack(made.file, "mkdir -p portal/.git && echo '[core]' > portal/.git/config");
    assert.equal(verify(withGit.file, withGit.digest, portal).status, 1, "an archive carrying git metadata is refused");
  });
});

describe("the acceptance result cannot be spoofed", () => {
  test("the report reads job results and resolve's values only, never the candidate's outputs", () => {
    fails(review(edit("          ACCEPTANCE_RESULT: ${{ needs.acceptance.result }}\n", "          ACCEPTANCE_RESULT: ${{ needs.acceptance.outputs.verdict }}\n")), /needs\.acceptance\.outputs\.verdict .*not an allowed expression/);
    const resolved = "          HEAD_SHA: ${{ needs.resolve.outputs.head_sha }}\n          BASE_SHA: ${{ needs.resolve.outputs.base_sha }}\n          MERGE_TREE: ${{ needs.resolve.outputs.merge_tree }}\n          WORKFLOW_BLOB:";
    fails(review(edit(resolved, resolved.replace("${{ needs.resolve.outputs.head_sha }}", "${{ inputs.head_sha }}"))), /job report: HEAD_SHA must be/);
  });

  test("it posts exactly one check, under the reserved name, to DDI", () => {
    fails(review(edit("-f name=ddi-private-acceptance", "-f name=ddi-trusted-ci-review")), /must post the check ddi-private-acceptance|gh call/);
    fails(review(edit("repos/okoro0704-del/DDI/check-runs", "repos/okoro0704-del/elfCOM/check-runs")), /gh call .* is not allowed/);
    const post = TEMPLATE.split("\n").find((l) => l.trim().startsWith("gh api --method POST")) as string;
    fails(review(edit(`${post}\n`, `${post}\n${post.replace('conclusion="$conclusion"', 'conclusion="success"')}\n`)), /makes 2 gh calls/);
  });

  test("only main may run it, for the head that was reviewed", () => {
    fails(review(edit('[ "$REF" = refs/heads/main ] || fail', '[ "$REF" = "$REF" ] || fail')), /is missing or changed/);
    fails(review(edit('[ "$pr_head" = "$HEAD_SHA" ] || fail', '[ "$pr_head" = "$pr_head" ] || fail')), /is missing or changed/);
  });

  test("behaviour: resolve binds the run to the reviewed, up-to-date head on main", { skip: noBash }, () => {
    const fixture = ddiOrigin();
    fails([resolve(fixture, { env: { REF: "refs/heads/feature" } }).text], /dispatch from main only/);
    fails([resolve(fixture, { env: { FAKE_PR_FIELDS: ["open", "okoro0704-del/DDI", "master", "9".repeat(40)].join("\t") } }).text], /has moved past/);
    fails([resolve(fixture, { env: { FAKE_PR_FIELDS: ["closed", "okoro0704-del/DDI", "master", fixture.head].join("\t") } }).text], /is not open/);
    fails([resolve(ddiOrigin({ behind: true })).text], /the pull request is behind master/);
  });
});
