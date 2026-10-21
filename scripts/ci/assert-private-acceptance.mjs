#!/usr/bin/env node
/**
 * Stage 5D private acceptance review. Fails closed. Reads the private runner's files as data only
 * (never executes them) and checks the trust boundary in docs/phase-d3d-a-private-acceptance.md:
 *   node assert-private-acceptance.mjs --runner-dir docs/ci/private-acceptance/runner [--public-workflow <d3-cross-repo-acceptance.yml>]
 *
 * The runner holds exactly RUNNER_FILES: three workflows with separate trust boundaries, and the
 * chain checks they run.
 *   - portal-snapshot.yml (credentialed): maintainer dispatch only; the Portal reader key, one
 *     repository, Contents read; checks out the owner-approved ref, verifies commit and tree, uploads
 *     the tracked files. No code runs.
 *   - ddi-acceptance.yml (untrusted): references no secret or variable at all, so GitHub holds none of
 *     the repository's secrets for it. `resolve` (read-only token, no candidate code) checks dispatch,
 *     pull request, base tip, runner mirror, pins and the snapshot run, and re-verifies the snapshot.
 *     `acceptance` (no permissions, no outputs) refuses credentials, re-verifies everything, then runs
 *     the candidate.
 *   - ddi-report.yml (credentialed): runs only on GitHub's completion record. The chain check comes
 *     first; then the reporter key (one repository, Checks write) and exactly one check run.
 * Throughout:
 *   - a secret, a variable or a token may appear only in CREDENTIAL_SLOTS; every other expression is
 *     SAFE and never expanded inside a script;
 *   - credentialed and trusted scripts run only allowlisted commands and never name a credential;
 *   - nothing traces, dumps or persists the environment;
 *   - every action sits at its allowlisted commit with an exact `with`, and nothing is cached;
 *   - URLs go only to the public sibling repositories and loopback;
 *   - pins are full SHAs, equal across the workflows and (with --public-workflow) to DDI's.
 */
import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { HOSTED, parseWorkflowYaml } from "./assert-ci-safety.mjs";

const isMap = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const keysOf = (v) => (isMap(v) ? Object.keys(v) : []);
const sameKeys = (v, keys) => isMap(v) && keysOf(v).sort().join() === [...keys].sort().join();
const sameMap = (v, expected) => sameKeys(v, Object.keys(expected)) && Object.entries(expected).every(([k, x]) => v[k] === x);
const listOf = (v) => (v === undefined || v === null ? [] : Array.isArray(v) ? v : [v]);

export const CHECK_NAME = "ddi-private-acceptance";
const OWNER = "okoro0704-del";
const MAINTAINER = "okoro0704-del";
const SHA = /^[0-9a-f]{40}$/;
const SNAPSHOT = "portal-snapshot.yml";
const ACCEPTANCE = "ddi-acceptance.yml";
const REPORT = "ddi-report.yml";
export const RUNNER_FILES = ["README.md", "scripts/chain.mjs", `.github/workflows/${SNAPSHOT}`, `.github/workflows/${ACCEPTANCE}`, `.github/workflows/${REPORT}`];
/** Each action, by name, at its one allowlisted commit. */
export const ACTIONS = {
  checkout: "actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683",
  "setup-node": "actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020",
  "create-github-app-token": "actions/create-github-app-token@a8d616148505b5069dccd32f177bb87d7f39123b",
  "upload-artifact": "actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02",
  "download-artifact": "actions/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093",
};
const actionName = (uses) => Object.keys(ACTIONS).find((name) => ACTIONS[name] === uses);
const PIN_NAMES = ["PORTAL_SHA", "PORTAL_TREE", "MD_SHA", "TRUSTID_SHA", "ELFCOM_SHA"];
const RUN_NAME = "ddi-acceptance pr=${{ inputs.pr }} head=${{ inputs.head_sha }} base=${{ inputs.base }} base_sha=${{ inputs.base_sha }} portal_run=${{ inputs.portal_run }}";

const string = (input) => isMap(input) && input.required === "true" && input.type === "string" && sameKeys(input, ["description", "required", "type"]);
const WORKFLOWS = {
  [SNAPSHOT]: {
    name: "DDI acceptance Portal snapshot", env: ["PORTAL_SHA", "PORTAL_TREE", "PORTAL_REF"],
    trigger: (on) => sameKeys(on, ["workflow_dispatch"]) && on.workflow_dispatch === null, triggerText: "workflow_dispatch with no inputs",
  },
  [ACCEPTANCE]: {
    name: "DDI private acceptance", runName: RUN_NAME, env: PIN_NAMES, untrusted: true,
    trigger: (on) => {
      const inputs = isMap(on) && sameKeys(on, ["workflow_dispatch"]) && isMap(on.workflow_dispatch) && sameKeys(on.workflow_dispatch, ["inputs"]) ? on.workflow_dispatch.inputs : undefined;
      const base = isMap(inputs) ? inputs.base : undefined;
      return sameKeys(inputs, ["pr", "head_sha", "base", "base_sha", "portal_run"]) && string(inputs.pr) && string(inputs.head_sha) && string(inputs.base_sha) && string(inputs.portal_run)
        && isMap(base) && base.required === "true" && base.type === "choice" && listOf(base.options).join() === "master,pdi";
    },
    triggerText: "workflow_dispatch with exactly pr, head_sha, base_sha, portal_run (required strings) and base (required choice of master, pdi)",
  },
  [REPORT]: {
    name: "DDI private acceptance report",
    trigger: (on) => sameKeys(on, ["workflow_run"]) && sameKeys(on.workflow_run, ["workflows", "types"]) && listOf(on.workflow_run.workflows).join() === "DDI private acceptance" && listOf(on.workflow_run.types).join() === "completed",
    triggerText: "workflow_run on completed DDI private acceptance runs only",
  },
};
/** Jobs per workflow: exact keys, needs, permissions, actions; `credentialed` jobs hold an App key. */
const JOBS = {
  [SNAPSHOT]: { snapshot: { permissions: {}, keys: ["runs-on", "timeout-minutes", "permissions", "steps"], actions: ["create-github-app-token", "checkout", "upload-artifact"], credentialed: true } },
  [ACCEPTANCE]: {
    resolve: { permissions: { contents: "read", actions: "read" }, keys: ["runs-on", "timeout-minutes", "permissions", "outputs", "steps"], actions: ["checkout", "download-artifact", "upload-artifact"], trusted: true },
    acceptance: { needs: ["resolve"], permissions: {}, keys: ["needs", "runs-on", "timeout-minutes", "permissions", "services", "env", "steps"], actions: ["download-artifact", "setup-node"] },
  },
  [REPORT]: { report: { permissions: { actions: "read", contents: "read" }, keys: ["runs-on", "timeout-minutes", "permissions", "steps"], actions: ["checkout", "create-github-app-token"], credentialed: true } },
};
const RESOLVE_OUTPUTS = { head_sha: "${{ steps.resolve.outputs.head_sha }}", base_sha: "${{ steps.resolve.outputs.base_sha }}", merge_tree: "${{ steps.resolve.outputs.merge_tree }}", portal_sha256: "${{ steps.snapshot.outputs.portal_sha256 }}" };
/** Exact `with` (and `id`) of every action step, by workflow, job and action. */
const STEP_WITH = {
  [`${SNAPSHOT} snapshot create-github-app-token`]: { id: "portal-reader", with: { "app-id": "${{ vars.PORTAL_READER_APP_ID }}", "private-key": "${{ secrets.PORTAL_READER_PRIVATE_KEY }}", owner: OWNER, repositories: "LifeOS-Portal", "permission-contents": "read" }, why: "the App token must be exactly this (one repository, one permission, revoked at job end)" },
  [`${SNAPSHOT} snapshot checkout`]: { with: { repository: `${OWNER}/LifeOS-Portal`, ref: "${{ env.PORTAL_REF }}", token: "${{ steps.portal-reader.outputs.token }}", path: "portal", "persist-credentials": "false" }, why: "checkout must be exactly this" },
  [`${SNAPSHOT} snapshot upload-artifact`]: { with: { name: "portal-source-${{ env.PORTAL_SHA }}", path: "portal.tar.gz", "retention-days": "7", "if-no-files-found": "error", "compression-level": "0" }, why: "the artifact must be exactly this" },
  [`${ACCEPTANCE} resolve checkout`]: { with: { ref: "${{ github.workflow_sha }}", path: "runner", "persist-credentials": "false" }, why: "checkout must be exactly this" },
  [`${ACCEPTANCE} resolve download-artifact`]: { with: { name: "portal-source-${{ env.PORTAL_SHA }}", path: "portal-snapshot", "run-id": "${{ inputs.portal_run }}", "github-token": "${{ github.token }}" }, why: "the snapshot download must be exactly this" },
  [`${ACCEPTANCE} resolve upload-artifact`]: { with: { name: "portal-source", path: "portal.tar.gz", "retention-days": "1", "if-no-files-found": "error", "compression-level": "0" }, why: "the artifact must be exactly this" },
  [`${ACCEPTANCE} acceptance download-artifact`]: { with: { name: "portal-source", path: "portal-archive" }, why: "the download must be exactly this" },
  [`${ACCEPTANCE} acceptance setup-node`]: { with: { "node-version": "22" }, why: "setup-node may set only node-version 22 (no cache)" },
  [`${REPORT} report checkout`]: { with: { ref: "${{ github.workflow_sha }}", path: "runner", "sparse-checkout": "scripts\n.github/workflows\n", "persist-credentials": "false" }, why: "checkout must be exactly this" },
  [`${REPORT} report create-github-app-token`]: { id: "reporter", with: { "app-id": "${{ vars.DDI_REPORTER_APP_ID }}", "private-key": "${{ secrets.DDI_REPORTER_PRIVATE_KEY }}", owner: OWNER, repositories: "DDI", "permission-checks": "write" }, why: "the App token must be exactly this (one repository, one permission, revoked at job end)" },
};
/** Credential-bearing expressions and the only places they may appear: `<workflow> <job> <step key path> <expression>`. */
export const CREDENTIAL_SLOTS = [
  `${SNAPSHOT} snapshot with.app-id vars.PORTAL_READER_APP_ID`,
  `${SNAPSHOT} snapshot with.private-key secrets.PORTAL_READER_PRIVATE_KEY`,
  `${SNAPSHOT} snapshot with.token steps.portal-reader.outputs.token`,
  `${ACCEPTANCE} resolve env.GH_TOKEN github.token`,
  `${ACCEPTANCE} resolve env.GH_TOKEN github.token`,
  `${ACCEPTANCE} resolve with.github-token github.token`,
  `${REPORT} report env.GH_TOKEN github.token`,
  `${REPORT} report with.app-id vars.DDI_REPORTER_APP_ID`,
  `${REPORT} report with.private-key secrets.DDI_REPORTER_PRIVATE_KEY`,
  `${REPORT} report env.GH_TOKEN steps.reporter.outputs.token`,
];
const SAFE_EXPRESSIONS = [
  /^github\.(workflow_sha|ref|run_id|run_attempt|workspace|triggering_actor)$/,
  /^env\.[A-Z][A-Z0-9_]*$/,
  /^steps\.[a-z][a-z0-9-]*\.outputs\.(?!token$)[a-z0-9_]+$/, // a token output is a credential, never safe
];
const ACCEPTANCE_EXPRESSIONS = [/^inputs\.(pr|head_sha|base|base_sha|portal_run)$/, /^needs\.resolve\.outputs\.[a-z0-9_]+$/];
const CREDENTIAL_NAME = /(SECRET|PRIVATE_KEY|TOKEN|PASSWORD|API_KEY|CREDENTIAL)/i;
/** Variables that would redirect the runner, git, the shell or Node in a trusted step. */
const RESERVED_ENV = /^(GITHUB_[A-Z_]+|ACTIONS_[A-Z_]+|RUNNER_[A-Z_]+|GIT_[A-Z_]+|NODE_OPTIONS|NODE_PATH|BASH_ENV|ENV|PATH|HOME|LD_PRELOAD|LD_LIBRARY_PATH)$/;
const SERVICE_IMAGE = /^postgres:16-alpine@sha256:[0-9a-f]{64}$/;
/** Public repositories plain git may fetch without a credential. LifeOS Portal is never among them. */
const PUBLIC_FETCH = /^https:\/\/github\.com\/okoro0704-del\/(DDI|MasternDistribution|TRUSTID|elfCOM)\.git$/;
const URL_PATTERN = /\b(?:https?|git|ssh|postgres(?:ql)?|redis|mysql|mongodb(?:\+srv)?|amqps?|wss?):\/\/[^\s"'`)]+/gi;
const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
/** Script text that would print, trace or persist the environment, or read another process. */
const LEAKS = [
  [/(^|[|;&(]\s*)(env|printenv)(\s|$)/m, "prints the environment"],
  [/\bset\s+-\w*x|\bxtrace\b|(^|[|;&]\s*)(set|declare -p|export -p)\s*$/m, "traces commands or prints variables"],
  [/\/proc\//, "reads process memory or environment"],
  [/\bGITHUB_(ENV|PATH)\b/, "persists values into later steps"],
  [/`/, "uses backtick substitution"],
];
/** Trusted scripts run only these tools; never an interpreter, package manager or fetcher besides the chain check. */
const EXECUTORS = /\b(npm|npx|node|tsx|yarn|pnpm|bun|deno|corepack|make|python3?|pip3?|ruby|perl|php|docker|sudo|curl|wget|bash|sh|zsh|source|eval|exec|chmod)\b|\.\//;
const NODE_LINES = { [`${ACCEPTANCE} resolve`]: "node runner/scripts/chain.mjs portal-run", [`${REPORT} report`]: "node runner/scripts/chain.mjs report" };
const CREDENTIALED_LINE = /^(set -euo pipefail$|fail\(\) \{ |\[ |\[\[ |git |echo |summary=|gh |node runner\/scripts\/chain\.mjs )/;
const CREDENTIALED_SUBSTITUTION = /^git -C portal rev-parse /;
const GIT_WORD = /(?:^|[\s;&|(])git\b(.*)$/gm;
const ALLOWED_GIT = {
  [`${SNAPSHOT} snapshot`]: /^ -C portal (-c core\.autocrlf=false )?(rev-parse|archive) /,
  [`${ACCEPTANCE} resolve`]: /^ (init -q (ddi|check\/portal)$|-C ddi (fetch|rev-parse|merge-base|merge-tree|cat-file|show) |-C runner rev-parse |-C check\/portal (-c core\.autocrlf=false add |write-tree))/,
};
const GH_CALLS = {
  [`${ACCEPTANCE} resolve`]: `gh api "repos/${OWNER}/DDI/pulls/$PR" --jq `,
  [`${REPORT} report`]: `gh api --method POST repos/${OWNER}/DDI/check-runs --silent -f name=${CHECK_NAME} -f head_sha="$HEAD_SHA" -f status=completed -f conclusion="$CONCLUSION" `,
};
/** Lines that carry each job's checks; removing or rewording one weakens what the chain proves. */
const REQUIRED_LINES = {
  [`${SNAPSHOT} snapshot`]: [
    '[ "$REF" = refs/heads/main ] || fail "dispatch from main only"',
    `[ "$ACTOR" = ${MAINTAINER} ] || fail "only a maintainer may dispatch"`,
    '[ "$(git -C portal rev-parse HEAD)" = "$PORTAL_SHA" ]',
    "[ \"$(git -C portal rev-parse 'HEAD^{tree}')\" = \"$PORTAL_TREE\" ]",
  ],
  [`${ACCEPTANCE} resolve`]: [
    '[ "$REF" = refs/heads/main ] || fail "dispatch from main only"',
    `[ "$ACTOR" = ${MAINTAINER} ] || fail "only a maintainer may dispatch"`,
    '[[ "$HEAD_SHA" =~ ^[0-9a-f]{40}$ ]] || fail "head_sha must be a full commit SHA"',
    '[[ "$BASE_SHA" =~ ^[0-9a-f]{40}$ ]] || fail "base_sha must be a full commit SHA"',
    '[ "$head_repo" = okoro0704-del/DDI ] || fail "pull request $PR does not come from okoro0704-del/DDI"',
    '[ "$pr_head" = "$HEAD_SHA" ] || fail "pull request $PR has moved past $HEAD_SHA; review the new head and dispatch again"',
    '[ "$base_tip" = "$BASE_SHA" ] || fail "$BASE is at $base_tip, not the reviewed $BASE_SHA; review again and dispatch with the current tip"',
    'git -C ddi merge-base --is-ancestor "$BASE_SHA" "$HEAD_SHA" || fail "the pull request is behind $BASE; update it, review the new head and dispatch again"',
    '[ "$merge_tree" = "$(git -C ddi rev-parse "$HEAD_SHA^{tree}")" ] || fail "the merge tree differs from the head tree"',
    '[ "$candidate_tree" = "$runner_tree" ] || fail "this runner ($runner_tree) differs from the candidate\'s $mirror ($candidate_tree)"',
    "for pin in PORTAL_SHA MD_SHA TRUSTID_SHA ELFCOM_SHA; do",
    '[ "$declared" = "${!pin}" ] || fail "the candidate pins $pin=${declared:-none}; this runner pins ${!pin}"',
    "node runner/scripts/chain.mjs portal-run",
    "[ ! -e check/portal/.git ]",
    '[ "$(git -C check/portal write-tree)" = "$PORTAL_TREE" ]',
  ],
  [`${ACCEPTANCE} acceptance`]: [
    "found=$(compgen -e | grep -iE 'SECRET|PRIVATE_KEY|TOKEN|PASSWORD|API_KEY|CREDENTIAL' | grep -vxE 'ACTIONS_RUNTIME_TOKEN|ACTIONS_ID_TOKEN_REQUEST_TOKEN' || true)",
    '[ "$(git -C ddi merge-tree --write-tree "$BASE_SHA" "$HEAD_SHA")" = "$MERGE_TREE" ]',
    "[ \"$(git -C ddi rev-parse 'HEAD^{tree}')\" = \"$MERGE_TREE\" ]",
    '[[ "$PORTAL_ARCHIVE_SHA256" =~ ^[0-9a-f]{64}$ ]]',
    'echo "$PORTAL_ARCHIVE_SHA256  portal-archive/portal.tar.gz" | sha256sum -c --quiet -',
    "[ ! -e portal/.git ]",
    '[ "$(git -C portal write-tree)" = "$PORTAL_TREE" ]',
  ],
  [`${REPORT} report`]: [
    "node runner/scripts/chain.mjs report",
    '[[ "$CONCLUSION" =~ ^(success|failure)$ ]]',
    '[[ "$HEAD_SHA" =~ ^[0-9a-f]{40}$ && "$BASE_SHA" =~ ^[0-9a-f]{40}$ && "$CHAIN_COMMIT" =~ ^[0-9a-f]{40}$ ]]',
  ],
};
const REQUIRED_ENV = {
  [`${SNAPSHOT} snapshot`]: { REF: "${{ github.ref }}", ACTOR: "${{ github.triggering_actor }}" },
  [`${ACCEPTANCE} resolve`]: { REF: "${{ github.ref }}", ACTOR: "${{ github.triggering_actor }}", PR: "${{ inputs.pr }}", HEAD_SHA: "${{ inputs.head_sha }}", BASE: "${{ inputs.base }}", BASE_SHA: "${{ inputs.base_sha }}", PORTAL_RUN: "${{ inputs.portal_run }}" },
  [`${ACCEPTANCE} acceptance`]: { HEAD_SHA: "${{ needs.resolve.outputs.head_sha }}", BASE_SHA: "${{ needs.resolve.outputs.base_sha }}", MERGE_TREE: "${{ needs.resolve.outputs.merge_tree }}", PORTAL_ARCHIVE_SHA256: "${{ needs.resolve.outputs.portal_sha256 }}" },
  [`${REPORT} report`]: { CONCLUSION: "${{ steps.verify.outputs.conclusion }}", HEAD_SHA: "${{ steps.verify.outputs.head_sha }}" },
};
/** Steps that must appear, in this order, in each job (the acceptance job also before any other code). */
const runs = (fragment) => (s) => String(s.run ?? "").includes(fragment);
const uses = (name) => (s) => s.uses === ACTIONS[name];
const ORDER = {
  [`${SNAPSHOT} snapshot`]: [["maintainer check", runs(`[ "$ACTOR" = ${MAINTAINER} ]`)], ["Portal token", uses("create-github-app-token")], ["checkout", uses("checkout")], ["archive", runs("git -C portal")], ["upload", uses("upload-artifact")]],
  [`${ACCEPTANCE} resolve`]: [["runner checkout", uses("checkout")], ["resolve", runs("git init -q ddi")], ["snapshot run check", runs(NODE_LINES[`${ACCEPTANCE} resolve`])], ["snapshot download", uses("download-artifact")], ["snapshot verification", runs("git -C check/portal write-tree")], ["upload", uses("upload-artifact")]],
  [`${ACCEPTANCE} acceptance`]: [["credential check", runs("compgen -e")], ["candidate fetch", runs("merge-tree --write-tree")], ["archive download", uses("download-artifact")], ["archive verification", runs("sha256sum -c")], ["setup-node", uses("setup-node")]],
  [`${REPORT} report`]: [["runner checkout", uses("checkout")], ["chain check", runs(NODE_LINES[`${REPORT} report`])], ["reporter token", uses("create-github-app-token")], ["post", runs("gh api")]],
};

/** Visits every string scalar with its key path. */
function walk(value, path, visit) {
  if (typeof value === "string") visit(value, path);
  else if (Array.isArray(value)) value.forEach((item, k) => walk(item, [...path, String(k)], visit));
  else if (isMap(value)) for (const [key, item] of Object.entries(value)) walk(item, [...path, key], visit);
}

function reviewExpressions(file, doc, available, failures) {
  const safe = file === ACCEPTANCE ? [...SAFE_EXPRESSIONS, ...ACCEPTANCE_EXPRESSIONS] : SAFE_EXPRESSIONS;
  walk(doc, [], (text, path) => {
    const where = `${file} ${path.join(".")}`;
    for (const match of text.matchAll(/\$\{\{([^}]*)\}\}/g)) {
      const expr = match[1].trim();
      if (path[path.length - 1] === "run") { failures.push(`${where}: expression \${{ ${expr} }} is expanded inside a script; pass it through env`); continue; }
      if (safe.some((pattern) => pattern.test(expr))) continue;
      const slot = path[0] === "jobs" && path[2] === "steps" ? `${file} ${path[1]} ${path.slice(4).join(".")} ${expr}` : "";
      const k = slot ? available.indexOf(slot) : -1;
      if (k < 0) failures.push(`${where}: \${{ ${expr} }} is not an allowed expression here (credentials appear only in their slots)`);
      else available.splice(k, 1);
    }
  });
}

function reviewUrls(file, doc, failures) {
  walk(doc, [], (text, path) => {
    const where = `${file} ${path.join(".")}`;
    if (HOSTED.test(text)) failures.push(`${where}: names a hosted endpoint`);
    if (/git@|ssh:\/\//.test(text)) failures.push(`${where}: uses an ssh remote`);
    const portalSlot = file === SNAPSHOT && path[0] === "jobs" && path[2] === "steps" && path[4] === "with" && ["repository", "repositories"].includes(path[5]);
    if (text.includes("LifeOS-Portal") && !portalSlot) failures.push(`${where}: names LifeOS-Portal outside the snapshot checkout and token`);
    for (const match of text.replace(/\$\{\{[^}]*\}\}/g, "x").matchAll(URL_PATTERN)) {
      const url = match[0];
      if (/^https:\/\/github\.com\//i.test(url)) { if (!PUBLIC_FETCH.test(url)) failures.push(`${where}: ${url} is not an approved public repository`); continue; }
      let host;
      try { host = new URL(url).hostname.toLowerCase(); } catch { failures.push(`${where}: holds an unparseable URL`); continue; }
      if (!LOOPBACK.has(host)) failures.push(`${where}: points at non-loopback host ${host}`);
    }
  });
}

function reviewEnv(env, where, failures) {
  for (const name of Object.keys(isMap(env) ? env : {})) if (RESERVED_ENV.test(name)) failures.push(`${where}: env ${name} would redirect the runner, git, the shell or Node`);
}

function reviewScript(id, spec, step, at, failures) {
  const text = String(step.run);
  for (const [pattern, why] of LEAKS) if (pattern.test(text)) failures.push(`${at}: the script ${why}`);
  if (!spec.credentialed && !spec.trusted) return;
  if (/\b(GH_TOKEN|GITHUB_TOKEN|PRIVATE_KEY|ACTIONS_RUNTIME_TOKEN)\b/.test(text)) failures.push(`${at}: the script names a credential (tools read it from the environment)`);
  const node = NODE_LINES[id];
  if (EXECUTORS.test(text) && text.trim() !== node) failures.push(`${at}: the script runs an interpreter, package manager or fetcher (only \`${node ?? "nothing"}\` may run here)`);
  if (spec.credentialed) {
    for (const line of text.split("\n").map((l) => l.trim()).filter(Boolean)) if (!CREDENTIALED_LINE.test(line)) failures.push(`${at}: "${line.slice(0, 50)}" is not an allowlisted command`);
    for (const match of text.matchAll(/\$\(([^)]*)/g)) if (!CREDENTIALED_SUBSTITUTION.test(match[1])) failures.push(`${at}: command substitution $(${match[1].slice(0, 40)}) is not allowlisted`);
  }
  for (const match of text.matchAll(GIT_WORD)) if (!ALLOWED_GIT[id] || !ALLOWED_GIT[id].test(match[1])) failures.push(`${at}: git${match[1].slice(0, 40)} is not an allowlisted git command`);
}

function reviewJob(file, jobId, job, failures) {
  const spec = JOBS[file][jobId];
  const id = `${file} ${jobId}`;
  const where = `${file} job ${jobId}`;
  if (!sameKeys(job, spec.keys)) failures.push(`${where}: must set exactly ${spec.keys.join(", ")} (found ${keysOf(job).join(", ")})`);
  if (listOf(job.needs).join() !== listOf(spec.needs).join()) failures.push(`${where}: needs must be [${listOf(spec.needs).join(", ")}]`);
  if (typeof job["runs-on"] !== "string" || !/^ubuntu-(latest|\d\d\.\d\d)$/.test(job["runs-on"])) failures.push(`${where}: runs-on must be a GitHub-hosted ubuntu runner`);
  if (!/^[1-9][0-9]?$/.test(String(job["timeout-minutes"] ?? ""))) failures.push(`${where}: timeout-minutes must be set (1-99)`);
  if (!sameMap(job.permissions, spec.permissions)) failures.push(`${where}: permissions must be exactly ${JSON.stringify(spec.permissions)}`);
  if (jobId === "resolve" && !sameMap(job.outputs, RESOLVE_OUTPUTS)) failures.push(`${where}: outputs must be exactly ${Object.keys(RESOLVE_OUTPUTS).join(", ")} from its own steps`);
  for (const [serviceId, service] of Object.entries(isMap(job.services) ? job.services : {})) {
    if (!isMap(service) || !SERVICE_IMAGE.test(String(service.image)) || keysOf(service).some((k) => !["image", "env", "options", "ports"].includes(k))) failures.push(`${where} service ${serviceId}: only the digest-pinned postgres:16-alpine image may run, with env, options and ports`);
    for (const [name, value] of Object.entries(isMap(service?.env) ? service.env : {})) if (CREDENTIAL_NAME.test(name) && value !== "${{ github.run_id }}") failures.push(`${where} service ${serviceId}: ${name} may only be the per-run value \${{ github.run_id }}`);
  }
  reviewEnv(job.env, where, failures);
  for (const name of Object.keys(isMap(job.env) ? job.env : {})) if (CREDENTIAL_NAME.test(name)) failures.push(`${where}: env ${name} looks like a credential`);
  const steps = Array.isArray(job.steps) ? job.steps : [];
  if (!steps.length || !steps.every(isMap)) { failures.push(`${where}: steps must be a non-empty list of mappings`); return; }

  const used = [];
  const stepEnv = {};
  steps.forEach((step, n) => {
    const at = `${where} step ${n + 1}`;
    const allowed = ["name", "id", "uses", "with", "run", "env", ...(jobId === "acceptance" ? ["working-directory"] : [])];
    const extra = keysOf(step).filter((k) => !allowed.includes(k));
    if (extra.length) failures.push(`${at}: may not set ${extra.join(", ")}`);
    if ((step.uses === undefined) === (step.run === undefined)) failures.push(`${at}: needs exactly one of uses or run`);
    if (step["working-directory"] !== undefined && !["ddi", "portal", "md"].includes(step["working-directory"])) failures.push(`${at}: working-directory must be ddi, portal or md`);
    reviewEnv(step.env, at, failures);
    for (const [name, value] of Object.entries(isMap(step.env) ? step.env : {})) {
      if (CREDENTIAL_NAME.test(name) && name !== "GH_TOKEN") failures.push(`${at}: env ${name} looks like a credential`);
      if (name === "GH_TOKEN" && (jobId === "acceptance" || !/^\$\{\{ [^}]+ \}\}$/.test(String(value)))) failures.push(`${at}: GH_TOKEN may only come from its credential slot`);
      stepEnv[name] = value;
    }
    if (step.run !== undefined) { reviewScript(id, spec, step, at, failures); return; }
    const name = actionName(step.uses);
    if (!name) { failures.push(`${at}: ${step.uses} is not an allowlisted action at its pinned commit`); return; }
    used.push(name);
    const expected = STEP_WITH[`${id} ${name}`];
    if (!spec.actions.includes(name) || !expected) { failures.push(`${at}: ${name} may not run in ${jobId}`); return; }
    if (!sameMap(step.with, expected.with) || (expected.id ? step.id !== expected.id : step.id !== undefined)) failures.push(`${at}: ${expected.why}: ${JSON.stringify(expected.id ? { id: expected.id, ...expected.with } : expected.with)}`);
  });
  if (used.slice().sort().join() !== spec.actions.slice().sort().join()) failures.push(`${where}: must use exactly ${spec.actions.join(", ")} once each (found ${used.join(", ") || "none"})`);

  const runText = steps.filter((s) => s.run !== undefined).map((s) => String(s.run)).join("\n");
  const lines = new Set(runText.split("\n").map((l) => l.trim()));
  for (const line of REQUIRED_LINES[id]) if (!lines.has(line)) failures.push(`${where}: the check \`${line.slice(0, 70)}\` is missing or changed`);
  const env = { ...(isMap(job.env) ? job.env : {}), ...stepEnv };
  for (const [name, value] of Object.entries(REQUIRED_ENV[id])) if (env[name] !== value) failures.push(`${where}: ${name} must be ${value}`);
  const gh = [...runText.matchAll(/(^|[\s;&|(])gh\b.*$/gm)].map((m) => m[0].slice(m[1].length).trim());
  const allowedGh = GH_CALLS[id];
  if (gh.length > (allowedGh ? 1 : 0)) failures.push(`${where}: makes ${gh.length} gh calls; at most ${allowedGh ? 1 : 0} allowed`);
  for (const call of gh) if (!allowedGh || !call.startsWith(allowedGh) || (jobId === "resolve" && /\s(-X|--method|-f|-F|--field|--raw-field|--input)\b/.test(call))) failures.push(`${where}: gh call "${call.slice(0, 60)}" is not allowed`);
  if (jobId === "report" && !gh.some((call) => call.startsWith(allowedGh))) failures.push(`${where}: must post the check ${CHECK_NAME} to DDI on the verified head`);

  const index = ORDER[id].map(([, test]) => steps.findIndex(test));
  const ordered = index.every((k, i) => k >= 0 && (i === 0 || k > index[i - 1]));
  const firstCode = jobId === "acceptance" ? steps.findIndex((s) => EXECUTORS.test(String(s.run ?? ""))) : -1;
  if (!ordered || (firstCode >= 0 && firstCode <= index[index.length - 1])) failures.push(`${where}: steps must run ${ORDER[id].map(([label]) => label).join(", ")}, in that order${jobId === "acceptance" ? ", before any other code" : ""}`);
}

function reviewWorkflow(file, source, failures, available) {
  const spec = WORKFLOWS[file];
  let doc;
  try { doc = parseWorkflowYaml(source); } catch (err) { failures.push(`${file} is not in the supported workflow syntax: ${err.message}`); return null; }
  for (const key of keysOf(doc)) if (!["name", "run-name", "on", "permissions", "concurrency", "env", "jobs"].includes(key)) failures.push(`${file}: top-level ${key} is not allowed`);
  if (doc.name !== spec.name) failures.push(`${file}: name must be "${spec.name}"`);
  if (doc["run-name"] !== spec.runName) failures.push(`${file}: run-name must be ${spec.runName ? `exactly "${spec.runName}" (the report reads it)` : "absent"}`);
  if (!spec.trigger(doc.on)) failures.push(`${file}: the only trigger must be ${spec.triggerText}`);
  if (!sameKeys(doc.permissions, [])) failures.push(`${file}: top-level permissions must be {} (each job grants its own)`);
  if (spec.env ? !sameKeys(doc.env, spec.env) : doc.env !== undefined) failures.push(`${file}: env must hold exactly ${spec.env ? spec.env.join(", ") : "nothing"}`);
  if (spec.untrusted) {
    const text = source.replace(/\r\n?/g, "\n").split("\n").filter((l) => !/^\s*#/.test(l)).join("\n");
    if (/\$\{\{[^}]*\b(secrets|vars)\b/.test(text) || /^\s*secrets:/m.test(text)) failures.push(`${file}: the untrusted workflow references a secret or variable (GitHub scrubs only unreferenced secrets)`);
  }
  if (!sameKeys(doc.jobs, Object.keys(JOBS[file]))) failures.push(`${file}: jobs must be exactly ${Object.keys(JOBS[file]).join(", ")}`);
  else for (const [jobId, job] of Object.entries(doc.jobs)) {
    if (!isMap(job)) failures.push(`${file} job ${jobId}: must be a mapping`);
    else reviewJob(file, jobId, job, failures);
  }
  reviewEnv(doc.env, file, failures);
  reviewExpressions(file, doc, available, failures);
  reviewUrls(file, doc, failures);
  return doc;
}

/** Reviews the runner's files (relative path → text); with `publicSource`, pins must match DDI's public workflow. */
export function reviewRunner(files, publicSource) {
  const failures = [];
  const names = Object.keys(files).sort();
  if (names.join() !== RUNNER_FILES.slice().sort().join()) failures.push(`the runner must hold exactly ${RUNNER_FILES.join(", ")} (found ${names.join(", ")})`);
  const available = [...CREDENTIAL_SLOTS];
  const docs = {};
  for (const file of [SNAPSHOT, ACCEPTANCE, REPORT]) {
    const source = files[`.github/workflows/${file}`];
    if (typeof source === "string") docs[file] = reviewWorkflow(file, source, failures, available);
  }
  const snapshotEnv = isMap(docs[SNAPSHOT]?.env) ? docs[SNAPSHOT].env : {};
  const pins = isMap(docs[ACCEPTANCE]?.env) ? docs[ACCEPTANCE].env : {};
  if (!PIN_NAMES.every((name) => SHA.test(String(pins[name])))) failures.push(`${ACCEPTANCE}: pins ${PIN_NAMES.join(", ")} must be full SHAs`);
  for (const name of ["PORTAL_SHA", "PORTAL_TREE"]) if (snapshotEnv[name] !== pins[name]) failures.push(`${SNAPSHOT}: ${name} must equal the acceptance workflow's pin`);
  if (!/^refs\/(tags|heads)\/[A-Za-z0-9._/-]+$/.test(String(snapshotEnv.PORTAL_REF ?? ""))) failures.push(`${SNAPSHOT}: PORTAL_REF must be a tag or branch ref approved by the Portal owner`);
  if (publicSource !== undefined) {
    let pub;
    try { pub = parseWorkflowYaml(publicSource); } catch (err) { failures.push(`public workflow is not in the supported syntax: ${err.message}`); return failures; }
    const env = isMap(pub.env) ? pub.env : {};
    for (const name of ["MD_SHA", "TRUSTID_SHA", "ELFCOM_SHA"]) if (env[name] !== pins[name]) failures.push(`${name} is ${pins[name]} here but ${env[name] ?? "absent"} in the public acceptance workflow`);
    if (env.PORTAL_SHA !== undefined && env.PORTAL_SHA !== pins.PORTAL_SHA) failures.push(`PORTAL_SHA is ${pins.PORTAL_SHA} here but ${env.PORTAL_SHA} in the public acceptance workflow`);
  }
  return failures;
}

/** Reads a runner directory: regular files only, never a symlink, paths with forward slashes. */
export function readRunnerDir(dir) {
  const files = {};
  const visit = (rel) => {
    for (const entry of readdirSync(join(dir, rel), { withFileTypes: true })) {
      const path = rel ? `${rel}/${entry.name}` : entry.name;
      const stat = lstatSync(join(dir, path));
      if (stat.isSymbolicLink()) throw new Error(`${path} is a symlink`);
      if (stat.isDirectory()) visit(path);
      else if (stat.isFile()) files[path] = readFileSync(join(dir, path), "utf8");
      else throw new Error(`${path} is not a regular file`);
    }
  };
  visit("");
  return files;
}

export function runReview(argv) {
  const failures = [];
  let dir = "";
  let publicWorkflow = "";
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--runner-dir") dir = argv[++i];
    else if (argv[i] === "--public-workflow") publicWorkflow = argv[++i];
    else failures.push(`unknown argument ${argv[i]}`);
  }
  if (!dir) failures.push("no --runner-dir given");
  if (failures.length) return failures;
  let files;
  try { files = readRunnerDir(dir); } catch (err) { return [`runner directory: ${err.message}`]; }
  return reviewRunner(files, publicWorkflow ? readFileSync(publicWorkflow, "utf8") : undefined);
}

if (process.argv[1] && /assert-private-acceptance\.mjs$/.test(process.argv[1])) {
  const failures = runReview(process.argv.slice(2));
  if (failures.length) {
    for (const failure of failures) console.error(`::error title=Private acceptance review::${failure}`);
    process.exit(1);
  }
  console.log("Private acceptance review passed: three trust boundaries, credentials in their slots, untrusted workflow secret-free, pins consistent.");
}
