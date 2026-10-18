#!/usr/bin/env node
/**
 * Stage 5C private acceptance review. Fails closed. Reads the private runner's workflow as data only
 * (never executes it) and checks the trust boundary in docs/phase-d3d-a-private-acceptance.md:
 *   node assert-private-acceptance.mjs --workflow <runner workflow> [--public-workflow <d3-cross-repo-acceptance.yml>]
 *
 *   - Trigger: workflow_dispatch only, with exactly the pr / head_sha / base inputs. Top-level
 *     permissions are empty; the jobs are exactly resolve, fetch-portal, acceptance and report, each
 *     with exactly the keys, needs, permissions and environment in JOBS.
 *   - Credentials: an expression may name a secret, a variable or a token only in CREDENTIAL_SLOTS (the
 *     two App-token steps, the Portal checkout, the report step and resolve's read of the public pull
 *     request); every other expression must be one of SAFE_EXPRESSIONS, and none is ever expanded inside
 *     a script. Each App token is scoped to one repository and one permission and revoked when its job
 *     ends. Credentialed jobs run only allowlisted commands (no Portal or candidate code), never name a
 *     credential in a script and never persist one to env files, outputs or logs.
 *   - Untrusted code: `acceptance` has no environment, no permissions, no outputs and no credential,
 *     nothing reads its outputs, and it verifies the Portal archive's digest and git tree before any
 *     dependency install or test runs.
 *   - Data paths: one upload (the one-day Portal archive, a single file) and one download; no caches;
 *     every action pinned to its allowlisted commit; URLs only to the public sibling repositories and
 *     loopback; LifeOS Portal is named only by its checkout and its token.
 *   - Pins: full SHAs, and (with --public-workflow) equal to the public acceptance workflow's pins.
 *   - Result: `report` runs once resolve succeeded, whatever happened after, posts the check
 *     `ddi-private-acceptance` to DDI and reports success only when fetch and acceptance both succeeded.
 */
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { HOSTED, parseWorkflowYaml } from "./assert-ci-safety.mjs";

const isMap = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const keysOf = (v) => (isMap(v) ? Object.keys(v) : []);
const sameKeys = (v, keys) => isMap(v) && keysOf(v).sort().join() === [...keys].sort().join();
const sameMap = (v, expected) => sameKeys(v, Object.keys(expected)) && Object.entries(expected).every(([k, x]) => v[k] === x);
const listOf = (v) => (v === undefined || v === null ? [] : Array.isArray(v) ? v : [v]);

export const CHECK_NAME = "ddi-private-acceptance";
const OWNER = "okoro0704-del";
const SHA = /^[0-9a-f]{40}$/;
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
const JOBS = {
  resolve: { needs: [], permissions: { contents: "read" }, keys: ["runs-on", "timeout-minutes", "permissions", "outputs", "steps"], actions: ["checkout"] },
  "fetch-portal": { needs: ["resolve"], permissions: {}, environment: "ddi-acceptance-portal-read", credentialed: true, keys: ["needs", "runs-on", "timeout-minutes", "environment", "permissions", "outputs", "steps"], actions: ["create-github-app-token", "checkout", "upload-artifact"] },
  acceptance: { needs: ["resolve", "fetch-portal"], permissions: {}, keys: ["needs", "runs-on", "timeout-minutes", "permissions", "services", "env", "steps"], actions: ["download-artifact", "setup-node"] },
  report: { needs: ["resolve", "fetch-portal", "acceptance"], permissions: {}, environment: "ddi-acceptance-report", credentialed: true, keys: ["needs", "if", "runs-on", "timeout-minutes", "environment", "permissions", "steps"], actions: ["create-github-app-token"] },
};
const REPORT_IF = "always() && needs.resolve.result == 'success'";
/** App tokens: one repository and one permission each; no other input (so never `skip-token-revoke`). */
const APP_TOKENS = {
  "fetch-portal": { id: "portal-reader", with: { "app-id": "${{ vars.PORTAL_READER_APP_ID }}", "private-key": "${{ secrets.PORTAL_READER_PRIVATE_KEY }}", owner: OWNER, repositories: "LifeOS-Portal", "permission-contents": "read" } },
  report: { id: "reporter", with: { "app-id": "${{ vars.DDI_REPORTER_APP_ID }}", "private-key": "${{ secrets.DDI_REPORTER_PRIVATE_KEY }}", owner: OWNER, repositories: "DDI", "permission-checks": "write" } },
};
const CHECKOUTS = {
  resolve: { ref: "${{ github.workflow_sha }}", path: "runner", "sparse-checkout": ".github/workflows", "persist-credentials": "false" },
  "fetch-portal": { repository: `${OWNER}/LifeOS-Portal`, ref: "${{ env.PORTAL_SHA }}", token: "${{ steps.portal-reader.outputs.token }}", path: "portal", "persist-credentials": "false" },
};
const UPLOAD = { name: "portal-source", path: "portal.tar.gz", "retention-days": "1", "if-no-files-found": "error", "compression-level": "0" };
const DOWNLOAD = { name: "portal-source", path: "portal-archive" };
/** Credential-bearing expressions and the only place each may appear: `<job> <step key path> <expression>`. */
export const CREDENTIAL_SLOTS = [
  "resolve env.GH_TOKEN github.token",
  "fetch-portal with.app-id vars.PORTAL_READER_APP_ID",
  "fetch-portal with.private-key secrets.PORTAL_READER_PRIVATE_KEY",
  "fetch-portal with.token steps.portal-reader.outputs.token",
  "report with.app-id vars.DDI_REPORTER_APP_ID",
  "report with.private-key secrets.DDI_REPORTER_PRIVATE_KEY",
  "report env.GH_TOKEN steps.reporter.outputs.token",
];
const SAFE_EXPRESSIONS = [
  /^inputs\.(pr|head_sha|base)$/,
  /^github\.(workflow_sha|ref|run_id|run_attempt|workspace)$/,
  /^env\.[A-Z][A-Z0-9_]*$/,
  /^needs\.(resolve|fetch-portal|acceptance)\.result$/,
  /^needs\.(resolve|fetch-portal)\.outputs\.[a-z0-9_]+$/, // never acceptance: its outputs are the candidate's
  /^steps\.[a-z][a-z0-9-]*\.outputs\.[a-z0-9_]+$/,
];
const CREDENTIAL_NAME = /(SECRET|PRIVATE_KEY|TOKEN|PASSWORD|API_KEY|CREDENTIAL)/i;
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
/** Credentialed and resolve scripts run only these tools; never an interpreter, package manager or fetcher. */
const EXECUTORS = /\b(npm|npx|node|tsx|yarn|pnpm|bun|deno|corepack|make|python3?|pip3?|ruby|perl|php|docker|sudo|curl|wget|bash|sh|zsh|source|eval|exec|chmod)\b|\.\//;
const CREDENTIALED_LINE = /^(set -euo pipefail$|\[ |\[\[ |git |echo |conclusion=|if \[ |summary=|gh )/;
const CREDENTIALED_SUBSTITUTION = /^(git -C portal rev-parse |sha256sum portal\.tar\.gz )/;
const FETCH_GIT = /^ -C portal (-c core\.autocrlf=false )?(rev-parse|archive) /;
const RESOLVE_GIT = /^ (init -q ddi$|-C ddi (fetch|rev-parse|merge-base|merge-tree|cat-file|show) |hash-object )/;
/** Lines that carry each job's checks; removing or rewording one weakens what the run proves. */
const REQUIRED_LINES = {
  resolve: [
    '[ "$REF" = refs/heads/main ] || fail "dispatch from main only"',
    '[[ "$HEAD_SHA" =~ ^[0-9a-f]{40}$ ]] || fail "head_sha must be a full commit SHA"',
    '[ "$head_repo" = okoro0704-del/DDI ] || fail "pull request $PR does not come from okoro0704-del/DDI"',
    '[ "$pr_head" = "$HEAD_SHA" ] || fail "pull request $PR has moved past $HEAD_SHA; review the new head and dispatch again"',
    'git -C ddi merge-base --is-ancestor "$base_sha" "$HEAD_SHA" || fail "the pull request is behind $BASE; update it, review the new head and dispatch again"',
    '[ "$merge_tree" = "$(git -C ddi rev-parse "$HEAD_SHA^{tree}")" ] || fail "the merge tree differs from the head tree"',
    'git -C ddi show "$HEAD_SHA:$template" | cmp -s - "$own" || fail "this runner\'s workflow differs from the candidate\'s $template"',
    "for pin in PORTAL_SHA MD_SHA TRUSTID_SHA ELFCOM_SHA; do",
    '[ "$declared" = "${!pin}" ] || fail "the candidate pins $pin=${declared:-none}; this runner pins ${!pin}"',
  ],
  "fetch-portal": [
    '[ "$(git -C portal rev-parse HEAD)" = "$PORTAL_SHA" ]',
    "[ \"$(git -C portal rev-parse 'HEAD^{tree}')\" = \"$PORTAL_TREE\" ]",
  ],
  acceptance: [
    "found=$(compgen -e | grep -iE 'SECRET|PRIVATE_KEY|TOKEN|PASSWORD|API_KEY|CREDENTIAL' | grep -vxE 'ACTIONS_RUNTIME_TOKEN|ACTIONS_ID_TOKEN_REQUEST_TOKEN' || true)",
    '[ "$(git -C ddi merge-tree --write-tree "$BASE_SHA" "$HEAD_SHA")" = "$MERGE_TREE" ]',
    "[ \"$(git -C ddi rev-parse 'HEAD^{tree}')\" = \"$MERGE_TREE\" ]",
    '[[ "$PORTAL_ARCHIVE_SHA256" =~ ^[0-9a-f]{64}$ ]]',
    'echo "$PORTAL_ARCHIVE_SHA256  portal-archive/portal.tar.gz" | sha256sum -c --quiet -',
    "[ ! -e portal/.git ]",
    '[ "$(git -C portal write-tree)" = "$PORTAL_TREE" ]',
  ],
  report: [
    "conclusion=failure",
    'if [ "$FETCH_RESULT" = success ] && [ "$ACCEPTANCE_RESULT" = success ]; then conclusion=success; fi',
  ],
};
const REQUIRED_ENV = {
  resolve: { REF: "${{ github.ref }}", PR: "${{ inputs.pr }}", HEAD_SHA: "${{ inputs.head_sha }}", BASE: "${{ inputs.base }}" },
  acceptance: { HEAD_SHA: "${{ needs.resolve.outputs.head_sha }}", BASE_SHA: "${{ needs.resolve.outputs.base_sha }}", MERGE_TREE: "${{ needs.resolve.outputs.merge_tree }}", PORTAL_ARCHIVE_SHA256: "${{ needs.fetch-portal.outputs.archive_sha256 }}" },
  report: { HEAD_SHA: "${{ needs.resolve.outputs.head_sha }}", FETCH_RESULT: "${{ needs.fetch-portal.result }}", ACCEPTANCE_RESULT: "${{ needs.acceptance.result }}" },
};
const REPORT_POST = `gh api --method POST repos/${OWNER}/DDI/check-runs --silent -f name=${CHECK_NAME} -f head_sha="$HEAD_SHA" -f status=completed -f conclusion="$conclusion" `;
const RESOLVE_GH = `gh api "repos/${OWNER}/DDI/pulls/$PR" --jq `;

/** Visits every string scalar with its key path. */
function walk(value, path, visit) {
  if (typeof value === "string") visit(value, path);
  else if (Array.isArray(value)) value.forEach((item, k) => walk(item, [...path, String(k)], visit));
  else if (isMap(value)) for (const [key, item] of Object.entries(value)) walk(item, [...path, key], visit);
}

function reviewExpressions(doc, failures) {
  const used = new Set();
  walk(doc, [], (text, path) => {
    const where = path.join(".");
    for (const match of text.matchAll(/\$\{\{([^}]*)\}\}/g)) {
      const expr = match[1].trim();
      if (path[path.length - 1] === "run") { failures.push(`${where}: expression \${{ ${expr} }} is expanded inside a script; pass it through env`); continue; }
      if (SAFE_EXPRESSIONS.some((safe) => safe.test(expr))) continue;
      const slot = path[0] === "jobs" && path[2] === "steps" ? `${path[1]} ${path.slice(4).join(".")} ${expr}` : "";
      if (!CREDENTIAL_SLOTS.includes(slot)) failures.push(`${where}: \${{ ${expr} }} is not an allowed expression here (credentials appear only in their slots)`);
      else if (used.has(slot)) failures.push(`${where}: \${{ ${expr} }} appears more than once`);
      else used.add(slot);
    }
  });
}

function reviewUrls(doc, failures) {
  walk(doc, [], (text, path) => {
    const where = path.join(".");
    if (HOSTED.test(text)) failures.push(`${where}: names a hosted endpoint`);
    if (/git@|ssh:\/\//.test(text)) failures.push(`${where}: uses an ssh remote`);
    const isPortalSlot = path[0] === "jobs" && path[1] === "fetch-portal" && path[2] === "steps" && path[4] === "with" && ["repository", "repositories"].includes(path[5]);
    if (text.includes("LifeOS-Portal") && !isPortalSlot) failures.push(`${where}: names LifeOS-Portal outside its checkout and token`);
    for (const match of text.replace(/\$\{\{[^}]*\}\}/g, "x").matchAll(URL_PATTERN)) {
      const url = match[0];
      if (/^https:\/\/github\.com\//i.test(url)) { if (!PUBLIC_FETCH.test(url)) failures.push(`${where}: ${url} is not an approved public repository`); continue; }
      let host;
      try { host = new URL(url).hostname.toLowerCase(); } catch { failures.push(`${where}: holds an unparseable URL`); continue; }
      if (!LOOPBACK.has(host)) failures.push(`${where}: points at non-loopback host ${host}`);
    }
  });
}

function reviewScript(jobId, step, n, failures) {
  const where = `job ${jobId} step ${n + 1}`;
  const text = String(step.run);
  for (const [pattern, why] of LEAKS) if (pattern.test(text)) failures.push(`${where}: the script ${why}`);
  const spec = JOBS[jobId];
  if (spec.credentialed || jobId === "resolve") {
    if (/\b(GH_TOKEN|GITHUB_TOKEN|PRIVATE_KEY|ACTIONS_RUNTIME_TOKEN)\b/.test(text)) failures.push(`${where}: the script names a credential (tools read it from the environment)`);
    if (EXECUTORS.test(text)) failures.push(`${where}: the script runs an interpreter, package manager or fetcher (no code may run beside a credential)`);
  }
  if (spec.credentialed) {
    for (const line of text.split("\n").map((l) => l.trim()).filter(Boolean)) if (!CREDENTIALED_LINE.test(line)) failures.push(`${where}: "${line.slice(0, 50)}" is not an allowlisted command`);
    for (const match of text.matchAll(/\$\(([^)]*)/g)) if (!CREDENTIALED_SUBSTITUTION.test(match[1])) failures.push(`${where}: command substitution $(${match[1].slice(0, 40)}) is not allowlisted`);
    for (const match of text.matchAll(/\bgit\b(.{0,80})/g)) if (jobId !== "fetch-portal" || !FETCH_GIT.test(match[1])) failures.push(`${where}: git${match[1].slice(0, 40)} is not an allowlisted git command`);
  }
  if (jobId === "resolve") for (const match of text.matchAll(/\bgit\b(.*)$/gm)) if (!RESOLVE_GIT.test(match[1])) failures.push(`${where}: git${match[1].slice(0, 40)} is not an allowlisted git command`);
  const gh = [...text.matchAll(/(^|[\s;&|(])gh\b.*$/gm)].map((m) => m[0].slice(m[1].length).trim());
  const allowedGh = jobId === "report" ? REPORT_POST : jobId === "resolve" ? RESOLVE_GH : undefined;
  if (allowedGh && gh.length > 1) failures.push(`${where}: makes ${gh.length} gh calls; exactly one is allowed`);
  for (const call of gh) if (!allowedGh || !call.startsWith(allowedGh) || (jobId === "resolve" && /\s(-X|--method|-f|-F|--field|--raw-field|--input)\b/.test(call))) failures.push(`${where}: gh call "${call.slice(0, 60)}" is not allowed`);
}

function reviewJob(jobId, job, workflowEnv, failures) {
  const spec = JOBS[jobId];
  const where = `job ${jobId}`;
  if (!sameKeys(job, spec.keys)) failures.push(`${where}: must set exactly ${spec.keys.join(", ")} (found ${keysOf(job).join(", ")})`);
  if (listOf(job.needs).join() !== spec.needs.join()) failures.push(`${where}: needs must be [${spec.needs.join(", ")}]`);
  if (jobId === "report" && job.if !== REPORT_IF) failures.push(`${where}: if must be exactly "${REPORT_IF}" (report every outcome once the candidate is resolved)`);
  if (typeof job["runs-on"] !== "string" || !/^ubuntu-(latest|\d\d\.\d\d)$/.test(job["runs-on"])) failures.push(`${where}: runs-on must be a GitHub-hosted ubuntu runner`);
  if (!/^[1-9][0-9]?$/.test(String(job["timeout-minutes"] ?? ""))) failures.push(`${where}: timeout-minutes must be set (1-99)`);
  if (!sameMap(job.permissions, spec.permissions)) failures.push(`${where}: permissions must be exactly ${JSON.stringify(spec.permissions)}`);
  if (job.environment !== spec.environment) failures.push(`${where}: environment must be ${spec.environment ?? "absent (no credentials reach this job)"}`);
  if (jobId === "acceptance") {
    for (const [serviceId, service] of Object.entries(isMap(job.services) ? job.services : {})) {
      if (!isMap(service) || !SERVICE_IMAGE.test(String(service.image)) || keysOf(service).some((k) => !["image", "env", "options", "ports"].includes(k))) failures.push(`${where} service ${serviceId}: only the digest-pinned postgres:16-alpine image may run, with env, options and ports`);
      for (const [name, value] of Object.entries(isMap(service?.env) ? service.env : {})) if (CREDENTIAL_NAME.test(name) && value !== "${{ github.run_id }}") failures.push(`${where} service ${serviceId}: ${name} may only be the per-run value \${{ github.run_id }}`);
    }
  }
  for (const [name, value] of Object.entries(isMap(job.env) ? job.env : {})) if (CREDENTIAL_NAME.test(name)) failures.push(`${where}: env ${name} looks like a credential`);
  const steps = Array.isArray(job.steps) ? job.steps : [];
  if (!steps.length || !steps.every(isMap)) { failures.push(`${where}: steps must be a non-empty list of mappings`); return; }

  const used = [];
  const runText = steps.filter((s) => s.run !== undefined).map((s) => String(s.run)).join("\n");
  const stepEnv = {};
  steps.forEach((step, n) => {
    const at = `${where} step ${n + 1}`;
    const allowed = ["name", "id", "uses", "with", "run", "env", ...(jobId === "acceptance" ? ["working-directory"] : [])];
    const extra = keysOf(step).filter((k) => !allowed.includes(k));
    if (extra.length) failures.push(`${at}: may not set ${extra.join(", ")}`);
    if ((step.uses === undefined) === (step.run === undefined)) failures.push(`${at}: needs exactly one of uses or run`);
    if (step["working-directory"] !== undefined && !["ddi", "portal", "md"].includes(step["working-directory"])) failures.push(`${at}: working-directory must be ddi, portal or md`);
    for (const [name, value] of Object.entries(isMap(step.env) ? step.env : {})) {
      if (CREDENTIAL_NAME.test(name) && name !== "GH_TOKEN") failures.push(`${at}: env ${name} looks like a credential`);
      if (name === "GH_TOKEN" && !/^\$\{\{ [^}]+ \}\}$/.test(String(value))) failures.push(`${at}: GH_TOKEN must come from its credential slot`);
      stepEnv[name] = value;
    }
    if (step.run !== undefined) { reviewScript(jobId, step, n, failures); return; }
    const name = actionName(step.uses);
    if (!name) { failures.push(`${at}: ${step.uses} is not an allowlisted action at its pinned commit`); return; }
    used.push(name);
    if (!spec.actions.includes(name)) failures.push(`${at}: ${name} may not run in ${jobId}`);
    if (name === "checkout" && !sameMap(step.with, CHECKOUTS[jobId] ?? {})) failures.push(`${at}: checkout must be exactly ${JSON.stringify(CHECKOUTS[jobId] ?? {})}`);
    if (name === "create-github-app-token" && (step.id !== APP_TOKENS[jobId].id || !sameMap(step.with, APP_TOKENS[jobId].with))) failures.push(`${at}: the App token must be exactly ${JSON.stringify(APP_TOKENS[jobId])} (one repository, one permission, revoked at job end)`);
    if (name === "upload-artifact" && !sameMap(step.with, UPLOAD)) failures.push(`${at}: the only artifact is ${JSON.stringify(UPLOAD)}`);
    if (name === "download-artifact" && !sameMap(step.with, DOWNLOAD)) failures.push(`${at}: the download must be exactly ${JSON.stringify(DOWNLOAD)}`);
    if (name === "setup-node" && !sameMap(step.with, { "node-version": "22" })) failures.push(`${at}: setup-node may set only node-version 22 (no cache)`);
  });
  if (used.slice().sort().join() !== spec.actions.slice().sort().join()) failures.push(`${where}: must use exactly ${spec.actions.join(", ")} once each (found ${used.join(", ") || "none"})`);

  const lines = new Set(runText.split("\n").map((l) => l.trim()));
  for (const line of REQUIRED_LINES[jobId]) if (!lines.has(line)) failures.push(`${where}: the check \`${line.slice(0, 70)}\` is missing or changed`);
  const env = { ...(isMap(job.env) ? job.env : {}), ...stepEnv };
  for (const [name, value] of Object.entries(REQUIRED_ENV[jobId] ?? {})) if (env[name] !== value) failures.push(`${where}: ${name} must be ${value}`);

  if (jobId === "acceptance") {
    const index = (test) => steps.findIndex(test);
    const order = [
      index((s) => String(s.run ?? "").includes("compgen -e")),
      index((s) => String(s.run ?? "").includes("merge-tree --write-tree")),
      index((s) => s.uses === ACTIONS["download-artifact"]),
      index((s) => String(s.run ?? "").includes("sha256sum -c")),
      index((s) => s.uses === ACTIONS["setup-node"]),
    ];
    const firstCode = index((s) => EXECUTORS.test(String(s.run ?? "")));
    if (order[0] !== 0 || order.some((k, i) => k < 0 || (i && k <= order[i - 1])) || (firstCode >= 0 && firstCode <= order[order.length - 1])) failures.push(`${where}: steps must run credential check, candidate fetch, archive download, archive verification and setup-node, in that order, before any other code`);
  }
  if (jobId === "report") {
    if ((runText.match(/conclusion=success/g) ?? []).length !== 1) failures.push(`${where}: success may be set only by the both-succeeded test`);
    if (!runText.split("\n").some((l) => l.trim().startsWith(REPORT_POST))) failures.push(`${where}: must post the check ${CHECK_NAME} to DDI on the resolved head`);
  }
  if (spec.credentialed || jobId === "resolve") for (const [name, value] of Object.entries(isMap(job.outputs) ? job.outputs : {})) if (/token|key|secret/i.test(`${name} ${value}`)) failures.push(`${where}: output ${name} would carry a credential`);
}

/** Reviews the runner workflow source; with `publicSource`, its pins must match the public workflow's. */
export function reviewPrivateAcceptance(source, publicSource) {
  const failures = [];
  let doc;
  try { doc = parseWorkflowYaml(source); } catch (err) { return [`not in the supported workflow syntax: ${err.message}`]; }
  const top = keysOf(doc);
  for (const key of top) if (!["name", "run-name", "on", "permissions", "concurrency", "env", "jobs"].includes(key)) failures.push(`top-level ${key} is not allowed`);
  const dispatch = isMap(doc.on) ? doc.on.workflow_dispatch : undefined;
  if (!sameKeys(doc.on, ["workflow_dispatch"]) || !sameKeys(dispatch, ["inputs"])) failures.push("the only trigger must be workflow_dispatch with inputs");
  else {
    const inputs = dispatch.inputs;
    const string = (input) => isMap(input) && input.required === "true" && input.type === "string" && sameKeys(input, ["description", "required", "type"]);
    const base = isMap(inputs) ? inputs.base : undefined;
    if (!sameKeys(inputs, ["pr", "head_sha", "base"]) || !string(inputs.pr) || !string(inputs.head_sha) || !isMap(base) || base.required !== "true" || base.type !== "choice" || listOf(base.options).join() !== "master,pdi") failures.push("inputs must be exactly pr and head_sha (required strings) and base (required choice of master, pdi)");
  }
  if (!sameKeys(doc.permissions, [])) failures.push("top-level permissions must be {} (each job grants its own)");
  if (!sameKeys(doc.env, PIN_NAMES) || !PIN_NAMES.every((name) => SHA.test(String(doc.env[name])))) failures.push(`env must hold exactly the full-SHA pins ${PIN_NAMES.join(", ")}`);
  if (!sameKeys(doc.jobs, Object.keys(JOBS))) failures.push(`jobs must be exactly ${Object.keys(JOBS).join(", ")}`);
  else for (const [jobId, job] of Object.entries(doc.jobs)) {
    if (!isMap(job)) failures.push(`job ${jobId}: must be a mapping`);
    else reviewJob(jobId, job, doc.env, failures);
  }
  reviewExpressions(doc, failures);
  reviewUrls(doc, failures);
  if (publicSource !== undefined && isMap(doc.env)) {
    let pub;
    try { pub = parseWorkflowYaml(publicSource); } catch (err) { failures.push(`public workflow is not in the supported syntax: ${err.message}`); return failures; }
    const env = isMap(pub.env) ? pub.env : {};
    for (const name of ["MD_SHA", "TRUSTID_SHA", "ELFCOM_SHA"]) if (env[name] !== doc.env[name]) failures.push(`${name} is ${doc.env[name]} here but ${env[name] ?? "absent"} in the public acceptance workflow`);
    if (env.PORTAL_SHA !== undefined && env.PORTAL_SHA !== doc.env.PORTAL_SHA) failures.push(`PORTAL_SHA is ${doc.env.PORTAL_SHA} here but ${env.PORTAL_SHA} in the public acceptance workflow`);
  }
  return failures;
}

export function runReview(argv) {
  const failures = [];
  let workflow = "";
  let publicWorkflow = "";
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--workflow") workflow = argv[++i];
    else if (argv[i] === "--public-workflow") publicWorkflow = argv[++i];
    else failures.push(`unknown argument ${argv[i]}`);
  }
  if (!workflow) failures.push("no --workflow given");
  if (failures.length) return failures;
  const read = (file) => readFileSync(file, "utf8");
  return reviewPrivateAcceptance(read(workflow), publicWorkflow ? read(publicWorkflow) : undefined).map((f) => `${basename(workflow)}: ${f}`);
}

if (process.argv[1] && /assert-private-acceptance\.mjs$/.test(process.argv[1])) {
  const failures = runReview(process.argv.slice(2));
  if (failures.length) {
    for (const failure of failures) console.error(`::error title=Private acceptance review::${failure}`);
    process.exit(1);
  }
  console.log("Private acceptance review passed: dispatch only, credentials in their slots, untrusted job isolated, pins consistent.");
}
