#!/usr/bin/env node
/**
 * D3D CI safety gate. Fails closed. Never executes, imports or evaluates the files it reviews.
 *
 * Runtime mode (inside a CI job, before any dependency install or test):
 *   node assert-ci-safety.mjs --workflow <file> --pin <dir>=<sha> [--pin ...]
 *   1. Every URL in every environment value points at loopback (127.0.0.1, localhost, ::1). The only
 *      exceptions are the runner's own service endpoints, by exact name, each pinned to its trusted
 *      host over https (RUNNER_URLS). No prefix is exempt: ACTIONS_X=https://anywhere fails.
 *   2. No environment value names a hosted Digiconomy endpoint (Railway, Netlify, getlifeos.app, Supabase).
 *   3. No credential-shaped variable is present (names containing SECRET, PRIVATE_KEY, TOKEN, PASSWORD,
 *      API_KEY, CREDENTIAL), except the runner's own credentials by exact name (RUNNER_CREDENTIALS).
 *   4. Each checkout is at its approved full commit SHA.
 *   5. The workflow file passes the review below.
 *
 * Static mode (trusted pull_request_target review of a pull request's files, read as data only):
 *   node assert-ci-safety.mjs --static --workflows-dir <dir> [--exclude <name>] [--require <name>]
 *                             [--self <trusted copy of the review workflow>]
 *   node assert-ci-safety.mjs --static --workflow <file> [--workflow ...]
 *
 * Review of each workflow:
 *   - Text: no secrets (`${{ secrets.* }}`, `secrets: inherit`), no privileged triggers, read-only
 *     permissions, every `uses:` pinned to a full commit SHA, loopback-only URLs and no hosted
 *     endpoints in assignments, credential-named variables only with `${{ github.run_id }}`.
 *   - Structure (strict YAML subset; anything else fails): every job of a workflow that pull requests
 *     can trigger must start with pinned checkouts, check out the base commit into `trusted-gate`,
 *     and run the gate from there as its first command, with the canonical text, on this same
 *     workflow, pinning every external checkout. Nothing may disable, condition, redirect or
 *     pre-empt it (no `if`, `continue-on-error`, `shell`, `working-directory`, `defaults`, `container`,
 *     reusable-workflow jobs, or interpreter-hijacking environment variables).
 *   - Paths: the workflows directory and every component above it are real directories inside the
 *     working directory; entries are regular `.yml`/`.yaml` files, never symlinks or other types.
 */
import { execFileSync } from "node:child_process";
import { closeSync, constants, fstatSync, lstatSync, openSync, readdirSync, readFileSync, readSync, realpathSync } from "node:fs";
import { basename, isAbsolute, relative, resolve, sep } from "node:path";

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
/** Variables that make a shell or Node load or run something other than the trusted gate. */
const HIJACKING_ENV = /^(NODE_OPTIONS|NODE_PATH|NODE_EXTRA_CA_CERTS|NODE_REPL_EXTERNAL_MODULE|BASH_ENV|ENV|SHELLOPTS|BASHOPTS|PS4|PROMPT_COMMAND|LD_PRELOAD|LD_LIBRARY_PATH|LD_AUDIT|DYLD_[A-Z_]+|PATH|HOME|GIT_[A-Z_]+|NPM_CONFIG_[A-Z_]+|PYTHONPATH|PYTHONSTARTUP|PERL5OPT|PERL5LIB|RUBYOPT)$/i;
const MAX_WORKFLOW_BYTES = 512 * 1024;

const TRUSTED_GATE_PATH = "trusted-gate";
const TRUSTED_GATE_REF = "${{ github.event.pull_request.base.sha || github.sha }}";
const GATE_SCRIPT = `${TRUSTED_GATE_PATH}/scripts/ci/assert-ci-safety.mjs`;
const GATE_PREAMBLE = [
  `if [ ! -f ${GATE_SCRIPT} ]; then`,
  `echo "::error title=CI safety gate::the base branch has no trusted safety gate; merge the gate into the base first"`,
  "exit 1",
  "fi",
  `node ${GATE_SCRIPT} \\`,
];
const PINNED_ACTION = (name) => new RegExp(`^actions/${name}@[0-9a-f]{40}$`);
/** Repositories an acceptance job may check out besides itself (each still pinned to a full SHA). */
const EXTERNAL_REPOSITORIES = new Set(["okoro0704-del/LifeOS-Portal", "okoro0704-del/MasternDistribution", "okoro0704-del/TRUSTID", "okoro0704-del/elfCOM"]);
/**
 * Service containers start before any step. Only the digest-pinned disposable PostgreSQL image, with
 * health-check options and no volumes, may run; anything else could rewrite the workspace (including
 * the trusted gate) before the gate step runs.
 */
const SERVICE_IMAGE = /^postgres:16-alpine@sha256:[0-9a-f]{64}$/;
const SERVICE_OPTIONS = /^(\s*--health-(cmd "[^"$`\\;&|<>]*"|interval \d+s|timeout \d+s|retries \d+)\s*)*$/;

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

/**
 * Strict YAML-subset parser for workflow files: block mappings and sequences, plain and quoted
 * scalars, block scalars, single-line flow sequences. Anything else (anchors, aliases, tags, flow
 * mappings, quoted or complex keys, duplicate keys, tab indentation, multiple documents) throws, so
 * an unusual construct can never be read differently here than by GitHub.
 */
export function parseWorkflowYaml(source) {
  const raw = source.replace(/\r\n?/g, "\n").split("\n");
  const overrides = new Map();
  let i = 0;
  const fail = (message) => { throw new Error(`line ${i + 1}: ${message}`); };
  const indentOf = (text) => {
    const lead = /^[ \t]*/.exec(text)[0];
    if (lead.includes("\t")) fail("tab indentation is not allowed");
    return lead.length;
  };
  const line = (k) => {
    if (overrides.has(k)) return overrides.get(k);
    const text = stripComments(raw[k]);
    return { indent: indentOf(text), text: text.trim() };
  };
  const skipBlank = () => { while (i < raw.length && line(i).text === "") i++; };
  const isSeqItem = (l) => l.text === "-" || l.text.startsWith("- ");
  const KEY = /^([A-Za-z_][A-Za-z0-9_-]*|[0-9]+)\s*:(?:\s+(.*))?$/;

  for (const [k, text] of raw.entries()) if (/^(---|\.\.\.)(\s|$)/.test(text)) { i = k; fail("document markers are not allowed"); }

  const inlineValue = (value, ownerIndent) => {
    if (/^[|>][-+]?$/.test(value)) {
      let k = i;
      while (k < raw.length && (raw[k].trim() === "" || indentOf(raw[k]) > ownerIndent)) k++;
      const body = raw.slice(i, k);
      while (body.length && body[body.length - 1].trim() === "") body.pop();
      const first = body.find((l) => l.trim() !== "");
      const blockIndent = first === undefined ? 0 : indentOf(first);
      const lines = body.map((l) => {
        if (l.trim() === "") return "";
        if (indentOf(l) < blockIndent) fail("block scalar is under-indented");
        return l.slice(blockIndent);
      });
      i = k;
      const text = value[0] === ">" ? lines.join(" ").replace(/ {2,}/g, " ") : lines.join("\n");
      return value.endsWith("-") ? text : `${text}\n`;
    }
    if (/^[&*!%@`]/.test(value)) fail("anchors, aliases, tags and reserved indicators are not allowed");
    if (value.startsWith("{")) fail("flow mappings are not allowed");
    if (value.startsWith("[")) {
      if (!value.endsWith("]")) fail("flow sequences must be on one line");
      const inner = value.slice(1, -1).trim();
      if (!inner) return [];
      return inner.split(",").map((item) => {
        const v = item.trim();
        if (!/^[A-Za-z0-9_./*-]+$/.test(v)) fail(`unsupported flow sequence item "${v}"`);
        return v;
      });
    }
    if (value.startsWith('"')) {
      const m = /^"((?:[^"\\]|\\.)*)"$/.exec(value);
      if (!m) fail("unterminated or trailing double-quoted scalar");
      return m[1].replace(/\\(.)/g, (_, c) => ({ n: "\n", t: "\t", '"': '"', "\\": "\\" })[c] ?? fail(`unsupported escape \\${c}`));
    }
    if (value.startsWith("'")) {
      const m = /^'((?:[^']|'')*)'$/.exec(value);
      if (!m) fail("unterminated or trailing single-quoted scalar");
      return m[1].replace(/''/g, "'");
    }
    if (/:(\s|$)/.test(value)) fail("plain scalar contains ': ' (ambiguous mapping)");
    return value;
  };

  const node = (parentIndent) => {
    skipBlank();
    if (i >= raw.length || line(i).indent <= parentIndent) return null;
    return isSeqItem(line(i)) ? sequence(line(i).indent) : mapping(line(i).indent);
  };

  const mapping = (indent) => {
    const obj = Object.create(null);
    for (;;) {
      skipBlank();
      if (i >= raw.length) break;
      const l = line(i);
      if (l.indent < indent) break;
      if (l.indent > indent) fail("unexpected indentation");
      if (isSeqItem(l)) fail("unexpected sequence item in a mapping");
      const m = KEY.exec(l.text);
      if (!m) fail(`unsupported mapping entry "${l.text.slice(0, 40)}"`);
      const key = m[1];
      if (key === "__proto__" || Object.hasOwn(obj, key)) fail(`duplicate or forbidden key "${key}"`);
      const value = m[2] ?? "";
      i++;
      if (value === "") {
        skipBlank();
        if (i < raw.length && line(i).indent > indent) obj[key] = node(indent);
        else if (i < raw.length && line(i).indent === indent && isSeqItem(line(i))) obj[key] = sequence(indent);
        else obj[key] = null;
      } else obj[key] = inlineValue(value, indent);
    }
    return obj;
  };

  const sequence = (indent) => {
    const items = [];
    for (;;) {
      skipBlank();
      if (i >= raw.length) break;
      const l = line(i);
      if (l.indent < indent) break;
      if (l.indent > indent) fail("unexpected indentation");
      if (!isSeqItem(l)) break;
      const rest = l.text === "-" ? "" : l.text.slice(1).trimStart();
      const restIndent = l.indent + (l.text.length - rest.length);
      if (rest === "") { i++; items.push(node(indent)); }
      else if (rest.startsWith("- ") || rest === "-") fail("nested sequences on one line are not allowed");
      else if (KEY.test(rest)) { overrides.set(i, { indent: restIndent, text: rest }); items.push(mapping(restIndent)); }
      else { i++; items.push(inlineValue(rest, indent)); }
    }
    return items;
  };

  const doc = node(-1);
  skipBlank();
  if (i < raw.length) fail("content outside the document");
  if (!doc || Array.isArray(doc)) fail("a workflow must be a mapping");
  return doc;
}

const isMap = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const keysOf = (v) => (isMap(v) ? Object.keys(v) : []);

function triggersOf(on) {
  if (typeof on === "string") return [on];
  if (Array.isArray(on)) return on;
  if (isMap(on)) return Object.keys(on);
  return null;
}

function checkHijackingEnv(env, where, failures) {
  if (env === null || env === undefined) return;
  if (!isMap(env)) { failures.push(`${where}: env must be a mapping`); return; }
  for (const name of Object.keys(env)) if (HIJACKING_ENV.test(name)) failures.push(`${where}: ${name} can change what the gate runs and is not allowed`);
}

/** Structural review: the runtime gate must be present, first, trusted and impossible to bypass. */
function reviewStructure(doc, file, failures) {
  const name = basename(file);
  const triggers = triggersOf(doc.on);
  if (!triggers) { failures.push(`${name}: unsupported 'on' trigger syntax`); return; }
  if (!triggers.includes("pull_request")) return;
  if (!isMap(doc.permissions) || keysOf(doc.permissions).join() !== "contents" || doc.permissions.contents !== "read") failures.push(`${name}: permissions must be exactly 'contents: read'`);
  if (doc.defaults !== undefined) failures.push(`${name}: workflow 'defaults' are not allowed (they can redirect the gate)`);
  checkHijackingEnv(doc.env, `${name} (workflow)`, failures);
  const workflowEnv = isMap(doc.env) ? doc.env : {};
  if (!isMap(doc.jobs) || !keysOf(doc.jobs).length) { failures.push(`${name}: no jobs`); return; }
  for (const [jobId, job] of Object.entries(doc.jobs)) {
    const where = `${name} job ${jobId}`;
    if (!isMap(job)) { failures.push(`${where}: must be a mapping`); continue; }
    for (const key of ["container", "defaults", "continue-on-error", "if", "uses", "permissions", "secrets"]) if (job[key] !== undefined) failures.push(`${where}: '${key}' is not allowed (it can bypass, disable or redirect the gate)`);
    if (typeof job["runs-on"] !== "string" || !/^ubuntu-/.test(job["runs-on"])) failures.push(`${where}: runs-on must be a GitHub-hosted ubuntu runner`);
    checkHijackingEnv(job.env, where, failures);
    if (job.services !== undefined && job.services !== null) {
      if (!isMap(job.services)) failures.push(`${where}: services must be a mapping`);
      else for (const [serviceId, service] of Object.entries(job.services)) {
        const at = `${where} service ${serviceId}`;
        if (!isMap(service)) { failures.push(`${at}: must be a mapping`); continue; }
        const extra = keysOf(service).filter((k) => !["image", "env", "options", "ports"].includes(k));
        if (extra.length) failures.push(`${at}: may not set ${extra.join(", ")} (service containers start before the gate)`);
        if (typeof service.image !== "string" || !SERVICE_IMAGE.test(service.image)) failures.push(`${at}: only the digest-pinned postgres:16-alpine image may run as a service`);
        if (service.options !== undefined && (typeof service.options !== "string" || !SERVICE_OPTIONS.test(service.options))) failures.push(`${at}: options may only set --health-* checks`);
        if (service.env !== undefined && !isMap(service.env)) failures.push(`${at}: env must be a mapping`);
      }
    }
    const steps = Array.isArray(job.steps) ? job.steps : [];
    if (!steps.length) { failures.push(`${where}: no steps`); continue; }
    steps.forEach((step, n) => { if (isMap(step)) checkHijackingEnv(step.env, `${where} step ${n + 1}`, failures); else failures.push(`${where} step ${n + 1}: must be a mapping`); });

    const gateIndex = steps.findIndex((step) => isMap(step) && step.run !== undefined);
    if (gateIndex < 0) { failures.push(`${where}: the runtime safety gate step is missing`); continue; }

    // Checkouts: every one into its own plain directory, credentials not persisted; external ones pinned.
    const checkouts = [];
    steps.forEach((step, n) => {
      if (!isMap(step) || typeof step.uses !== "string" || !step.uses.startsWith("actions/checkout@")) return;
      const withs = isMap(step.with) ? step.with : {};
      const path = withs.path;
      if (typeof path !== "string" || !/^[A-Za-z0-9_-]+$/.test(path)) failures.push(`${where} step ${n + 1}: every checkout needs a plain 'path' directory name`);
      if (withs["persist-credentials"] !== "false") failures.push(`${where} step ${n + 1}: checkouts must set persist-credentials: false`);
      checkouts.push({ n, step, withs, path });
    });
    const trusted = checkouts.filter((c) => c.path === TRUSTED_GATE_PATH);
    if (trusted.length !== 1) failures.push(`${where}: exactly one checkout must use path '${TRUSTED_GATE_PATH}' (found ${trusted.length})`);
    else {
      const t = trusted[0];
      if (t.n > gateIndex) failures.push(`${where}: the trusted checkout must come before the gate`);
      if (keysOf(t.withs).sort().join() !== ["path", "persist-credentials", "ref", "sparse-checkout"].join()) failures.push(`${where}: the trusted checkout may set only ref, path, sparse-checkout and persist-credentials`);
      if (t.withs.ref !== TRUSTED_GATE_REF) failures.push(`${where}: the trusted checkout must check out the base commit (${TRUSTED_GATE_REF})`);
      if (t.withs["sparse-checkout"] !== "scripts/ci") failures.push(`${where}: the trusted checkout must be sparse on scripts/ci`);
    }
    const own = checkouts.filter((c) => c.withs.repository === undefined && c.path !== TRUSTED_GATE_PATH);
    if (own.length !== 1) failures.push(`${where}: expected exactly one checkout of this repository besides the trusted gate (found ${own.length})`);
    const external = checkouts.filter((c) => c.withs.repository !== undefined);
    for (const c of external) {
      if (!EXTERNAL_REPOSITORIES.has(String(c.withs.repository))) failures.push(`${where} step ${c.n + 1}: repository ${c.withs.repository} is not an approved dependency`);
      const m = /^\$\{\{ env\.([A-Z][A-Z0-9_]*_SHA) \}\}$/.exec(String(c.withs.ref ?? ""));
      if (!m || !/^[0-9a-f]{40}$/.test(String(workflowEnv[m[1]] ?? ""))) failures.push(`${where} step ${c.n + 1}: external checkouts must use ref \${{ env.<NAME>_SHA }} with a full SHA in workflow env`);
      else c.pinVar = m[1];
    }

    // Only pinned checkout and setup-node steps may run before the gate, and they run nothing.
    steps.slice(0, gateIndex).forEach((step, n) => {
      const okUse = typeof step.uses === "string" && (PINNED_ACTION("checkout").test(step.uses) || PINNED_ACTION("setup-node").test(step.uses));
      const extra = keysOf(step).filter((k) => !["uses", "with", "name"].includes(k));
      if (!okUse || extra.length) failures.push(`${where} step ${n + 1}: only pinned checkout and setup-node steps may come before the gate${extra.length ? ` (found ${extra.join(", ")})` : ""}`);
      if (step.uses && PINNED_ACTION("setup-node").test(step.uses) && keysOf(step.with).some((k) => k !== "node-version")) failures.push(`${where} step ${n + 1}: setup-node before the gate may set only node-version`);
    });

    // The gate step itself: only name and run, canonical text, on this workflow, pinning every external checkout.
    const gate = steps[gateIndex];
    const extraKeys = keysOf(gate).filter((k) => !["name", "run"].includes(k));
    if (extraKeys.length) failures.push(`${where}: the gate step may not set ${extraKeys.join(", ")} (it could disable or redirect the gate)`);
    const lines = String(gate.run).split("\n").map((l) => l.trim()).filter(Boolean);
    const ownPath = own.length === 1 ? own[0].path : "<repository checkout>";
    const expectedWorkflow = `--workflow ${ownPath}/.github/workflows/${name} \\`;
    const preambleOk = GATE_PREAMBLE.every((expected, k) => lines[k] === expected);
    if (!preambleOk) failures.push(`${where}: the gate step must run ${GATE_SCRIPT} from the trusted checkout, exactly as specified`);
    else if (lines[GATE_PREAMBLE.length] !== expectedWorkflow) failures.push(`${where}: the gate must review this workflow (${expectedWorkflow.slice(0, -2)})`);
    else {
      const pins = lines.slice(GATE_PREAMBLE.length + 1);
      const seen = new Map();
      pins.forEach((pinLine, k) => {
        const last = k === pins.length - 1;
        const m = new RegExp(`^--pin ([A-Za-z0-9_-]+)=\\$\\{\\{ env\\.([A-Z][A-Z0-9_]*_SHA) \\}\\}${last ? "" : " \\\\"}$`).exec(pinLine);
        if (!m) failures.push(`${where}: unexpected gate argument "${pinLine.slice(0, 60)}"`);
        else seen.set(m[1], m[2]);
      });
      for (const c of external) if (c.pinVar && seen.get(c.path) !== c.pinVar) failures.push(`${where}: the gate must pin checkout '${c.path}' with \${{ env.${c.pinVar} }}`);
      if (seen.size !== external.length) failures.push(`${where}: the gate pins must match the external checkouts exactly`);
    }
  }
}

/** Text-level review (applies to every workflow reviewed). */
function reviewText(text, file, failures) {
  const name = basename(file);
  if (/\$\{\{[^}]*\bsecrets\b/.test(text) || /^\s*secrets:\s*inherit\b/m.test(text)) failures.push(`${name} references secrets`);
  for (const trigger of PRIVILEGED_TRIGGERS) if (new RegExp(`\\b${trigger}\\b`).test(text)) failures.push(`${name} uses the privileged trigger ${trigger}`);
  if (!/^permissions:\s*$/m.test(text) && !/^permissions:\s*\{?\s*contents:\s*read\s*\}?\s*$/m.test(text)) failures.push(`${name} does not declare top-level read-only permissions`);
  if (/permissions:\s*(write-all|read-all)/.test(text) || /^\s+[a-z-]+:\s*write\b/m.test(text)) failures.push(`${name} requests write permissions`);
  for (const use of text.matchAll(/uses:\s*["']?([^\s"'#]+)/g)) if (!/^[\w.-]+\/[\w./-]+@[0-9a-f]{40}$/.test(use[1])) failures.push(`${name}: ${use[1]} is not pinned to a full commit SHA`);
  for (const line of text.split("\n")) {
    const assignment = /^\s+([A-Z][A-Z0-9_]*):\s*(.*)$/.exec(line);
    if (!assignment) continue;
    const [, variable, rawValue] = assignment;
    const value = rawValue.trim().replace(/^["']|["']$/g, "");
    if (HOSTED.test(value)) failures.push(`${name}: ${variable} names a hosted endpoint`);
    if (CREDENTIAL_NAME.test(variable) && value && value !== "${{ github.run_id }}") failures.push(`${name}: ${variable} looks like a credential; only the per-run value \${{ github.run_id }} is allowed`);
    const resolved = value.replace(/\$\{\{[^}]*\}\}/g, "x");
    for (const match of resolved.matchAll(URL_PATTERN)) {
      let host;
      try { host = new URL(match[0]).hostname.toLowerCase(); } catch { failures.push(`${name}: ${variable} holds an unparseable URL`); continue; }
      if (!LOOPBACK.has(host)) failures.push(`${name}: ${variable} points at non-loopback host ${host}`);
    }
  }
}

/**
 * Workflows a pull request can trigger get the full text and structure review. Every other workflow
 * must still parse (so its triggers are known, never guessed) and may not use a privileged trigger;
 * adding `pull_request` to it brings it under the full review.
 */
function reviewWorkflowSource(source, file, failures) {
  const name = basename(file);
  const text = stripComments(source);
  let doc;
  try { doc = parseWorkflowYaml(source); } catch (err) { failures.push(`${name} is not in the supported workflow syntax: ${err.message}`); return null; }
  const triggers = triggersOf(doc.on);
  if (!triggers) { failures.push(`${name}: unsupported 'on' trigger syntax`); return doc; }
  if (triggers.includes("pull_request")) {
    reviewText(text, file, failures);
    reviewStructure(doc, file, failures);
  } else {
    for (const trigger of PRIVILEGED_TRIGGERS) if (new RegExp(`\\b${trigger}\\b`).test(text)) failures.push(`${name} uses the privileged trigger ${trigger}`);
  }
  return doc;
}

// ---- path-safe reading: never follows a symlink, never leaves the working directory ----------------
const sameCase = (p) => (process.platform === "win32" ? p.toLowerCase() : p);

/** Every component of `path` (relative to the working directory) must be a real directory or file. */
function assertSafePath(path, expect) {
  if (isAbsolute(path) || path.split(/[\\/]/).some((part) => part === ".." || part === "")) throw new Error(`${path}: absolute, empty or '..' path components are not allowed`);
  const root = resolve(".");
  const target = resolve(root, path);
  const rel = relative(root, target);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) throw new Error(`${path}: escapes the working directory`);
  let current = root;
  const parts = rel.split(sep);
  parts.forEach((part, k) => {
    current = resolve(current, part);
    const stat = lstatSync(current);
    if (stat.isSymbolicLink()) throw new Error(`${path}: '${part}' is a symlink`);
    const last = k === parts.length - 1;
    if (!last && !stat.isDirectory()) throw new Error(`${path}: '${part}' is not a directory`);
    if (last && expect === "file" && !stat.isFile()) throw new Error(`${path}: not a regular file`);
    if (last && expect === "dir" && !stat.isDirectory()) throw new Error(`${path}: not a directory`);
  });
  if (sameCase(realpathSync(target)) !== sameCase(target)) throw new Error(`${path}: resolves elsewhere`);
  return target;
}

function readRegularFile(path) {
  const target = assertSafePath(path, "file");
  const before = lstatSync(target);
  const fd = openSync(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.ino !== before.ino || stat.size !== before.size) throw new Error(`${path}: changed while being read`);
    if (stat.size > MAX_WORKFLOW_BYTES) throw new Error(`${path}: larger than ${MAX_WORKFLOW_BYTES} bytes`);
    const buffer = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < stat.size) { const n = readSync(fd, buffer, offset, stat.size - offset, offset); if (n <= 0) break; offset += n; }
    return buffer.subarray(0, offset).toString("utf8");
  } finally { closeSync(fd); }
}

function reviewWorkflowsDir(dir, options, failures) {
  let entries;
  try { assertSafePath(dir, "dir"); entries = readdirSync(dir, { withFileTypes: true }); } catch (err) { failures.push(`workflows directory: ${err.message}`); return; }
  const names = new Set();
  for (const entry of entries) {
    const label = `${dir}/${entry.name}`;
    if (entry.isSymbolicLink()) { failures.push(`${label} is a symlink`); continue; }
    if (!entry.isFile()) { failures.push(`${label} is not a regular file`); continue; }
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*\.ya?ml$/.test(entry.name)) { failures.push(`${label} is not an expected workflow file name`); continue; }
    names.add(entry.name);
    if (options.exclude.includes(entry.name)) continue;
    let source;
    try { source = readRegularFile(label); } catch (err) { failures.push(err.message); continue; }
    reviewWorkflowSource(source, label, failures);
  }
  for (const required of options.require) if (!names.has(required)) failures.push(`${dir}/${required} is required and missing`);
  if (options.self) {
    // A change to the trusted review itself needs a maintainer, not the review it would replace.
    const name = basename(options.self);
    try {
      if (!names.has(name)) throw new Error("removed");
      if (readRegularFile(options.self) !== readRegularFile(`${dir}/${name}`)) throw new Error("changed");
    } catch (err) { failures.push(`this pull request ${err.message === "removed" ? "removes" : "changes"} the trusted safety review (${name}); a maintainer must review it`); }
  }
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
  const options = { exclude: [], require: [], self: "" };
  let staticMode = false;
  let workflowsDir = "";
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--pin") pins.push(argv[++i]);
    else if (arg === "--workflow") workflows.push(argv[++i]);
    else if (arg === "--static") staticMode = true;
    else if (arg === "--workflows-dir") workflowsDir = argv[++i];
    else if (arg === "--exclude") options.exclude.push(argv[++i]);
    else if (arg === "--require") options.require.push(argv[++i]);
    else if (arg === "--self") options.self = argv[++i];
    else failures.push(`unknown argument ${arg}`);
  }
  if (workflowsDir && !staticMode) failures.push("--workflows-dir is only for --static review");
  if (!workflows.length && !workflowsDir) failures.push("no --workflow or --workflows-dir given");
  for (const workflow of workflows) {
    let source;
    try { source = readRegularFile(workflow); } catch (err) { failures.push(err.message); continue; }
    reviewWorkflowSource(source, workflow, failures);
  }
  if (workflowsDir) reviewWorkflowsDir(workflowsDir, options, failures);
  if (!staticMode) {
    checkRuntimeEnvironment(env, failures);
    checkPins(pins, failures);
  }
  const summary = staticMode ? "pull-request workflows reviewed statically" : `${pins.length} pinned checkouts, allowlisted runner endpoints only, no credentials, no secrets`;
  return { failures, summary };
}

if (process.argv[1] && /assert-ci-safety\.mjs$/.test(process.argv[1])) {
  const { failures, summary } = runGate(process.argv.slice(2), process.env);
  if (failures.length) {
    for (const failure of failures) console.error(`::error title=CI safety gate::${failure}`);
    process.exit(1);
  }
  console.log(`CI safety gate passed: ${summary}.`);
}
