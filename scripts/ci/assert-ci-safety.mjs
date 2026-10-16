#!/usr/bin/env node
/**
 * D3D CI safety gate. Fails closed.
 *
 * Runtime mode (inside a CI job, before any dependency install or test):
 *   node assert-ci-safety.mjs --workflow <file> --pin <dir>=<sha> [--pin ...]
 *   1. Every URL in every environment value points at loopback (127.0.0.1, localhost, ::1). The only
 *      exceptions are the runner's own service endpoints, by exact name, each pinned to its trusted
 *      host over https (RUNNER_URLS). No prefix is exempt: ACTIONS_X=https://anywhere fails.
 *   2. No environment value names a hosted Digiconomy endpoint (Railway, Netlify, getlifeos.app, Supabase).
 *   3. No credential-shaped variable is present (names containing SECRET, PRIVATE_KEY, TOKEN, PASSWORD,
 *      API_KEY, CREDENTIAL), except the runner's own credentials by exact name (RUNNER_CREDENTIALS).
 *      Test identities are generated inside the test processes and never pass through the environment.
 *   4. Each checkout is at its approved full commit SHA.
 *   5. The workflow file passes the static review below.
 *
 * Static mode (trusted pull_request_target review; executes nothing from the pull request):
 *   node assert-ci-safety.mjs --static --workflow <file> [--workflow ...]
 *   Each workflow: no secrets (`${{ secrets.* }}`, `secrets: inherit`), no privileged triggers, explicit
 *   read-only permissions, every `uses:` pinned to a full commit SHA, loopback-only URLs in assignments,
 *   no hosted endpoints, and credential-named variables only with the per-run value `${{ github.run_id }}`.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
const HOSTED = /(\.railway\.(app|internal)|getlifeos\.app|netlify\.app|\.supabase\.co|lucid-integrity|distribution-hub-production)/i;
const CREDENTIAL_NAME = /(SECRET|PRIVATE_KEY|TOKEN|PASSWORD|API_KEY|CREDENTIAL)/i;
const URL_PATTERN = /\b(?:https?|postgres(?:ql)?|redis|mysql|mongodb(?:\+srv)?|amqps?|wss?):\/\/[^\s"']+/gi;
const actionsHost = (host) => host === "actions.githubusercontent.com" || host.endsWith(".actions.githubusercontent.com");
/** The runner's own service endpoints: exact names, trusted hosts, https only. */
export const RUNNER_URLS = {
  GITHUB_SERVER_URL: (host) => host === "github.com",
  GITHUB_API_URL: (host) => host === "api.github.com",
  GITHUB_GRAPHQL_URL: (host) => host === "api.github.com",
  ACTIONS_RESULTS_URL: actionsHost,
  ACTIONS_RUNTIME_URL: actionsHost,
  ACTIONS_CACHE_URL: actionsHost,
  ACTIONS_ID_TOKEN_REQUEST_URL: actionsHost,
};
/** The runner's own credentials, by exact name. Never GITHUB_TOKEN: these jobs do not export it. */
export const RUNNER_CREDENTIALS = new Set(["ACTIONS_RUNTIME_TOKEN", "ACTIONS_ID_TOKEN_REQUEST_TOKEN"]);
const PRIVILEGED_TRIGGERS = ["pull_request_target", "workflow_run"];

/** Drops YAML comments without touching a `#` inside a quoted string. */
export function stripComments(text) {
  return text.split("\n").map((line) => {
    let quote = "";
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (quote) {
        if (c === quote && !(quote === '"' && line[i - 1] === "\\")) quote = "";
      } else if (c === '"' || c === "'") quote = c;
      else if (c === "#" && (i === 0 || /\s/.test(line[i - 1]))) return line.slice(0, i);
    }
    return line;
  }).join("\n");
}

function checkRuntimeEnvironment(env, failures) {
  for (const [name, value] of Object.entries(env)) {
    if (!value) continue;
    if (HOSTED.test(value)) failures.push(`${name} names a hosted endpoint`);
    if (CREDENTIAL_NAME.test(name) && !RUNNER_CREDENTIALS.has(name)) failures.push(`${name} looks like a credential and must not be present`);
    const trustedHost = RUNNER_URLS[name];
    if (trustedHost) {
      let url;
      try { url = new URL(value); } catch { failures.push(`${name} is not a URL`); continue; }
      if (url.protocol !== "https:" || url.username || url.password || !trustedHost(url.hostname.toLowerCase())) failures.push(`${name} points at an untrusted endpoint ${url.hostname}`);
      continue;
    }
    for (const match of value.matchAll(URL_PATTERN)) {
      let host;
      try { host = new URL(match[0]).hostname.toLowerCase(); } catch { failures.push(`${name} holds an unparseable URL`); continue; }
      if (!LOOPBACK.has(host)) failures.push(`${name} points at non-loopback host ${host}`);
    }
  }
}

function checkWorkflow(file, failures) {
  let raw;
  try { raw = readFileSync(file, "utf8"); } catch { failures.push(`${file} cannot be read`); return; }
  const text = stripComments(raw);
  if (/\$\{\{[^}]*\bsecrets\b/.test(text) || /^\s*secrets:\s*inherit\b/m.test(text)) failures.push(`${file} references secrets`);
  for (const trigger of PRIVILEGED_TRIGGERS) if (new RegExp(`\\b${trigger}\\b`).test(text)) failures.push(`${file} uses the privileged trigger ${trigger}`);
  if (!/^permissions:\s*$/m.test(text) && !/^permissions:\s*\{?\s*contents:\s*read\s*\}?\s*$/m.test(text)) failures.push(`${file} does not declare top-level read-only permissions`);
  if (/permissions:\s*(write-all|read-all)/.test(text) || /^\s+[a-z-]+:\s*write\b/m.test(text)) failures.push(`${file} requests write permissions`);
  for (const use of text.matchAll(/uses:\s*["']?([^\s"'#]+)/g)) if (!/^[\w.-]+\/[\w./-]+@[0-9a-f]{40}$/.test(use[1])) failures.push(`${file}: ${use[1]} is not pinned to a full commit SHA`);
  // Static view of every UPPER_CASE assignment (env blocks, service containers, workflow env).
  for (const line of text.split("\n")) {
    const assignment = /^\s+([A-Z][A-Z0-9_]*):\s*(.*)$/.exec(line);
    if (!assignment) continue;
    const [, name, rawValue] = assignment;
    const value = rawValue.trim().replace(/^["']|["']$/g, "");
    if (HOSTED.test(value)) failures.push(`${file}: ${name} names a hosted endpoint`);
    if (CREDENTIAL_NAME.test(name) && value && value !== "${{ github.run_id }}") failures.push(`${file}: ${name} looks like a credential; only the per-run value \${{ github.run_id }} is allowed`);
    const resolved = value.replace(/\$\{\{[^}]*\}\}/g, "x");
    for (const match of resolved.matchAll(URL_PATTERN)) {
      let host;
      try { host = new URL(match[0]).hostname.toLowerCase(); } catch { failures.push(`${file}: ${name} holds an unparseable URL`); continue; }
      if (!LOOPBACK.has(host)) failures.push(`${file}: ${name} points at non-loopback host ${host}`);
    }
  }
}

function checkPins(pins, failures) {
  if (!pins.length) failures.push("no --pin given: every checkout must be verified");
  for (const pin of pins) {
    const [dir, expected] = pin.split("=");
    if (!dir || !/^[0-9a-f]{40}$/.test(expected ?? "")) { failures.push(`pin ${pin} must be <dir>=<full 40-hex sha>`); continue; }
    let actual = "";
    try { actual = execFileSync("git", ["-C", dir, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(); } catch { failures.push(`${dir} is not a git checkout`); continue; }
    if (actual !== expected) failures.push(`${dir} is at ${actual}, expected ${expected}`);
  }
}

export function runGate(argv, env) {
  const failures = [];
  const pins = [];
  const workflows = [];
  let staticMode = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--pin") pins.push(argv[++i]);
    else if (argv[i] === "--workflow") workflows.push(argv[++i]);
    else if (argv[i] === "--static") staticMode = true;
    else failures.push(`unknown argument ${argv[i]}`);
  }
  if (!workflows.length) failures.push("no --workflow given");
  for (const workflow of workflows) checkWorkflow(workflow, failures);
  if (!staticMode) {
    checkRuntimeEnvironment(env, failures);
    checkPins(pins, failures);
  }
  return { failures, summary: staticMode ? `${workflows.length} workflow(s) reviewed statically` : `${pins.length} pinned checkouts, allowlisted runner endpoints only, no credentials, no secrets` };
}

if (import.meta.url === `file://${process.argv[1].replace(/\\/g, "/").replace(/^(?=[A-Za-z]:)/, "/")}` || process.argv[1]?.endsWith("assert-ci-safety.mjs")) {
  const { failures, summary } = runGate(process.argv.slice(2), process.env);
  if (failures.length) {
    for (const failure of failures) console.error(`::error title=CI safety gate::${failure}`);
    process.exit(1);
  }
  console.log(`CI safety gate passed: ${summary}.`);
}
