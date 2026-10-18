/**
 * D3D-A local acceptance: crash recovery between Master Distributor success and Portal durable
 * completion, across real Portal processes and two Master Distributor instances.
 *
 * REAL: Master Distributor x2 (in-process HTTP servers sharing one disposable PostgreSQL database);
 * LifeOS Portal as separate OS processes (tests/e2e/fixtures/portal-instance.ts) sharing one disposable
 * PostgreSQL database, remote install mode, the owner-facing POST /installs/personal. A Portal process
 * is killed at a deterministic barrier (after MD succeeded, before the Portal recorded it) and others
 * are started in its place.
 * DOUBLE (explicit): the mybrandOS white-label provisioning endpoint (external SaaS).
 *
 * Run from the Portal checkout (tsx):
 *   PORTAL_ROOT=... MD_ROOT=... PORTAL_E2E_DATABASE_URL=.../portal_d3da MD_E2E_DATABASE_URL=.../md_d3da \
 *   node --import tsx --test <DDI>/tests/e2e/d3da-crash-recovery.e2e.ts
 */
import test, { after, before, describe } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import { Pool } from "pg";

const PORTAL_ROOT = process.env.PORTAL_ROOT ?? "C:/Users/Hp/Desktop/portal-trustid-adapter";
const MD_ROOT = process.env.MD_ROOT ?? "C:/Users/Hp/Desktop/Master Distribution/master-distributor-engine";
const portalDb = process.env.PORTAL_E2E_DATABASE_URL ?? "";
const mdDb = process.env.MD_E2E_DATABASE_URL ?? "";
const LEASE_MS = 15_000;
const FIXTURE = join(import.meta.dirname, "fixtures", "portal-instance.ts");
const importFrom = (root: string, rel: string) => import(pathToFileURL(join(root, rel)).href);
const local = (url: string) => ["127.0.0.1", "localhost", "::1"].includes(new URL(url).hostname);
const listen = (server: Server) => new Promise<string>(resolve => server.listen(0, "127.0.0.1", () => { const a = server.address(); resolve(`http://127.0.0.1:${typeof a === "object" && a ? a.port : 0}`); }));
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const PORTAL_KEY_ID = "test-lifeos-portal";
const PORTAL_PRIVATE_KEY_PEM = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const PORTAL_PUBLIC_KEY_PEM = publicKey.export({ type: "spki", format: "pem" }).toString();

type Portal = { name: string; child: ChildProcess; base: string; sessions: Map<string, string>; barrier: Promise<string>; commitBarrier: Promise<void>; exited: Promise<number | null> };

describe("D3D-A: crash between Master Distributor success and Portal completion (real processes)", { concurrency: 1 }, () => {
  const closers: Array<() => Promise<unknown>> = [];
  const portals: Portal[] = [];
  const children: ChildProcess[] = [];
  let mdA: any; let mdB: any; let mdBaseA = ""; let mdBaseB = ""; let mybrandBase = "";
  const mybrandCalls = new Map<string, number>();
  const sql = async <T = any>(url: string, text: string, values: unknown[] = []) => { const db = new Pool({ connectionString: url, max: 1 }); try { return (await db.query(text, values)).rows as T[]; } finally { await db.end(); } };
  const completedEvents = (tenantId: string) => [mdA, mdB].flatMap(md => md.bus.getEventsByName("tenant.bootstrap.completed")).filter((e: any) => e.tenantId === tenantId).length;

  /** Starts a Portal process and waits for its sessions, its READY line and a healthy GET /health. */
  const startPortal = async (name: string, opts: { md: string; barrier?: boolean | "commit"; owners: string[] }): Promise<Portal> => {
    const child = spawn(process.execPath, ["--import", "tsx", FIXTURE], {
      cwd: PORTAL_ROOT,
      env: { ...process.env, PORTAL_ROOT, PORTAL_E2E_DATABASE_URL: portalDb, PORTAL_MD_URL: opts.md, PORTAL_MYBRANDOS_URL: mybrandBase, PORTAL_KEY_ID, PORTAL_PRIVATE_KEY_PEM, PORTAL_INSTALL_LEASE_MS: String(LEASE_MS), PORTAL_BARRIER: opts.barrier === "commit" ? "commit" : opts.barrier ? "1" : "0", PORTAL_OWNERS: opts.owners.join(",") },
      stdio: ["ignore", "pipe", "pipe"],
    });
    children.push(child);
    const stderr: string[] = [];
    child.stderr!.on("data", chunk => { stderr.push(String(chunk)); });
    const exited = new Promise<number | null>(resolve => child.once("exit", code => resolve(code)));
    const sessions = new Map<string, string>();
    let resolveReady!: (base: string) => void; let resolveBarrier!: (tenantId: string) => void;
    const ready = new Promise<string>(resolve => { resolveReady = resolve; });
    const barrier = new Promise<string>(resolve => { resolveBarrier = resolve; });
    let resolveCommitBarrier!: () => void;
    const commitBarrier = new Promise<void>(resolve => { resolveCommitBarrier = resolve; });
    createInterface({ input: child.stdout! }).on("line", line => {
      const [kind, a, b] = line.split(" ");
      if (kind === "SESSION") sessions.set(a!, b!);
      if (kind === "READY") resolveReady(a!);
      if (kind === "BARRIER") resolveBarrier(a!);
      if (kind === "BARRIER_COMMIT") resolveCommitBarrier();
    });
    const base = await Promise.race([
      ready,
      exited.then(code => { throw new Error(`${name} exited (${code}) before READY: ${stderr.join("").slice(-2000)}`); }),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`${name} did not become READY`)), 120_000).unref()),
    ]);
    for (let attempt = 0; ; attempt++) {
      const healthy = await fetch(new URL("/health", base)).then(r => r.ok, () => false);
      if (healthy) break;
      if (attempt > 100) throw new Error(`${name} never became healthy`);
      await sleep(100);
    }
    const portal = { name, child, base, sessions, barrier, commitBarrier, exited };
    portals.push(portal);
    return portal;
  };
  const kill = async (portal: Portal) => { portal.child.kill("SIGKILL"); await portal.exited; };
  const install = async (portal: Portal, owner: string, subdomain: string) => {
    const response = await fetch(new URL("/installs/personal", portal.base), { method: "POST", headers: { authorization: `Portal ${portal.sessions.get(owner)}`, "content-type": "application/json" }, body: JSON.stringify({ displayName: `${owner} brand`, subdomain }) });
    return { status: response.status, body: await response.json() as any };
  };
  const claimRow = async (subdomain: string) => (await sql(portalDb, `SELECT tenant_id, state, bootstrap, install_id, claimed_at + make_interval(secs => $2::double precision / 1000) < now() AS stale FROM portal.install_claims WHERE subdomain = $1`, [subdomain, LEASE_MS]))[0];
  const mdRows = (subdomain: string) => sql(mdDb, `SELECT tenant_id, state, result FROM md_tenant_bootstraps WHERE subdomain = $1`, [subdomain]);

  before(async () => {
    for (const url of [portalDb, mdDb]) if (!url || !local(url)) throw new Error("local disposable PORTAL_E2E_DATABASE_URL and MD_E2E_DATABASE_URL are required");

    const mybrand = createServer((req, res) => {
      let body = "";
      req.on("data", c => { body += c; });
      req.on("end", () => {
        const { subdomain } = JSON.parse(body || "{}");
        mybrandCalls.set(subdomain, (mybrandCalls.get(subdomain) ?? 0) + 1);
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ slug: subdomain, publicUrl: `https://${subdomain}.getlifeos.app`, adminUrl: `https://${subdomain}.getlifeos.app/admin`, studioUrl: `https://${subdomain}.getlifeos.app/admin`, trustId: `mybrand-${subdomain}` }));
      });
    });
    mybrandBase = await listen(mybrand);
    closers.push(() => new Promise(resolve => mybrand.close(resolve)));

    const mdReset = new Pool({ connectionString: mdDb, max: 1 });
    await mdReset.query("DROP TABLE IF EXISTS md_tenant_bootstraps, md_service_token_replay, md_deliveries, md_uploads, app_latest, app_releases, ssl_certificates, domain_mappings, schema_migrations CASCADE");
    await mdReset.end();
    const mdModule = await importFrom(MD_ROOT, "/src/app.ts");
    const { createApp, createEngineDeps } = (mdModule.default ?? mdModule) as { createApp: Function; createEngineDeps: Function };
    const { generateKeyPairSync: gen } = await import("node:crypto");
    const md = gen("ed25519");
    const mdConfig = () => ({
      databaseUrl: mdDb, dnsProvider: "mock", sslProvider: "mock",
      security: {
        trustedServicesJson: JSON.stringify({ "lifeos-portal": { permissions: ["tenants:provision", "tenants:read"], keys: { [PORTAL_KEY_ID]: PORTAL_PUBLIC_KEY_PEM } } }),
        artifactSigningKeysJson: "", serviceId: "master-distributor", serviceKeyId: "test-master-distributor", servicePrivateKeyPem: md.privateKey.export({ type: "pkcs8", format: "pem" }).toString(), audience: "master-distributor",
        ddiBaseUrl: "", ddiAudience: "ddi", ddiTimeoutMs: 5_000, deliveryTtlSeconds: 60, maxUploadBytes: 1024 * 1024,
      },
    });
    mdA = await createEngineDeps(mdConfig());
    mdB = await createEngineDeps(mdConfig());
    const serverA = createServer(createApp(mdA).app);
    const serverB = createServer(createApp(mdB).app);
    mdBaseA = await listen(serverA);
    mdBaseB = await listen(serverB);
    closers.push(async () => { await new Promise(r => serverA.close(r)); await new Promise(r => serverB.close(r)); await mdA.persistence.close(); await mdB.persistence.close(); });

    const reset = new Pool({ connectionString: portalDb, max: 1 });
    await reset.query("DROP SCHEMA IF EXISTS portal CASCADE; DROP SCHEMA IF EXISTS finprove CASCADE;");
    await reset.end();
    const { runSchemaMigrations } = await importFrom(PORTAL_ROOT, "/apps/portal-api/src/store/migrate.ts");
    await runSchemaMigrations(portalDb);
  });
  after(async () => {
    for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    for (const close of closers.reverse()) await close().catch(() => undefined);
  });

  let tenantId = "";
  let p2: Portal; let p3: Portal;

  test("barrier: MD completed the bootstrap, the Portal has not recorded it, and the Portal process is killed", async () => {
    const p1 = await startPortal("portal-1", { md: mdBaseA, barrier: true, owners: ["own_d3da"] });
    const pending = install(p1, "own_d3da", "crash-brand").catch(err => ({ status: 0, body: { error: String(err) } }));
    tenantId = await p1.barrier;
    const md = await mdRows("crash-brand");
    assert.equal(md.length, 1);
    assert.equal(md[0].state, "COMPLETED", "Master Distributor completed and recorded the bootstrap");
    assert.equal(md[0].tenant_id, tenantId);
    const claim = await claimRow("crash-brand");
    assert.equal(claim.state, "CLAIMED");
    assert.equal(claim.bootstrap, null, "the Portal has no durable record of MD's success");
    await kill(p1);
    assert.equal((await pending).status, 0, "the owner never received a response");
    assert.equal(completedEvents(tenantId), 1);
  });

  test("restart: a live claim is not taken over; once stale, exactly one of two instances recovers it with the original tenant", async () => {
    // Sequential: the second instance loads the owners the first one created.
    p2 = await startPortal("portal-2", { md: mdBaseA, owners: ["own_d3da", "own_d3da_rival"] });
    p3 = await startPortal("portal-3", { md: mdBaseB, owners: ["own_d3da", "own_d3da_rival"] });
    if (!(await claimRow("crash-brand")).stale) {
      const early = await install(p2, "own_d3da", "crash-brand");
      assert.equal(early.status, 503);
      assert.equal(early.body.error, "install_in_progress");
    }
    // Deterministic wait: until the database says the crashed claim's lease has expired.
    for (let i = 0; !(await claimRow("crash-brand")).stale; i++) { assert.ok(i < 400, "lease never expired"); await sleep(100); }

    const [a, b] = await Promise.all([install(p2, "own_d3da", "crash-brand"), install(p3, "own_d3da", "crash-brand")]);
    const winner = [a, b].find(r => r.status === 201);
    assert.ok(winner, `one recovery succeeds: ${JSON.stringify([a.status, a.body.error, b.status, b.body.error])}`);
    const loser = winner === a ? b : a;
    assert.ok((loser.status === 503 && loser.body.error === "install_in_progress") || (loser.status === 409), `the other is refused: ${loser.status} ${loser.body.error}`);
    assert.equal(winner.body.install.status, "ready");
    assert.equal(winner.body.install.distributorTenantId, tenantId, "the recovered install uses the crashed attempt's MD tenant");

    // 1, 2: exactly one logical MD tenant, and no duplicate bootstrap side effects.
    const md = await mdRows("crash-brand");
    assert.equal(md.length, 1);
    assert.equal(completedEvents(tenantId), 1, "MD replayed its original result instead of bootstrapping again");
    assert.equal(mybrandCalls.get("crash-brand"), 1, "the downstream white-label provisioning ran once");
    // 3, 4: the stale claim was recovered and holds MD's original result.
    const claim = await claimRow("crash-brand");
    assert.equal(claim.state, "COMMITTED");
    assert.equal(claim.tenant_id, tenantId);
    assert.equal(claim.install_id, winner.body.install.id);
    assert.deepEqual(claim.bootstrap, md[0].result, "the Portal recorded MD's original result (same compiledAt), not a new one");
  });

  test("after recovery: the same owner gets no second installation, and other owners cannot take the subdomain on any instance", async () => {
    for (const portal of [p2, p3]) {
      const again = await install(portal, "own_d3da", "crash-brand");
      assert.equal(again.status, 409, `${portal.name}: ${again.body.error}`);
      const rival = await install(portal, "own_d3da_rival", "crash-brand");
      assert.equal(rival.status, 409, `${portal.name}: ${rival.body.error}`);
    }
    assert.equal((await mdRows("crash-brand")).length, 1);
    assert.equal(completedEvents(tenantId), 1);
    assert.equal(mybrandCalls.get("crash-brand"), 1);
  });

  test("control: two owners racing for a fresh subdomain on two instances produce one installation and one MD tenant", async () => {
    const [a, b] = await Promise.all([install(p2, "own_d3da", "race-brand"), install(p3, "own_d3da_rival", "race-brand")]);
    assert.deepEqual([a.status, b.status].filter(s => s === 201).length, 1, JSON.stringify([a.status, a.body.error, b.status, b.body.error]));
    const md = await mdRows("race-brand");
    assert.equal(md.length, 1);
    assert.equal(completedEvents(md[0].tenant_id), 1);
    assert.equal(mybrandCalls.get("race-brand"), 1);
  });

  test("D3D-B1: a crash after the ready install is durable and before the claim commit never yields a second installation", async () => {
    const p4 = await startPortal("portal-4", { md: mdBaseA, barrier: "commit", owners: ["own_d3da"] });
    const pending = install(p4, "own_d3da", "commit-brand").catch(err => ({ status: 0, body: { error: String(err) } }));
    await p4.commitBarrier;
    const persisted = await sql<{ id: string }>(portalDb, `SELECT id FROM portal.records WHERE kind = 'installs' AND payload->>'status' = 'ready' AND lower(payload->>'subdomain') = 'commit-brand'`);
    assert.equal(persisted.length, 1, "the ready install is durable");
    assert.equal((await claimRow("commit-brand")).state, "CLAIMED", "the claim is not committed");
    await kill(p4);
    assert.equal((await pending).status, 0, "the owner never received a response");

    // Instances that started before the crash; they learn of the install through the database.
    for (let i = 0; !(await claimRow("commit-brand")).stale; i++) { assert.ok(i < 400, "lease never expired"); await sleep(100); }
    const retry = await install(p2, "own_d3da", "commit-brand");
    assert.equal(retry.status, 409, `the owner's retry is answered with the existing install: ${retry.body.error}`);
    const rival = await install(p3, "own_d3da_rival", "commit-brand");
    assert.equal(rival.status, 409, `another owner is refused: ${rival.body.error}`);

    const ready = await sql<{ id: string }>(portalDb, `SELECT id FROM portal.records WHERE kind = 'installs' AND payload->>'status' = 'ready' AND lower(payload->>'subdomain') = 'commit-brand'`);
    assert.deepEqual(ready.map(r => r.id), [persisted[0]!.id], "exactly one ready install: the persisted one");
    const md = await mdRows("commit-brand");
    assert.equal(md.length, 1);
    assert.equal(completedEvents(md[0].tenant_id), 1);
    assert.equal(mybrandCalls.get("commit-brand"), 1);
    const claim = await sql<{ state: string; install_id: string | null }>(portalDb, `SELECT state, install_id FROM portal.install_claims WHERE subdomain = 'commit-brand'`);
    // Reconciled through the claim, or refused earlier because the instance's cache already saw the install.
    if (claim[0]!.state === "COMMITTED") assert.equal(claim[0]!.install_id, persisted[0]!.id);
    console.log(`commit-barrier recovery path: claim ${claim[0]!.state}${claim[0]!.install_id ? ` -> ${claim[0]!.install_id}` : ""}`);
  });
});
