#!/usr/bin/env node
/**
 * DDI private acceptance chain checks (Stage 5D). Trusted code of the private runner repository. It runs
 * only from that repository's main branch, never beside candidate code, and reads GitHub's own records
 * (workflow runs, their jobs and artifacts, the public DDI pull request); it never reads anything the
 * candidate produced. Fails closed:
 *   node runner/scripts/chain.mjs portal-run   acceptance workflow, resolve job: is the Portal snapshot
 *                                              run genuine, current and holding the pinned artifact?
 *   node runner/scripts/chain.mjs report       report workflow: may a result be published, and which?
 *
 * `report` publishes nothing (exits 1) unless the completed run is a genuine, current, first-reported,
 * maintainer-dispatched run of the acceptance workflow at this runner commit, for a pull request still
 * open at the tested head on the tested base. It then reports `success` only if that run, exactly its
 * two jobs, and its Portal snapshot run all succeeded; anything else is reported as `failure`.
 */
import { appendFileSync, readFileSync } from "node:fs";

export const CHECK_NAME = "ddi-private-acceptance";
export const DDI = "okoro0704-del/DDI";
export const RUNNER = {
  maintainers: ["okoro0704-del"],
  branch: "main",
  acceptance: { path: ".github/workflows/ddi-acceptance.yml", name: "DDI private acceptance", jobs: ["acceptance", "resolve"] },
  snapshot: { path: ".github/workflows/portal-snapshot.yml" },
};
export const MAX_ACCEPTANCE_AGE_MS = 24 * 60 * 60 * 1000;
export const MAX_SNAPSHOT_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const CLOCK_SKEW_MS = 5 * 60 * 1000;
const SHA = /^[0-9a-f]{40}$/;
const RUN_ID = /^[1-9][0-9]{0,19}$/;
/** The acceptance workflow's run-name, fixed by its template; GitHub sets it from the dispatch inputs. */
const TITLE = /^ddi-acceptance pr=([1-9][0-9]{0,5}) head=([0-9a-f]{40}) base=(master|pdi) base_sha=([0-9a-f]{40}) portal_run=([1-9][0-9]{0,19})$/;
const PIN_NAMES = ["PORTAL_SHA", "PORTAL_TREE", "MD_SHA", "TRUSTID_SHA", "ELFCOM_SHA"];

export function parseTitle(title) {
  const m = TITLE.exec(String(title ?? ""));
  return m ? { pr: Number(m[1]), head: m[2], base: m[3], baseSha: m[4], portalRun: m[5] } : null;
}

const fresh = (iso, now, max) => {
  const age = now - Date.parse(String(iso ?? ""));
  return Number.isFinite(age) && age >= -CLOCK_SKEW_MS && age <= max;
};
const byMaintainer = (run) => RUNNER.maintainers.includes(run?.actor?.login) && RUNNER.maintainers.includes(run?.triggering_actor?.login);
const word = (value) => String(value ?? "none").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 40) || "none";

/** Problems with a Portal snapshot run; none means its artifact may be used. */
export function snapshotProblems({ run, artifacts, repository, runnerSha, portalSha, now }) {
  const problems = [];
  if (!run || run.repository?.full_name !== repository) problems.push("the snapshot run is not from this repository");
  if (run?.path !== RUNNER.snapshot.path) problems.push("the snapshot run is not portal-snapshot.yml");
  if (run?.event !== "workflow_dispatch" || run?.head_branch !== RUNNER.branch) problems.push("the snapshot run was not dispatched on main");
  if (!SHA.test(String(runnerSha)) || run?.head_sha !== runnerSha) problems.push("the snapshot run used a different runner commit");
  if (!byMaintainer(run)) problems.push("the snapshot run was not started by a maintainer");
  if (run?.status !== "completed" || run?.conclusion !== "success") problems.push("the snapshot run did not succeed");
  if (!fresh(run?.run_started_at, now, MAX_SNAPSHOT_AGE_MS)) problems.push("the snapshot run is older than 7 days");
  const list = Array.isArray(artifacts?.artifacts) ? artifacts.artifacts : [];
  const name = `portal-source-${portalSha}`;
  if (!SHA.test(String(portalSha)) || list.length !== 1 || list[0]?.name !== name || list[0]?.expired !== false) problems.push(`the snapshot run must hold exactly one live artifact, ${name}`);
  return problems;
}

/**
 * Decides what the report workflow may publish. `post: false` publishes nothing; otherwise
 * `conclusion` is success or failure for the head commit in the run's parameters.
 */
export function decideReport({ event, run, jobs, snapshot, snapshotArtifacts, pr, baseCompare, tipCompare, repository, runnerSha, attempt, portalSha, now }) {
  const refuse = [];
  const completed = event?.workflow_run;
  if (String(attempt) !== "1") refuse.push("this acceptance run was already reported (report re-runs publish nothing)");
  if (completed?.repository?.full_name !== repository || completed?.head_repository?.full_name !== repository) refuse.push("the completed run is not from this repository");
  if (completed?.path !== RUNNER.acceptance.path || completed?.name !== RUNNER.acceptance.name) refuse.push("the completed run is not the acceptance workflow");
  if (completed?.event !== "workflow_dispatch" || completed?.head_branch !== RUNNER.branch) refuse.push("the acceptance run was not dispatched on main");
  if (!SHA.test(String(runnerSha)) || completed?.head_sha !== runnerSha) refuse.push("the acceptance run used a different runner commit");
  if (!run || run.id !== completed?.id || run.path !== completed?.path || run.head_sha !== completed?.head_sha) refuse.push("GitHub's record of the run does not match the completion event");
  if (run?.run_attempt !== completed?.run_attempt) refuse.push("a newer attempt of the acceptance run exists");
  if (run?.status !== "completed") refuse.push("the acceptance run is not complete");
  if (!byMaintainer(run)) refuse.push("the acceptance run was not started by a maintainer");
  if (!fresh(run?.run_started_at, now, MAX_ACCEPTANCE_AGE_MS)) refuse.push("the acceptance run is older than 24 hours");
  const params = parseTitle(run?.display_title);
  if (!params || run?.display_title !== completed?.display_title) refuse.push("the acceptance run's parameters cannot be read");
  else {
    if (pr?.number !== params.pr || pr?.state !== "open") refuse.push(`pull request ${params.pr} is not open`);
    if (pr?.head?.repo?.full_name !== DDI) refuse.push(`pull request ${params.pr} does not come from ${DDI}`);
    if (pr?.base?.ref !== params.base) refuse.push(`pull request ${params.pr} no longer targets ${params.base}`);
    if (pr?.head?.sha !== params.head) refuse.push(`pull request ${params.pr} has moved past the tested head`);
    if (!["ahead", "identical"].includes(baseCompare?.status)) refuse.push("the tested base is not an ancestor of the tested head");
    if (!["ahead", "identical"].includes(tipCompare?.status)) refuse.push(`the tested head is behind the current ${params.base}`);
  }
  if (refuse.length) return { post: false, problems: refuse };

  const failed = [];
  if (run.conclusion !== "success") failed.push(`run ${word(run.conclusion)}`);
  const list = Array.isArray(jobs?.jobs) ? jobs.jobs : [];
  if (list.map((job) => job?.name).sort().join() !== RUNNER.acceptance.jobs.join()) failed.push("unexpected jobs");
  for (const job of list) if (job?.conclusion !== "success") failed.push(`${word(job?.name)} ${word(job?.conclusion)}`);
  if (snapshotProblems({ run: snapshot, artifacts: snapshotArtifacts, repository, runnerSha, portalSha, now }).length) failed.push("portal snapshot invalid");
  return {
    post: true,
    conclusion: failed.length ? "failure" : "success",
    verdict: failed.length ? failed.join("; ") : "all jobs succeeded",
    pr: params.pr, base: params.base, headSha: params.head, baseSha: params.baseSha, snapshotRun: params.portalRun, acceptanceRun: run.id,
  };
}

// ---- command line: GitHub's records in, decisions out ---------------------------------------------
async function api(path) {
  const root = process.env.GITHUB_API_URL || "https://api.github.com";
  const res = await fetch(`${root}/${path}`, {
    headers: { accept: "application/vnd.github+json", authorization: `Bearer ${process.env.GH_TOKEN ?? ""}`, "x-github-api-version": "2022-11-28", "user-agent": "ddi-private-acceptance" },
  });
  if (!res.ok) throw new Error(`GET ${path.split("?")[0]} returned HTTP ${res.status}`);
  return res.json();
}
const optional = (promise) => promise.catch(() => null);

/** The runner's pins, read from its own acceptance workflow at this commit. */
function runnerPins(file = "runner/.github/workflows/ddi-acceptance.yml") {
  const text = readFileSync(file, "utf8");
  const pins = {};
  for (const name of PIN_NAMES) {
    const m = new RegExp(`^  ${name}: ([0-9a-f]{40})\\r?$`, "m").exec(text);
    if (!m) throw new Error(`the runner's acceptance workflow has no ${name} pin`);
    pins[name] = m[1];
  }
  return pins;
}

function writeOutputs(values) {
  for (const [name, value] of Object.entries(values)) {
    if (!/^[A-Za-z0-9 ,.;()#_-]*$/.test(String(value))) throw new Error(`output ${name} has unexpected characters`);
    appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${value}\n`);
  }
}

export async function main(command, env = process.env) {
  const repository = env.GITHUB_REPOSITORY;
  const runnerSha = env.GITHUB_WORKFLOW_SHA;
  const now = Date.now();
  const pins = runnerPins();
  if (command === "portal-run") {
    if (!RUN_ID.test(String(env.PORTAL_RUN ?? ""))) throw new Error("portal_run must be a workflow run id");
    const [run, artifacts] = await Promise.all([api(`repos/${repository}/actions/runs/${env.PORTAL_RUN}`), api(`repos/${repository}/actions/runs/${env.PORTAL_RUN}/artifacts?per_page=100`)]);
    const problems = snapshotProblems({ run, artifacts, repository, runnerSha, portalSha: pins.PORTAL_SHA, now });
    if (problems.length) throw new Error(problems.join("; "));
    console.log(`Portal snapshot run ${env.PORTAL_RUN} verified: portal-source-${pins.PORTAL_SHA} from runner ${runnerSha}.`);
    return;
  }
  if (command !== "report") throw new Error(`unknown command ${command}`);
  const event = JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, "utf8"));
  const id = event?.workflow_run?.id;
  if (!Number.isSafeInteger(id) || id <= 0) throw new Error("the event is not a workflow run completion");
  const run = await api(`repos/${repository}/actions/runs/${id}`);
  const params = parseTitle(run?.display_title);
  const attempt = Number.isSafeInteger(run?.run_attempt) ? run.run_attempt : 0;
  const jobs = await api(`repos/${repository}/actions/runs/${id}/attempts/${attempt}/jobs?per_page=100`);
  let snapshot = null, snapshotArtifacts = null, pr = null, baseCompare = null, tipCompare = null;
  if (params) {
    let branch;
    [snapshot, snapshotArtifacts, pr, baseCompare, branch] = await Promise.all([
      optional(api(`repos/${repository}/actions/runs/${params.portalRun}`)),
      optional(api(`repos/${repository}/actions/runs/${params.portalRun}/artifacts?per_page=100`)),
      api(`repos/${DDI}/pulls/${params.pr}`),
      api(`repos/${DDI}/compare/${params.baseSha}...${params.head}`),
      api(`repos/${DDI}/branches/${params.base}`),
    ]);
    const tip = branch?.commit?.sha;
    tipCompare = tip === params.baseSha ? baseCompare : SHA.test(String(tip)) ? await api(`repos/${DDI}/compare/${tip}...${params.head}`) : null;
  }
  const decision = decideReport({ event, run, jobs, snapshot, snapshotArtifacts, pr, baseCompare, tipCompare, repository, runnerSha, attempt: env.GITHUB_RUN_ATTEMPT, portalSha: pins.PORTAL_SHA, now });
  if (!decision.post) throw new Error(`nothing published: ${decision.problems.join("; ")}`);
  writeOutputs({
    conclusion: decision.conclusion, verdict: decision.verdict, pr: decision.pr, base: decision.base, head_sha: decision.headSha,
    base_sha: decision.baseSha, acceptance_run: decision.acceptanceRun, snapshot_run: decision.snapshotRun, runner_sha: runnerSha,
    pins: `Portal ${pins.PORTAL_SHA} (tree ${pins.PORTAL_TREE}), Master Distributor ${pins.MD_SHA}, TrustID ${pins.TRUSTID_SHA}, ElfCom ${pins.ELFCOM_SHA}`,
  });
  console.log(`Acceptance run ${decision.acceptanceRun} verified for PR #${decision.pr} at ${decision.headSha}: ${decision.conclusion} (${decision.verdict}).`);
}

if (process.argv[1] && /chain\.mjs$/.test(process.argv[1])) {
  main(process.argv[2]).catch((err) => {
    console.error(`::error title=DDI private acceptance chain::${err.message}`);
    process.exitCode = 1;
  });
}
