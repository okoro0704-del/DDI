import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile, execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { promisify } from "node:util";
// @ts-expect-error -- plain ESM script without type declarations
import { parseWorkflowYaml, RESERVED_CHECK_NAMES } from "../scripts/ci/assert-ci-safety.mjs";
// @ts-expect-error -- plain ESM script without type declarations
import { CHECK_NAME, readRunnerDir, reviewRunner, runReview, RUNNER_FILES } from "../scripts/ci/assert-private-acceptance.mjs";
// @ts-expect-error -- plain ESM script without type declarations
import * as chain from "../docs/ci/private-acceptance/runner/scripts/chain.mjs";

/**
 * Stage 5D adversarial tests for the Free-plan private acceptance runner: Portal snapshot, untrusted
 * acceptance and trusted report, three workflows with separate trust boundaries.
 *   - Static cases apply one hostile edit to a real runner file and expect the review to fail closed;
 *     the unchanged runner passes.
 *   - Chain cases feed GitHub-shaped records to scripts/chain.mjs and expect it to refuse, or to report
 *     failure. Its command line runs against a local fake GitHub API.
 *   - Behaviour cases run the workflows' own trusted scripts against local fixtures, with `gh` replaced
 *     and git confined to `file://`.
 * Nothing here reaches GitHub or holds a credential.
 */
const REPO = join(import.meta.dirname, "..");
const RUNNER_DIR = join(REPO, "docs", "ci", "private-acceptance", "runner");
const CHAIN_PATH = join(RUNNER_DIR, "scripts", "chain.mjs");
const PUBLIC_PATH = join(REPO, ".github", "workflows", "d3-cross-repo-acceptance.yml");
const PUBLIC = readFileSync(PUBLIC_PATH, "utf8").replace(/\r\n/g, "\n");
const FILES: Record<string, string> = Object.fromEntries(Object.entries(readRunnerDir(RUNNER_DIR) as Record<string, string>).map(([k, v]) => [k, v.replace(/\r\n/g, "\n")]));
const W = { snapshot: ".github/workflows/portal-snapshot.yml", acceptance: ".github/workflows/ddi-acceptance.yml", report: ".github/workflows/ddi-report.yml" } as const;
type Key = keyof typeof W;
const DOCS = { snapshot: parseWorkflowYaml(FILES[W.snapshot]), acceptance: parseWorkflowYaml(FILES[W.acceptance]), report: parseWorkflowYaml(FILES[W.report]) };
const PINS = { ...DOCS.acceptance.env } as Record<string, string>;

const review = (files: Record<string, string> = FILES, pub: string = PUBLIC) => reviewRunner(files, pub) as string[];
const fails = (failures: string[], pattern: RegExp) => assert.ok(failures.some((f) => pattern.test(f)), `expected ${pattern} in ${JSON.stringify(failures)}`);
const edit = (key: Key, from: string, to: string) => {
  const out = FILES[W[key]].replace(from, to);
  assert.notEqual(out, FILES[W[key]], `test edit did not apply: ${from}`);
  return { ...FILES, [W[key]]: out };
};
const ACC_ENV = "    env:\n      HEAD_SHA: ${{ needs.resolve.outputs.head_sha }}\n";
const ACC_HEAD = "  acceptance:\n    needs: resolve\n";
const ELFCOM_FETCH = '          fetch https://github.com/okoro0704-del/elfCOM.git "$ELFCOM_SHA" elfcom\n';
const SNAP_ARCHIVE = '          git -C portal -c core.autocrlf=false archive --format=tar --prefix=portal/ "$PORTAL_SHA" | gzip -n > portal.tar.gz\n';
const SNAP_ACTOR = '          [ "$ACTOR" = okoro0704-del ] || fail "only a maintainer may dispatch"\n';
const POST = (FILES[W.report].split("\n").find((l) => l.trim().startsWith("gh api --method POST")) as string) + "\n";
const POST_START = '          [[ "$CONCLUSION" =~ ^(success|failure)$ ]]\n';
const REPORTER_STEP = "      - name: Reporter token (checks write, DDI only, revoked when the job ends)\n";

// ---- chain fixtures: GitHub-shaped records -----------------------------------------------------
const R = "okoro0704-del/ddi-private-acceptance";
const RUNNER_SHA = "1".repeat(40);
const HEAD = "a".repeat(40);
const BASE_SHA = "b".repeat(40);
const NOW = Date.parse("2026-10-18T12:00:00Z");
const ago = (minutes: number, now = NOW) => new Date(now - minutes * 60_000).toISOString();
const title = (o: Record<string, string> = {}) => {
  const v = { pr: "11", head: HEAD, base: "master", base_sha: BASE_SHA, portal_run: "900", ...o };
  return `ddi-acceptance pr=${v.pr} head=${v.head} base=${v.base} base_sha=${v.base_sha} portal_run=${v.portal_run}`;
};
const MAINTAINER = { login: "okoro0704-del" };
const acceptanceRun = (o: Record<string, unknown> = {}, now = NOW) => ({
  id: 1000, run_attempt: 1, name: "DDI private acceptance", path: ".github/workflows/ddi-acceptance.yml", event: "workflow_dispatch", head_branch: "main",
  head_sha: RUNNER_SHA, status: "completed", conclusion: "success", display_title: title(), repository: { full_name: R }, head_repository: { full_name: R },
  actor: MAINTAINER, triggering_actor: MAINTAINER, run_started_at: ago(30, now), ...o,
});
const snapshotRun = (o: Record<string, unknown> = {}, now = NOW) => ({
  id: 900, path: ".github/workflows/portal-snapshot.yml", event: "workflow_dispatch", head_branch: "main", head_sha: RUNNER_SHA, status: "completed",
  conclusion: "success", repository: { full_name: R }, actor: MAINTAINER, triggering_actor: MAINTAINER, run_started_at: ago(24 * 60, now), ...o,
});
const artifacts = (list: object[] = [{ name: `portal-source-${PINS.PORTAL_SHA}`, expired: false }]) => ({ total_count: list.length, artifacts: list });
const pullRequest = (o: Record<string, unknown> = {}) => ({ number: 11, state: "open", head: { sha: HEAD, repo: { full_name: "okoro0704-del/DDI" } }, base: { ref: "master" }, ...o });
const JOBS_OK = { jobs: [{ name: "resolve", conclusion: "success" }, { name: "acceptance", conclusion: "success" }] };
type Decision = { post: boolean; problems?: string[]; conclusion?: string; verdict?: string; headSha?: string };
function decide(o: Record<string, unknown> = {}): Decision {
  const run = o.run ?? acceptanceRun();
  return chain.decideReport({
    event: { workflow_run: o.completed ?? run }, run, jobs: JOBS_OK, snapshot: snapshotRun(), snapshotArtifacts: artifacts(), pr: pullRequest(),
    baseCompare: { status: "ahead" }, tipCompare: { status: "ahead" }, repository: R, runnerSha: RUNNER_SHA, attempt: "1", portalSha: PINS.PORTAL_SHA, now: NOW, ...o,
  });
}
const refused = (d: Decision, pattern: RegExp) => {
  assert.equal(d.post, false, `expected a refusal, got ${JSON.stringify(d)}`);
  assert.ok((d.problems ?? []).some((p) => pattern.test(p)), `expected ${pattern} in ${JSON.stringify(d.problems)}`);
};
const failed = (d: Decision, pattern: RegExp) => {
  assert.equal(d.post, true, JSON.stringify(d));
  assert.equal(d.conclusion, "failure");
  assert.match(d.verdict ?? "", pattern);
};
const snapProblems = (o: Record<string, unknown> = {}) => chain.snapshotProblems({ run: snapshotRun(), artifacts: artifacts(), repository: R, runnerSha: RUNNER_SHA, portalSha: PINS.PORTAL_SHA, now: NOW, ...o }) as string[];

// ---- behaviour harness: the workflows' own scripts, run by bash in private directories ------------
const BASH = process.platform === "win32" ? ["C:\\Program Files\\Git\\usr\\bin\\bash.exe", "C:\\Program Files\\Git\\bin\\bash.exe"].find(existsSync) : "bash";
const noBash = BASH ? false : "Git Bash is not installed";
const work = mkdtempSync(join(tmpdir(), "private-acceptance-"));
let n = 0;
const fresh = (label: string) => { const dir = join(work, `${label}-${++n}`); mkdirSync(dir, { recursive: true }); return dir; };
const write = (path: string, body: string) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, body); };
const GIT_ENV = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", HOME: work, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@invalid" };
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, env: GIT_ENV, encoding: "utf8" }).trim();
const commitAll = (cwd: string, message: string) => { git(cwd, "add", "-A", "-f"); git(cwd, "commit", "-q", "-m", message); return git(cwd, "rev-parse", "HEAD"); };
const sha256 = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");

/** A fake `gh` on PATH: records its arguments, prints the configured pull-request fields. */
const bin = fresh("bin");
writeFileSync(join(bin, "gh"), "#!/usr/bin/env bash\nprintf '%s\\n' \"$@\" >> \"$GH_LOG\"\n[ -z \"${FAKE_PR_FIELDS:-}\" ] || printf '%s\\n' \"$FAKE_PR_FIELDS\"\n", { mode: 0o755 });
const script = (key: Key, job: string, name: RegExp) => {
  const step = DOCS[key].jobs[job].steps.find((s: { name?: string; run?: string }) => s.run !== undefined && name.test(s.name ?? ""));
  assert.ok(step, `no ${name} step in ${key} ${job}`);
  return String(step.run);
};
const run = (body: string, cwd: string, env: Record<string, string>) => {
  const r = spawnSync(BASH as string, ["--noprofile", "--norc", "-c", body], {
    cwd, encoding: "utf8",
    env: { PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`, SYSTEMROOT: process.env.SYSTEMROOT ?? "", HOME: work, GIT_CONFIG_NOSYSTEM: "1", ...env },
  });
  return { status: r.status, text: `${r.stdout}${r.stderr}` };
};

/** A git repository holding exactly the runner files, as the private runner repository would. */
function runnerOrigin(files: Record<string, string> = FILES) {
  const dir = fresh("runner-origin");
  git(dir, "init", "-q", "-b", "main");
  for (const [rel, body] of Object.entries(files)) write(join(dir, ...rel.split("/")), body);
  commitAll(dir, "runner");
  return dir.replace(/\\/g, "/");
}

/** A local stand-in for okoro0704-del/DDI: `master` (base) and a candidate head one commit ahead. */
function ddiOrigin({ pub = PUBLIC, mirror = FILES as Record<string, string> | null, behind = false } = {}) {
  const origin = fresh("ddi-origin");
  git(origin, "init", "-q", "-b", "master");
  git(origin, "config", "uploadpack.allowAnySHA1InWant", "true");
  write(join(origin, ".github", "workflows", "d3-cross-repo-acceptance.yml"), pub);
  if (mirror) for (const [rel, body] of Object.entries(mirror)) write(join(origin, "docs", "ci", "private-acceptance", "runner", ...rel.split("/")), body);
  commitAll(origin, "base");
  git(origin, "checkout", "-q", "-b", "candidate");
  write(join(origin, "candidate.txt"), "candidate\n");
  const head = commitAll(origin, "candidate");
  git(origin, "checkout", "-q", "master");
  if (behind) { write(join(origin, "later.txt"), "later\n"); commitAll(origin, "later"); }
  return { origin: origin.replace(/\\/g, "/"), head, base: git(origin, "rev-parse", "master") };
}

function resolve(fixture: { origin: string; head: string; base: string }, { env = {} as Record<string, string>, runner = "" } = {}) {
  const cwd = fresh("resolve");
  git(cwd, "clone", "-q", runner || runnerOrigin(), "runner");
  const output = join(cwd, "github-output");
  writeFileSync(output, "");
  const r = run(script("acceptance", "resolve", /^Resolve/), cwd, {
    GH_LOG: join(cwd, "gh.log"), GITHUB_OUTPUT: output, GH_TOKEN: "test-not-a-token",
    REF: "refs/heads/main", ACTOR: "okoro0704-del", PR: "11", HEAD_SHA: fixture.head, BASE: "master", BASE_SHA: fixture.base,
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
type Portal = ReturnType<typeof portalOrigin>;

/** The snapshot workflow's archive step on a checkout of `portal`. */
function snapshotArchive(portal: Portal, env: Record<string, string> = {}) {
  const cwd = fresh("snapshot");
  git(cwd, "clone", "-q", portal.dir, "portal");
  const r = run(script("snapshot", "snapshot", /^Archive/), cwd, { PORTAL_SHA: portal.sha, PORTAL_TREE: portal.tree, ...env });
  return { ...r, file: join(cwd, "portal.tar.gz") };
}

/** The acceptance workflow's resolve-job snapshot verification on a downloaded archive. */
function snapshotVerify(file: string, portal: Portal) {
  const cwd = fresh("snapshot-verify");
  mkdirSync(join(cwd, "portal-snapshot"));
  copyFileSync(file, join(cwd, "portal-snapshot", "portal.tar.gz"));
  const output = join(cwd, "github-output");
  writeFileSync(output, "");
  const r = run(script("acceptance", "resolve", /^Verify the snapshot/), cwd, { GITHUB_OUTPUT: output, PORTAL_TREE: portal.tree });
  return { ...r, digest: /portal_sha256=([0-9a-f]{64})/.exec(readFileSync(output, "utf8"))?.[1] ?? "", file: join(cwd, "portal.tar.gz") };
}

/** The acceptance job's archive verification before any code runs. */
function acceptanceVerify(file: string, digest: string, portal: Portal) {
  const cwd = fresh("verify");
  mkdirSync(join(cwd, "portal-archive"));
  copyFileSync(file, join(cwd, "portal-archive", "portal.tar.gz"));
  return { ...run(script("acceptance", "acceptance", /^Verify the Portal archive/), cwd, { PORTAL_ARCHIVE_SHA256: digest, PORTAL_TREE: portal.tree, PORTAL_SHA: portal.sha }), cwd };
}

/** Repacks an archive after `change` runs in its extracted tree. */
function repack(file: string, change: string) {
  const cwd = fresh("repack");
  copyFileSync(file, join(cwd, "source.tar.gz")); // relative paths: tar reads "C:" as a remote host
  const r = run(`set -euo pipefail\ntar -xzf source.tar.gz\n${change}\ntar -czf tampered.tar.gz portal`, cwd, {});
  assert.equal(r.status, 0, r.text);
  return join(cwd, "tampered.tar.gz");
}

/** The report workflow's post step, with the verify step's outputs as given. */
function post(env: Record<string, string> = {}) {
  const cwd = fresh("post");
  const log = join(cwd, "gh.log");
  const r = run(script("report", "report", /^Report/), cwd, {
    GH_LOG: log, GH_TOKEN: "test-not-a-token", GITHUB_STEP_SUMMARY: join(cwd, "summary"),
    CONCLUSION: "success", VERDICT: "all jobs succeeded", PR: "11", BASE: "master", HEAD_SHA: HEAD, BASE_SHA, ACCEPTANCE_RUN: "1000", SNAPSHOT_RUN: "900",
    CHAIN_COMMIT: RUNNER_SHA, PINS: "Portal x", ...env,
  });
  return { ...r, args: existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean) : [] };
}

// ---- chain command line against a local fake GitHub API -----------------------------------------
const execFileP = promisify(execFile);
async function withApi(routes: Record<string, unknown>, fn: (url: string, seen: string[]) => Promise<void>) {
  const seen: string[] = [];
  const server = createServer((req, res) => {
    const path = (req.url ?? "").replace(/^\//, "").split("?")[0];
    seen.push(`${req.headers.authorization === "Bearer test-not-a-token" ? "auth" : "NO-AUTH"} ${path}`);
    const body = routes[path];
    res.writeHead(body === undefined ? 404 : 200, { "content-type": "application/json" });
    res.end(JSON.stringify(body ?? { message: "Not Found" }));
  });
  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
  try { await fn(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen); } finally { server.close(); }
}
async function chainCli(command: string, api: string, { event = {} as object, env = {} as Record<string, string> } = {}) {
  const cwd = fresh("chain");
  write(join(cwd, "runner", ".github", "workflows", "ddi-acceptance.yml"), FILES[W.acceptance]);
  const eventPath = join(cwd, "event.json");
  writeFileSync(eventPath, JSON.stringify(event));
  const output = join(cwd, "github-output");
  writeFileSync(output, "");
  const childEnv = {
    PATH: process.env.PATH ?? "", SYSTEMROOT: process.env.SYSTEMROOT ?? "", GITHUB_API_URL: api, GH_TOKEN: "test-not-a-token", GITHUB_REPOSITORY: R,
    GITHUB_WORKFLOW_SHA: RUNNER_SHA, GITHUB_RUN_ATTEMPT: "1", GITHUB_EVENT_PATH: eventPath, GITHUB_OUTPUT: output, ...env,
  };
  try {
    const r = await execFileP(process.execPath, [CHAIN_PATH, command], { cwd, env: childEnv });
    return { status: 0, text: `${r.stdout}${r.stderr}`, outputs: readFileSync(output, "utf8") };
  } catch (err) {
    const e = err as { code?: number; stdout?: string; stderr?: string };
    return { status: e.code ?? 1, text: `${e.stdout ?? ""}${e.stderr ?? ""}`, outputs: readFileSync(output, "utf8") };
  }
}
const liveRoutes = (now: number, o: Record<string, unknown> = {}) => ({
  [`repos/${R}/actions/runs/1000`]: acceptanceRun({}, now),
  [`repos/${R}/actions/runs/1000/attempts/1/jobs`]: JOBS_OK,
  [`repos/${R}/actions/runs/900`]: snapshotRun({}, now),
  [`repos/${R}/actions/runs/900/artifacts`]: artifacts(),
  "repos/okoro0704-del/DDI/pulls/11": pullRequest(),
  [`repos/okoro0704-del/DDI/compare/${BASE_SHA}...${HEAD}`]: { status: "ahead" },
  "repos/okoro0704-del/DDI/branches/master": { commit: { sha: BASE_SHA } },
  ...o,
});

describe("the unchanged runner passes and agrees with DDI", () => {
  test("the runner passes, from files and from the command line", () => {
    assert.deepEqual(review(), []);
    assert.deepEqual(runReview(["--runner-dir", RUNNER_DIR, "--public-workflow", PUBLIC_PATH]), []);
    assert.deepEqual(Object.keys(FILES).sort(), [...RUNNER_FILES].sort());
  });

  test("the check it reports is the name DDI's gate reserves, and the chain checks name the real workflows", () => {
    assert.equal(CHECK_NAME, "ddi-private-acceptance");
    assert.equal(chain.CHECK_NAME, CHECK_NAME);
    assert.ok(RESERVED_CHECK_NAMES.has(CHECK_NAME));
    assert.equal(chain.RUNNER.acceptance.name, DOCS.acceptance.name);
    assert.deepEqual(chain.RUNNER.acceptance.jobs, Object.keys(DOCS.acceptance.jobs).sort());
    assert.equal(chain.RUNNER.acceptance.path, W.acceptance);
    assert.equal(chain.RUNNER.snapshot.path, W.snapshot);
    assert.deepEqual(DOCS.report.on.workflow_run.workflows, [DOCS.acceptance.name]);
    assert.ok(chain.parseTitle(title()), "the chain parses the acceptance run-name it is given");
  });

  test("the runner holds exactly its files", () => {
    fails(review({ ...FILES, "scripts/extra.sh": "echo hi\n" }), /the runner must hold exactly/);
    fails(review(Object.fromEntries(Object.entries(FILES).filter(([path]) => path !== "scripts/chain.mjs"))), /the runner must hold exactly/);
    const dir = fresh("linked-runner");
    for (const [rel, body] of Object.entries(FILES)) write(join(dir, ...rel.split("/")), body);
    symlinkSync(join(dir, "README.md"), join(dir, "LINK.md"), "file");
    fails(runReview(["--runner-dir", dir]), /LINK\.md is a symlink/);
  });
});

describe("candidate code cannot reach a secret, a write token or a credential-bearing artifact", () => {
  test("the untrusted workflow references no secret or variable at all", () => {
    for (const leak of ["${{ secrets.DDI_REPORTER_PRIVATE_KEY }}", "${{ secrets.PORTAL_READER_PRIVATE_KEY }}", "${{ vars.DDI_REPORTER_APP_ID }}", "${{ toJSON(secrets) }}"]) {
      const failures = review(edit("acceptance", ACC_ENV, `${ACC_ENV}      LEAK: ${leak}\n`));
      fails(failures, /the untrusted workflow references a secret or variable|not an allowed expression here/);
    }
    fails(review(edit("acceptance", ACC_ENV, `${ACC_ENV}      GH_TOKEN: \${{ github.token }}\n`)), /env GH_TOKEN looks like a credential/);
  });

  test("the acceptance job gets no environment, no permissions, no outputs and no write token", () => {
    fails(review(edit("acceptance", ACC_HEAD, `${ACC_HEAD}    environment: ddi-acceptance-report\n`)), /job acceptance: must set exactly/);
    fails(review(edit("acceptance", "    permissions: {}\n    services:", "    permissions:\n      contents: write\n    services:")), /job acceptance: permissions must be exactly \{\}/);
    fails(review(edit("acceptance", ACC_HEAD, `${ACC_HEAD}    outputs:\n      verdict: success\n`)), /job acceptance: must set exactly/);
    fails(review(edit("acceptance", "      contents: read\n      actions: read\n", "      contents: write\n      actions: read\n")), /job resolve: permissions must be exactly/);
  });

  test("a token output is a credential: it cannot be copied into any other variable (Stage 5C defect, fixed)", () => {
    fails(review(edit("report", "          CONCLUSION: ${{ steps.verify.outputs.conclusion }}\n", "          CONCLUSION: ${{ steps.verify.outputs.conclusion }}\n          COPY: ${{ steps.reporter.outputs.token }}\n")), /COPY: .*not an allowed expression here/);
    fails(review(edit("snapshot", "          ACTOR: ${{ github.triggering_actor }}\n", "          ACTOR: ${{ github.triggering_actor }}\n          COPY: ${{ steps.portal-reader.outputs.token }}\n")), /COPY: .*not an allowed expression here/);
  });

  test("no candidate or Portal code runs beside a credential", () => {
    fails(review(edit("snapshot", SNAP_ARCHIVE, `          (cd portal && npm ci)\n${SNAP_ARCHIVE}`)), /runs an interpreter, package manager or fetcher/);
    fails(review(edit("snapshot", SNAP_ARCHIVE, `          git -C portal -c core.fsmonitor=hook status\n${SNAP_ARCHIVE}`)), /not an allowlisted git command/);
    // Commands that run no interpreter and no git still need the credentialed allowlist.
    fails(review(edit("snapshot", SNAP_ARCHIVE, `          cp -r portal /tmp/portal-copy\n${SNAP_ARCHIVE}`)), /"cp -r portal \/tmp\/portal-copy" is not an allowlisted command/);
    fails(review(edit("report", POST_START, `          rm -rf runner\n${POST_START}`)), /"rm -rf runner" is not an allowlisted command/);
    fails(review(edit("report", POST_START, `          git -C ddi fetch -q https://github.com/okoro0704-del/DDI.git "$HEAD_SHA"\n${POST_START}`)), /not an allowlisted git command/);
    fails(review(edit("report", "        run: node runner/scripts/chain.mjs report\n", "        run: node runner/scripts/chain.mjs report && node ddi/evil.js\n")), /runs an interpreter|chain check/);
    const setupNode = "      - uses: actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020 # v4.4.0\n        with:\n          node-version: 22\n";
    fails(review(edit("report", REPORTER_STEP, `${setupNode}${REPORTER_STEP}`)), /setup-node may not run in report/);
  });

  test("behaviour: the first acceptance step refuses any credential-shaped variable and never prints its value", { skip: noBash }, () => {
    const check = script("acceptance", "acceptance", /^No credentials/);
    assert.equal(run(check, fresh("creds"), {}).status, 0);
    const leaked = run(check, fresh("creds"), { DDI_REPORTER_PRIVATE_KEY: "-----BEGIN FAKE KEY-----" });
    assert.equal(leaked.status, 1);
    assert.match(leaked.text, /credential-shaped variables present: DDI_REPORTER_PRIVATE_KEY/);
    assert.doesNotMatch(leaked.text, /BEGIN FAKE KEY/);
    assert.equal(run(check, fresh("creds"), { GH_TOKEN: "x" }).status, 1);
  });

  test("behaviour: the snapshot archive carries tracked files only, never git metadata or credentials", { skip: noBash }, () => {
    const made = snapshotArchive(portalOrigin());
    assert.equal(made.status, 0, made.text);
    const list = fresh("list");
    copyFileSync(made.file, join(list, "portal.tar.gz"));
    const listing = run("tar -tzf portal.tar.gz", list, {});
    assert.equal(listing.status, 0, listing.text);
    assert.deepEqual(listing.text.split("\n").filter((e) => e && !e.endsWith("/")).sort(), ["portal/.gitignore", "portal/apps/portal-api/index.ts", "portal/dist/kept.js", "portal/package.json"]);
  });
});

describe("a missing credential fails closed", () => {
  test("no credentialed step can be made optional, and the reporter key is minted only after the chain check", () => {
    fails(review(edit("snapshot", "        id: portal-reader\n", "        id: portal-reader\n        continue-on-error: true\n")), /may not set continue-on-error/);
    fails(review(edit("report", "        id: reporter\n", "        id: reporter\n        continue-on-error: true\n")), /may not set continue-on-error/);
    const verify = "      - name: Verify the chain (GitHub's records only)\n        id: verify\n        env:\n          GH_TOKEN: ${{ github.token }}\n        run: node runner/scripts/chain.mjs report\n";
    const token = FILES[W.report].slice(FILES[W.report].indexOf(REPORTER_STEP), FILES[W.report].indexOf("      - name: Report ddi-private-acceptance"));
    fails(review(edit("report", `${verify}${token}`, `${token}${verify}`)), /steps must run runner checkout, chain check, reporter token, post, in that order/);
  });

  test("a snapshot run that failed (for example, without the Portal key) is never used, and the chain reports failure", () => {
    fails([snapProblems({ run: snapshotRun({ conclusion: "failure" }) }).join()], /the snapshot run did not succeed/);
    fails([snapProblems({ artifacts: artifacts([]) }).join()], /must hold exactly one live artifact/);
    failed(decide({ snapshot: snapshotRun({ conclusion: "failure" }) }), /portal snapshot invalid/);
    failed(decide({ snapshot: null, snapshotArtifacts: null }), /portal snapshot invalid/);
  });

  test("behaviour: without its credential nothing runs past the token step, so nothing is archived or posted", { skip: noBash }, () => {
    // The steps after each token step need its output; the review guarantees nothing can skip or tolerate a failed token step.
    const steps = DOCS.report.jobs.report.steps as { id?: string; uses?: string }[];
    assert.ok(steps.findIndex((s) => s.id === "reporter") < steps.findIndex((s) => String((s as { run?: string }).run ?? "").includes("gh api")));
    const r = post({ HEAD_SHA: "" });
    assert.notEqual(r.status, 0);
    assert.deepEqual(r.args, []);
  });
});

describe("repository identity is fixed at every hop", () => {
  test("each App token: one owner, one repository, one read or write permission, revoked at job end", () => {
    const token = /App token must be exactly this/;
    fails(review(edit("snapshot", "          repositories: LifeOS-Portal\n", "          repositories: LifeOS-Portal,DDI\n")), token);
    fails(review(edit("snapshot", "          owner: okoro0704-del\n          repositories: LifeOS-Portal", "          owner: someone-else\n          repositories: LifeOS-Portal")), token);
    fails(review(edit("snapshot", "          permission-contents: read\n", "          permission-contents: write\n")), token);
    fails(review(edit("snapshot", "          permission-contents: read\n", "          permission-contents: read\n          skip-token-revoke: true\n")), token);
    fails(review(edit("report", "          repositories: DDI\n", "          repositories: DDI,LifeOS-Portal\n")), token);
    fails(review(edit("report", "          permission-checks: write\n", "          permission-statuses: write\n")), token);
  });

  test("only LifeOS-Portal is fetched with a credential, and only public siblings without one", () => {
    fails(review(edit("snapshot", "          repository: okoro0704-del/LifeOS-Portal\n", "          repository: okoro0704-del/another-private-repo\n")), /checkout must be exactly this/);
    fails(review(edit("acceptance", ELFCOM_FETCH, `${ELFCOM_FETCH}          fetch https://github.com/okoro0704-del/LifeOS-Portal.git "$PORTAL_SHA" direct\n`)), /names LifeOS-Portal outside the snapshot checkout|not an approved public repository/);
    fails(review(edit("acceptance", ELFCOM_FETCH, `${ELFCOM_FETCH}          fetch https://github.com/attacker/elfCOM.git "$ELFCOM_SHA" other\n`)), /not an approved public repository/);
    fails(review(edit("acceptance", ELFCOM_FETCH, `${ELFCOM_FETCH}          fetch https://evil.example/elfCOM.git "$ELFCOM_SHA" other\n`)), /non-loopback host evil\.example/);
    fails(review(edit("acceptance", ELFCOM_FETCH, `${ELFCOM_FETCH}          fetch git@github.com:okoro0704-del/elfCOM.git "$ELFCOM_SHA" other\n`)), /uses an ssh remote/);
  });

  test("chain: runs, snapshots and pull requests from another repository are refused", () => {
    refused(decide({ completed: acceptanceRun({ repository: { full_name: "attacker/runner" } }) }), /not from this repository/);
    refused(decide({ completed: acceptanceRun({ head_repository: { full_name: "attacker/runner" } }) }), /not from this repository/);
    refused(decide({ pr: pullRequest({ head: { sha: HEAD, repo: { full_name: "attacker/DDI" } } }) }), /does not come from okoro0704-del\/DDI/);
    fails(snapProblems({ run: snapshotRun({ repository: { full_name: "attacker/runner" } }) }), /not from this repository/);
  });

  test("behaviour: resolve refuses a pull request from another repository", { skip: noBash }, () => {
    const fixture = ddiOrigin();
    fails([resolve(fixture, { env: { FAKE_PR_FIELDS: ["open", "attacker/DDI", "master", fixture.head].join("\t") } }).text], /does not come from okoro0704-del\/DDI/);
  });
});

describe("the DDI commits are the reviewed ones", () => {
  test("behaviour: resolve accepts the reviewed head on the reviewed base tip, and nothing else", { skip: noBash }, () => {
    const fixture = ddiOrigin();
    const ok = resolve(fixture);
    assert.equal(ok.status, 0, ok.text);
    assert.match(ok.outputs, new RegExp(`head_sha=${fixture.head}\\nbase_sha=${fixture.base}\\nmerge_tree=[0-9a-f]{40}`));
    fails([resolve(fixture, { env: { FAKE_PR_FIELDS: ["open", "okoro0704-del/DDI", "master", "9".repeat(40)].join("\t") } }).text], /has moved past/);
    fails([resolve(fixture, { env: { BASE_SHA: "c".repeat(40) } }).text], /master is at [0-9a-f]{40}, not the reviewed c{40}/);
    fails([resolve(fixture, { env: { HEAD_SHA: fixture.head.slice(0, 12) } }).text], /head_sha must be a full commit SHA/);
    fails([resolve(fixture, { env: { BASE_SHA: "main" } }).text], /base_sha must be a full commit SHA/);
    const behind = ddiOrigin({ behind: true });
    fails([resolve(behind).text], /the pull request is behind master/);
  });

  test("chain: a moved head, a moved base or a non-ancestor base publishes nothing", () => {
    refused(decide({ pr: pullRequest({ head: { sha: "9".repeat(40), repo: { full_name: "okoro0704-del/DDI" } } }) }), /moved past the tested head/);
    refused(decide({ baseCompare: { status: "diverged" } }), /tested base is not an ancestor/);
    refused(decide({ tipCompare: { status: "behind" } }), /behind the current master/);
    refused(decide({ tipCompare: null }), /behind the current master/);
  });
});

describe("the Portal source is the pinned one", () => {
  test("pins are full SHAs, equal across workflows and to DDI's public pins; the ref is owner-approved", () => {
    fails(review(edit("snapshot", `  PORTAL_SHA: ${PINS.PORTAL_SHA}\n`, `  PORTAL_SHA: ${"5".repeat(40)}\n`)), /PORTAL_SHA must equal the acceptance workflow's pin/);
    fails(review(edit("snapshot", `  PORTAL_TREE: ${PINS.PORTAL_TREE}\n`, `  PORTAL_TREE: ${"5".repeat(40)}\n`)), /PORTAL_TREE must equal the acceptance workflow's pin/);
    fails(review(edit("acceptance", `  PORTAL_TREE: ${PINS.PORTAL_TREE}\n`, "  PORTAL_TREE: main\n")), /must be full SHAs/);
    fails(review(edit("snapshot", "  PORTAL_REF: refs/tags/ddi-acceptance/316a07b\n", "  PORTAL_REF: main\n")), /PORTAL_REF must be a tag or branch ref/);
    fails(review(edit("acceptance", `  MD_SHA: ${PINS.MD_SHA}\n`, `  MD_SHA: ${"1".repeat(40)}\n`)), /MD_SHA is 1{40} here but/);
    fails(review(FILES, PUBLIC.replace("env:\n  MD_SHA:", `env:\n  PORTAL_SHA: ${"2".repeat(40)}\n  MD_SHA:`)), /PORTAL_SHA is .* but 2{40}/);
  });

  test("chain: a snapshot of another Portal commit, runner commit or workflow is refused", () => {
    fails(snapProblems({ artifacts: artifacts([{ name: `portal-source-${"6".repeat(40)}`, expired: false }]) }), /exactly one live artifact/);
    fails(snapProblems({ run: snapshotRun({ head_sha: "7".repeat(40) }) }), /different runner commit/);
    fails(snapProblems({ run: snapshotRun({ path: ".github/workflows/ddi-acceptance.yml" }) }), /not portal-snapshot\.yml/);
    assert.deepEqual(snapProblems(), []);
  });

  test("behaviour: the snapshot step refuses a ref that is not the pinned commit and tree", { skip: noBash }, () => {
    const portal = portalOrigin();
    assert.equal(snapshotArchive(portal, { PORTAL_SHA: "f".repeat(40) }).status, 1);
    assert.equal(snapshotArchive(portal, { PORTAL_TREE: "f".repeat(40) }).status, 1);
  });
});

describe("artifacts cannot be substituted", () => {
  test("downloads come only from the given snapshot run and the job's own run, with exact names", () => {
    fails(review(edit("acceptance", "          run-id: ${{ inputs.portal_run }}\n", "          run-id: ${{ github.run_id }}\n")), /the snapshot download must be exactly this/);
    fails(review(edit("acceptance", "          name: portal-source-${{ env.PORTAL_SHA }}\n          path: portal-snapshot\n", "          name: portal-source-latest\n          path: portal-snapshot\n")), /the snapshot download must be exactly this/);
    fails(review(edit("acceptance", "          name: portal-source\n          path: portal-archive\n", "          pattern: portal-*\n          path: portal-archive\n")), /the download must be exactly this/);
    fails(review(edit("snapshot", "          path: portal.tar.gz\n", "          path: portal\n")), /the artifact must be exactly this/);
    fails(review(edit("snapshot", "          compression-level: 0\n", "          compression-level: 0\n          include-hidden-files: true\n")), /the artifact must be exactly this/);
    fails(review(edit("snapshot", "          retention-days: 7\n", "          retention-days: 90\n")), /the artifact must be exactly this/);
    const upload = "      - uses: actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02 # v4.6.2\n        with:\n          name: portal-source\n          path: portal.tar.gz\n          retention-days: 1\n          if-no-files-found: error\n          compression-level: 0\n";
    fails(review(edit("acceptance", "      - uses: actions/setup-node", `${upload}      - uses: actions/setup-node`)), /upload-artifact may not run in acceptance/);
  });

  test("chain: a snapshot run with extra, expired or foreign artifacts is refused", () => {
    const good = { name: `portal-source-${PINS.PORTAL_SHA}`, expired: false };
    fails(snapProblems({ artifacts: artifacts([good, { name: "portal-source-extra", expired: false }]) }), /exactly one live artifact/);
    fails(snapProblems({ artifacts: artifacts([{ ...good, expired: true }]) }), /exactly one live artifact/);
    fails(snapProblems({ run: snapshotRun({ event: "push" }) }), /not dispatched on main/);
    fails(snapProblems({ run: snapshotRun({ head_branch: "feature" }) }), /not dispatched on main/);
  });

  test("behaviour: both verifications refuse a tampered, re-digested or git-bearing archive", { skip: noBash }, () => {
    const portal = portalOrigin();
    const made = snapshotArchive(portal);
    assert.equal(made.status, 0, made.text);
    const checked = snapshotVerify(made.file, portal);
    assert.equal(checked.status, 0, checked.text);
    assert.equal(checked.digest, sha256(made.file));
    const ok = acceptanceVerify(checked.file, checked.digest, portal);
    assert.equal(ok.status, 0, ok.text);
    assert.equal(git(join(ok.cwd, "portal"), "rev-parse", "HEAD^{tree}"), portal.tree);
    assert.equal(acceptanceVerify(checked.file, "0".repeat(64), portal).status, 1, "digest mismatch");
    const edited = repack(made.file, 'echo "// injected" >> portal/apps/portal-api/index.ts');
    assert.equal(snapshotVerify(edited, portal).status, 1, "the snapshot check refuses changed content");
    assert.equal(acceptanceVerify(edited, sha256(edited), portal).status, 1, "a re-digested archive with changed content fails the tree check");
    const withGit = repack(made.file, "mkdir -p portal/.git && echo '[core]' > portal/.git/config");
    assert.equal(snapshotVerify(withGit, portal).status, 1, "the snapshot check refuses git metadata");
    assert.equal(acceptanceVerify(withGit, sha256(withGit), portal).status, 1, "an archive carrying git metadata is refused");
  });
});

describe("acceptance results cannot be replayed", () => {
  test("chain: report re-runs, superseded attempts, stale runs and other runner commits publish nothing", () => {
    refused(decide({ attempt: "2" }), /already reported/);
    refused(decide({ run: acceptanceRun({ run_attempt: 2 }), completed: acceptanceRun({ run_attempt: 1 }) }), /newer attempt/);
    refused(decide({ completed: acceptanceRun({ head_sha: "7".repeat(40) }), run: acceptanceRun({ head_sha: "7".repeat(40) }) }), /different runner commit/);
    refused(decide({ run: acceptanceRun({ run_started_at: ago(25 * 60) }) }), /older than 24 hours/);
    refused(decide({ run: acceptanceRun({ run_started_at: ago(-60) }) }), /older than 24 hours/);
    refused(decide({ run: acceptanceRun({ status: "in_progress" }) }), /not complete/);
    refused(decide({ run: acceptanceRun({ id: 1001 }), completed: acceptanceRun() }), /does not match the completion event/);
    failed(decide({ snapshot: snapshotRun({ run_started_at: ago(8 * 24 * 60) }) }), /portal snapshot invalid/);
  });

  test("the report cannot be started on request or for another workflow", () => {
    fails(review(edit("report", "  workflow_run:\n", "  workflow_dispatch:\n  workflow_run:\n")), /only trigger must be workflow_run/);
    fails(review(edit("report", "      - DDI private acceptance\n", "      - DDI private acceptance\n      - DDI acceptance Portal snapshot\n")), /only trigger must be workflow_run/);
    fails(review(edit("report", "    types:\n      - completed\n", "    types:\n      - requested\n")), /only trigger must be workflow_run/);
  });
});

describe("the reporter cannot be impersonated", () => {
  test("each App key is named only by its own workflow's token step", () => {
    const token = "          private-key: ${{ secrets.PORTAL_READER_PRIVATE_KEY }}\n";
    fails(review(edit("snapshot", token, "          private-key: ${{ secrets.DDI_REPORTER_PRIVATE_KEY }}\n")), /App token must be exactly this|not an allowed expression/);
    fails(review(edit("acceptance", ACC_ENV, `${ACC_ENV}      KEY: \${{ secrets.DDI_REPORTER_PRIVATE_KEY }}\n`)), /references a secret or variable/);
  });

  test("it posts exactly one check, under the reserved name, to DDI only", () => {
    fails(review(edit("report", "-f name=ddi-private-acceptance", "-f name=ddi-trusted-ci-review")), /must post the check ddi-private-acceptance|gh call/);
    fails(review(edit("report", "repos/okoro0704-del/DDI/check-runs", "repos/okoro0704-del/elfCOM/check-runs")), /gh call .* is not allowed/);
    fails(review(edit("report", POST, `${POST}${POST.replace('conclusion="$CONCLUSION"', 'conclusion="success"')}`)), /makes 2 gh calls/);
    fails(review(edit("report", POST, POST.replace('conclusion="$CONCLUSION"', 'conclusion="success"'))), /must post the check|gh call/);
    fails(review(edit("report", "          HEAD_SHA: ${{ steps.verify.outputs.head_sha }}\n", "          HEAD_SHA: ${{ github.workflow_sha }}\n")), /HEAD_SHA must be/);
  });

  test("chain: a completion of anything but the acceptance workflow publishes nothing", () => {
    refused(decide({ completed: acceptanceRun({ path: ".github/workflows/portal-snapshot.yml" }) }), /not the acceptance workflow/);
    refused(decide({ completed: acceptanceRun({ name: "DDI private acceptance (copy)" }) }), /not the acceptance workflow/);
    refused(decide({ completed: acceptanceRun({ event: "push" }) }), /not dispatched on main/);
    refused(decide({ completed: acceptanceRun({ head_branch: "feature" }) }), /not dispatched on main/);
  });

  test("behaviour: the post step publishes only a verified success or failure on a verified head", { skip: noBash }, () => {
    const ok = post();
    assert.equal(ok.status, 0, ok.text);
    for (const arg of ["--method", "POST", "repos/okoro0704-del/DDI/check-runs", `name=${CHECK_NAME}`, `head_sha=${HEAD}`, "status=completed", "conclusion=success", "external_id=1000"]) assert.ok(ok.args.includes(arg), `${arg} in ${ok.args}`);
    assert.ok(post({ CONCLUSION: "failure" }).args.includes("conclusion=failure"));
    const forged: Record<string, string>[] = [{ CONCLUSION: "neutral" }, { CONCLUSION: "success -f x" }, { HEAD_SHA: `${HEAD} -f conclusion=success` }, { PR: "11; true" }, { CHAIN_COMMIT: "" }, { ACCEPTANCE_RUN: "1 2" }];
    for (const env of forged) {
      const r = post(env);
      assert.notEqual(r.status, 0);
      assert.deepEqual(r.args, [], `${JSON.stringify(env)} must not reach gh`);
    }
  });
});

describe("only a maintainer can start the chain", () => {
  test("the dispatch checks cannot be removed or redirected", () => {
    fails(review(edit("snapshot", SNAP_ACTOR, "")), /only a maintainer may dispatch.* is missing or changed/);
    fails(review(edit("snapshot", "          ACTOR: ${{ github.triggering_actor }}\n", "          ACTOR: ${{ github.workflow_sha }}\n")), /ACTOR must be/);
    fails(review(edit("acceptance", '          [ "$REF" = refs/heads/main ] || fail "dispatch from main only"\n', '          [ "$REF" = "$REF" ] || fail "dispatch from main only"\n')), /is missing or changed/);
  });

  test("chain: runs or snapshots started by anyone else publish nothing or fail", () => {
    refused(decide({ run: acceptanceRun({ triggering_actor: { login: "someone-else" } }) }), /not started by a maintainer/);
    refused(decide({ run: acceptanceRun({ actor: { login: "someone-else" } }) }), /not started by a maintainer/);
    fails(snapProblems({ run: snapshotRun({ triggering_actor: { login: "someone-else" } }) }), /not started by a maintainer/);
  });

  test("behaviour: the snapshot and resolve steps refuse another actor or branch", { skip: noBash }, () => {
    const auth = script("snapshot", "snapshot", /^Maintainer dispatch/);
    assert.equal(run(auth, fresh("auth"), { REF: "refs/heads/main", ACTOR: "okoro0704-del" }).status, 0);
    fails([run(auth, fresh("auth"), { REF: "refs/heads/main", ACTOR: "someone-else" }).text], /only a maintainer may dispatch/);
    fails([run(auth, fresh("auth"), { REF: "refs/heads/feature", ACTOR: "okoro0704-del" }).text], /dispatch from main only/);
    const fixture = ddiOrigin();
    fails([resolve(fixture, { env: { ACTOR: "someone-else" } }).text], /only a maintainer may dispatch/);
    fails([resolve(fixture, { env: { REF: "refs/heads/feature" } }).text], /dispatch from main only/);
  });
});

describe("results reach only the tested pull request", () => {
  test("chain: a closed, retargeted, renumbered or unreadable pull request publishes nothing", () => {
    refused(decide({ pr: pullRequest({ state: "closed" }) }), /is not open/);
    refused(decide({ pr: pullRequest({ number: 12 }) }), /is not open/);
    refused(decide({ pr: pullRequest({ base: { ref: "pdi" } }) }), /no longer targets master/);
    refused(decide({ pr: null }), /is not open/);
    for (const bad of ["ddi-acceptance pr=11", title({ pr: "11 head=x" }), title({ head: "A".repeat(40) }), `${title()} extra=1`]) {
      refused(decide({ run: acceptanceRun({ display_title: bad }), completed: acceptanceRun({ display_title: bad }) }), /parameters cannot be read/);
    }
    refused(decide({ completed: acceptanceRun({ display_title: title({ pr: "12" }) }) }), /parameters cannot be read/);
  });

  test("command line: the chain publishes for the tested pull request only, and never prints its token", async () => {
    const now = Date.now();
    const event = { workflow_run: acceptanceRun({}, now) };
    await withApi(liveRoutes(now), async (api, seen) => {
      const ok = await chainCli("report", api, { event });
      assert.equal(ok.status, 0, ok.text);
      assert.match(ok.outputs, new RegExp(`conclusion=success\\n[\\s\\S]*head_sha=${HEAD}\\n`));
      assert.match(ok.outputs, /pr=11\n/);
      assert.ok(seen.length >= 7 && seen.every((s) => s.startsWith("auth ")), JSON.stringify(seen));
    });
    await withApi(liveRoutes(now, { "repos/okoro0704-del/DDI/pulls/11": pullRequest({ head: { sha: "9".repeat(40), repo: { full_name: "okoro0704-del/DDI" } } }) }), async (api) => {
      const moved = await chainCli("report", api, { event });
      assert.equal(moved.status, 1);
      assert.equal(moved.outputs, "");
      assert.match(moved.text, /nothing published: .*moved past the tested head/);
      assert.doesNotMatch(moved.text, /test-not-a-token/);
    });
    await withApi({}, async (api) => {
      const down = await chainCli("report", api, { event });
      assert.equal(down.status, 1, "an unreadable GitHub record publishes nothing");
      assert.equal(down.outputs, "");
      assert.doesNotMatch(down.text, /test-not-a-token/);
    });
  });
});

describe("a failure anywhere in the chain is reported as failure", () => {
  test("chain: a failed, cancelled or incomplete acceptance run reports failure on the tested head", () => {
    failed(decide({ run: acceptanceRun({ conclusion: "failure" }) }), /run failure/);
    failed(decide({ run: acceptanceRun({ conclusion: "cancelled" }) }), /run cancelled/);
    failed(decide({ jobs: { jobs: [{ name: "resolve", conclusion: "success" }, { name: "acceptance", conclusion: "skipped" }] } }), /acceptance skipped/);
    failed(decide({ jobs: { jobs: [{ name: "resolve", conclusion: "failure" }, { name: "acceptance", conclusion: "skipped" }] } }), /resolve failure/);
    failed(decide({ jobs: { jobs: [{ name: "resolve", conclusion: "success" }] } }), /unexpected jobs/);
    failed(decide({ jobs: { jobs: [...JOBS_OK.jobs, { name: "extra", conclusion: "success" }] } }), /unexpected jobs/);
    const ok = decide();
    assert.equal(ok.conclusion, "success");
    assert.equal(ok.headSha, HEAD);
  });

  test("command line: a failed acceptance run is published as failure; a bad snapshot run id fails the resolve check", async () => {
    const now = Date.now();
    const event = { workflow_run: acceptanceRun({ conclusion: "failure" }, now) };
    await withApi(liveRoutes(now, { [`repos/${R}/actions/runs/1000`]: acceptanceRun({ conclusion: "failure" }, now) }), async (api) => {
      const r = await chainCli("report", api, { event });
      assert.equal(r.status, 0, r.text);
      assert.match(r.outputs, /^conclusion=failure\n/);
    });
    await withApi(liveRoutes(now), async (api) => {
      assert.equal((await chainCli("portal-run", api, { env: { PORTAL_RUN: "900", PORTAL_SHA: PINS.PORTAL_SHA } })).status, 0);
      const missing = await chainCli("portal-run", api, { env: { PORTAL_RUN: "901" } });
      assert.equal(missing.status, 1, "an unknown snapshot run stops the acceptance run before any candidate code");
      assert.equal((await chainCli("portal-run", api, { env: { PORTAL_RUN: "900; rm -rf /" } })).status, 1);
    });
    await withApi(liveRoutes(now, { [`repos/${R}/actions/runs/900`]: snapshotRun({ conclusion: "failure" }, now) }), async (api) => {
      const failedSnapshot = await chainCli("portal-run", api, { env: { PORTAL_RUN: "900" } });
      assert.equal(failedSnapshot.status, 1);
      assert.match(failedSnapshot.text, /the snapshot run did not succeed/);
    });
  });

  test("the workflows' order guarantees a failed step stops what follows", () => {
    fails(review(edit("acceptance", "        run: node runner/scripts/chain.mjs portal-run\n", "        run: node runner/scripts/chain.mjs portal-run || true\n")), /chain check|interpreter|missing or changed/);
    fails(review(edit("snapshot", "        id: portal-reader\n", "        id: portal-reader\n        if: always()\n")), /may not set if/);
  });
});

describe("secrets never reach logs, env files or redirections", () => {
  test("no tracing, environment dumps, credential names in scripts, persisted env or runner overrides", () => {
    fails(review(edit("report", POST_START, `          set -x\n${POST_START}`)), /traces commands/);
    fails(review(edit("report", POST_START, `          echo "$GH_TOKEN"\n${POST_START}`)), /names a credential/);
    fails(review(edit("snapshot", SNAP_ARCHIVE, `          env | sort\n${SNAP_ARCHIVE}`)), /prints the environment/);
    fails(review(edit("report", POST_START, `          echo "T=1" >> "$GITHUB_ENV"\n${POST_START}`)), /persists values into later steps/);
    fails(review(edit("snapshot", SNAP_ARCHIVE, `          echo "$(cat /proc/1/environ)"\n${SNAP_ARCHIVE}`)), /reads process memory or environment/);
    fails(review(edit("report", "          GH_TOKEN: ${{ github.token }}\n", "          GH_TOKEN: ${{ github.token }}\n          GITHUB_API_URL: http://127.0.0.1:1\n")), /GITHUB_API_URL would redirect/);
    fails(review(edit("acceptance", "  ELFCOM_SHA:", "  NODE_OPTIONS: --require ./evil.js\n  ELFCOM_SHA:")), /NODE_OPTIONS would redirect|env must hold exactly/);
  });
});

describe("dependency revisions cannot drift silently", () => {
  test("actions are pinned to their allowlisted commits, and nothing is cached", () => {
    fails(review({ ...FILES, [W.snapshot]: FILES[W.snapshot].replace("actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683", "actions/checkout@v4") }), /actions\/checkout@v4 is not an allowlisted action/);
    fails(review(edit("snapshot", "actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02", `actions/upload-artifact@${"0".repeat(40)}`)), /is not an allowlisted action/);
    const cache = `      - uses: actions/cache@${"1".repeat(40)}\n        with:\n          path: ~/.npm\n          key: npm\n`;
    fails(review(edit("acceptance", "      - uses: actions/setup-node", `${cache}      - uses: actions/setup-node`)), /actions\/cache@1{40} is not an allowlisted action/);
    fails(review(edit("acceptance", "          node-version: 22\n\n      - name: Install", "          node-version: 22\n          cache: npm\n\n      - name: Install")), /setup-node may set only node-version 22/);
  });

  test("resolve's pin, mirror and base checks cannot be removed", () => {
    fails(review(edit("acceptance", '            [ "$declared" = "${!pin}" ] || fail', '            [ "$declared" = "$declared" ] || fail')), /is missing or changed/);
    fails(review(edit("acceptance", '[ "$candidate_tree" = "$runner_tree" ] || fail', '[ "$candidate_tree" = "$candidate_tree" ] || fail')), /is missing or changed/);
    fails(review(edit("acceptance", '[ "$base_tip" = "$BASE_SHA" ] || fail', '[ "$base_tip" = "$base_tip" ] || fail')), /is missing or changed/);
  });

  test("behaviour: resolve refuses a runner that differs from the candidate's mirror, and pins that differ", { skip: noBash }, () => {
    fails([resolve(ddiOrigin(), { runner: runnerOrigin({ ...FILES, "README.md": `${FILES["README.md"]}drift\n` }) }).text], /this runner \([0-9a-f]{40}\) differs from the candidate's docs\/ci\/private-acceptance\/runner/);
    const pins = resolve(ddiOrigin({ pub: PUBLIC.replace(`  MD_SHA: ${PINS.MD_SHA}`, `  MD_SHA: ${"1".repeat(40)}`) }));
    fails([pins.text], new RegExp(`the candidate pins MD_SHA=1{40}; this runner pins ${PINS.MD_SHA}`));
    // A candidate from before the runner mirror (such as PR #11) must declare every pin, Portal included.
    const legacyPublic = PUBLIC.replace("env:\n  MD_SHA:", `env:\n  PORTAL_SHA: ${PINS.PORTAL_SHA}\n  MD_SHA:`);
    assert.equal(resolve(ddiOrigin({ pub: legacyPublic, mirror: null })).status, 0);
    fails([resolve(ddiOrigin({ mirror: null })).text], /the candidate pins PORTAL_SHA=none/);
    fails([resolve(ddiOrigin({ pub: legacyPublic.replace(PINS.PORTAL_SHA, "4".repeat(40)), mirror: null })).text], /the candidate pins PORTAL_SHA=4{40}/);
  });
});
