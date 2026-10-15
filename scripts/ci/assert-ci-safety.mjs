#!/usr/bin/env node
/**
 * D3D-A CI safety gate. Fails closed before any test runs.
 *
 * 1. Every URL-shaped environment value points at loopback (127.0.0.1, localhost, ::1), except the
 *    runner's own ACTIONS_* / GITHUB_* / RUNNER_* variables (github.com service endpoints the runner sets).
 * 2. No environment value names a hosted Digiconomy endpoint (Railway, Netlify, getlifeos.app, Supabase).
 * 3. No credential-shaped variable is present (names containing SECRET, PRIVATE_KEY, TOKEN, PASSWORD,
 *    API_KEY), except the runner's own ACTIONS_* / GITHUB_* plumbing. Test identities are generated
 *    inside the test processes and never pass through the environment.
 * 4. Each checkout is at its approved full commit SHA (`--pin <path>=<sha>`).
 * 5. The workflow file itself (`--workflow <path>`) references no secrets and no privileged triggers.
 *
 * Usage: node scripts/ci/assert-ci-safety.mjs --workflow <file> --pin <dir>=<sha> [--pin ...]
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
const HOSTED = /(\.railway\.(app|internal)|getlifeos\.app|netlify\.app|\.supabase\.co|lucid-integrity|distribution-hub-production)/i;
const CREDENTIAL_NAME = /(SECRET|PRIVATE_KEY|TOKEN|PASSWORD|API_KEY)/i;
const RUNNER_PLUMBING = /^(ACTIONS_|GITHUB_|RUNNER_)/;

const failures = [];
const args = process.argv.slice(2);
const pins = [];
let workflow = "";
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--pin") pins.push(args[++i]);
  else if (args[i] === "--workflow") workflow = args[++i];
  else failures.push(`unknown argument ${args[i]}`);
}

for (const [name, value] of Object.entries(process.env)) {
  if (!value) continue;
  if (HOSTED.test(value)) failures.push(`${name} names a hosted endpoint`);
  if (RUNNER_PLUMBING.test(name)) continue;
  for (const match of value.matchAll(/\b(?:https?|postgres(?:ql)?|redis|wss?):\/\/[^\s"']+/gi)) {
    let host;
    try { host = new URL(match[0]).hostname; } catch { failures.push(`${name} holds an unparseable URL`); continue; }
    if (!LOOPBACK.has(host)) failures.push(`${name} points at non-loopback host ${host}`);
  }
  if (CREDENTIAL_NAME.test(name) && !RUNNER_PLUMBING.test(name)) failures.push(`${name} looks like a credential and must not be present`);
}

if (!pins.length) failures.push("no --pin given: every checkout must be verified");
for (const pin of pins) {
  const [dir, expected] = pin.split("=");
  if (!dir || !/^[0-9a-f]{40}$/.test(expected ?? "")) { failures.push(`pin ${pin} must be <dir>=<full 40-hex sha>`); continue; }
  let actual = "";
  try { actual = execFileSync("git", ["-C", dir, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(); } catch { failures.push(`${dir} is not a git checkout`); continue; }
  if (actual !== expected) failures.push(`${dir} is at ${actual}, expected ${expected}`);
}

if (!workflow) failures.push("no --workflow given");
else {
  // Judge what the workflow does, not what its comments say.
  const text = readFileSync(workflow, "utf8").split("\n").map(line => line.replace(/(^|\s)#.*$/, "")).join("\n");
  if (/\$\{\{\s*secrets\./.test(text)) failures.push(`${workflow} references secrets`);
  if (/pull_request_target|workflow_run/.test(text)) failures.push(`${workflow} uses a privileged trigger`);
  if (/permissions:\s*write-all|:\s*write\b/.test(text)) failures.push(`${workflow} requests write permissions`);
  for (const use of text.matchAll(/uses:\s*([^\s#]+)/g)) if (!/@[0-9a-f]{40}$/.test(use[1])) failures.push(`${workflow}: ${use[1]} is not pinned to a full commit SHA`);
}

if (failures.length) {
  for (const failure of failures) console.error(`::error title=CI safety gate::${failure}`);
  process.exit(1);
}
console.log(`CI safety gate passed: ${pins.length} pinned checkouts, loopback-only endpoints, no credentials, no secrets.`);
