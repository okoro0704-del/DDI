/**
 * D3C-C local acceptance: Portal -> Master Distributor service identity, shared replay
 * protection, and cross-instance provisioning idempotency.
 *
 * REAL (one orchestrating process, real HTTP servers on 127.0.0.1, disposable PostgreSQL 16):
 *   - Master Distributor x2 (instances A and B share one database: shared replay store).
 *   - LifeOS Portal x2 (instances A and B share one database: shared replay store and
 *     provisioning claims), INSTALL_MODE=remote, the real owner-facing POST /installs/personal.
 *   - DDI API (commercial redemption, real Portal provisioning adapter, shared replay store).
 * DOUBLES (explicit):
 *   - mybrandOS white-label provisioning endpoint (external SaaS called by the personal install).
 *   - Digi session resolution for DDI owners.
 *
 * Run from the Portal worktree (tsx):
 *   DDI_TEST_DATABASE_URL=... PORTAL_E2E_DATABASE_URL=.../portal_d3cc MD_E2E_DATABASE_URL=.../md_d3cc \
 *   node --import tsx --test <DDI>/tests/e2e/d3cc-service-identity.e2e.ts
 */
import test, { after, before, describe } from "node:test";
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign as edSign } from "node:crypto";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { Pool } from "pg";
import type { DigiOwnerId } from "../../packages/contracts/src/index.ts";
import { buildApi } from "../../apps/api/src/app.ts";
import { CommercialService } from "../../packages/service/src/commercial.ts";
import { parseCatalog } from "../../packages/service/src/commercial-catalog.ts";
import { PostgresCommercialRepository } from "../../packages/service/src/commercial-repository.ts";
import { readConfig } from "../../packages/service/src/config.ts";
import type { DigiSessionClient } from "../../packages/service/src/digi.ts";
import { HttpPortalOwnershipVerifier } from "../../packages/service/src/ownership.ts";
import { migrate } from "../../packages/service/src/postgres.ts";
import { PostgresDdiRepository } from "../../packages/service/src/postgres-repository.ts";
import { HttpPortalProvisioner } from "../../packages/service/src/portal-provisioner.ts";
import { DurableDdiService, defaultAdapters } from "../../packages/service/src/runtime.ts";
import { PostgresReplayStore, signServiceToken, type ServiceSigner, type TrustedService } from "../../packages/service/src/service-token.ts";

const PORTAL_ROOT = process.env.PORTAL_ROOT ?? "C:/Users/Hp/Desktop/portal-trustid-adapter";
const MD_ROOT = process.env.MD_ROOT ?? "C:/Users/Hp/Desktop/Master Distribution/master-distributor-engine";
const ddiDb = process.env.DDI_TEST_DATABASE_URL ?? "";
const portalDb = process.env.PORTAL_E2E_DATABASE_URL ?? "";
const mdDb = process.env.MD_E2E_DATABASE_URL ?? "";
const SCHEMA = "ddi_d3cc_e2e";
const importFrom = (root: string, rel: string) => import(pathToFileURL(join(root, rel)).href);
const local = (url: string) => ["127.0.0.1", "localhost", "::1"].includes(new URL(url).hostname);
const listen = (server: Server) => new Promise<string>(resolve => server.listen(0, "127.0.0.1", () => { const a = server.address(); resolve(`http://127.0.0.1:${typeof a === "object" && a ? a.port : 0}`); }));

const identity = (serviceId: string, keyId = `test-${serviceId}`) => {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return {
    serviceId, keyId, privateKey, publicKey,
    signer: { serviceId, keyId, privateKey } as ServiceSigner,
    publicPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
    privatePem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    trusted: (permissions: string[]): TrustedService => ({ keys: { [keyId]: publicKey }, permissions }),
  };
};
const DDI = identity("ddi");
const PORTAL = identity("lifeos-portal");
const MD = identity("master-distributor");
const PUBLISHER = identity("release-publisher");
/** A raw service token with arbitrary claims, signed by a real key (for forgery tests). */
const forge = (who: ReturnType<typeof identity>, claims: Record<string, unknown>) => {
  const h = Buffer.from(JSON.stringify({ alg: "EdDSA", typ: "digiconomy-service+jwt", kid: who.keyId })).toString("base64url");
  const p = Buffer.from(JSON.stringify(claims)).toString("base64url");
  return `${h}.${p}.${edSign(null, Buffer.from(`${h}.${p}`), who.privateKey).toString("base64url")}`;
};

describe("D3C-C: Portal -> Master Distributor service identity, replay and idempotency (real local services)", { concurrency: 1 }, () => {
  const closers: Array<() => Promise<unknown>> = [];
  let mdA: any; let mdB: any; let mdBaseA = ""; let mdBaseB = "";
  let portalStoreA: any; let portalStoreB: any; let noIdentityStore: any; let portalA: any; let portalB: any; let portalNoIdentity: any;
  let portalBaseA = ""; let portalBaseB = ""; let portalBaseNoId = "";
  let portalAuth: any;
  let ddiBase = ""; let ddiPool: Pool; let commercialRepo: PostgresCommercialRepository;
  let mybrandRequests = 0;
  const sessions = new Map<string, { ownerId: DigiOwnerId; sessionId: string; subject: string }>();
  const session = (ownerId: string) => { const token = `session-${ownerId}`; sessions.set(token, { ownerId: ownerId as DigiOwnerId, sessionId: token, subject: `TD-${ownerId}` }); return token; };
  const admin = "own_d3cc_admin";

  const mdToken = (who: ReturnType<typeof identity>, method: string, path: string, audience = "master-distributor") => `Bearer ${signServiceToken(who.signer, { audience, method, path })}`;
  const mdStatus = async (base: string, authorization?: string, method = "GET", path = "/v1/distributor/domains/dom_probe/status") => (await fetch(new URL(path, base), { method, headers: authorization ? { authorization, "content-type": "application/json" } : {}, body: method === "POST" ? JSON.stringify({ tenantId: "t", subdomain: "probe", enabledPrimitives: ["identity"] }) : undefined })).status;
  const authenticated = (status: number) => status !== 401 && status !== 403 && status !== 503;
  const bootstrapEvents = (md: any) => md.bus.getEventsByName("tenant.bootstrap.completed").map((e: any) => e.payload);
  /** The real owner-facing install: a real Portal session calls POST /installs/personal. */
  const personalInstall = async (base: string, store: any, ownerId: string, subdomain: string) => {
    const user = store.getUserByTrustId(`TD-${ownerId}`) ?? store.upsertUser({ trustId: `TD-${ownerId}`, displayName: ownerId, trustTier: null, identityStatus: null });
    const { rawToken } = await portalAuth.issuePortalSession(store, user);
    const response = await fetch(new URL("/installs/personal", base), { method: "POST", headers: { authorization: `Portal ${rawToken}`, "content-type": "application/json" }, body: JSON.stringify({ displayName: `${ownerId} brand`, subdomain }) });
    const body = await response.json() as any;
    return { status: response.status, body, install: body.install };
  };
  const provisionDirect = async (base: string, body: Record<string, unknown>, key = `ddi-provision:${body.redemptionId}`) => {
    const response = await fetch(new URL("/internal/ddi/provisioning", base), { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${signServiceToken(DDI.signer, { audience: "lifeos-portal", method: "POST", path: "/internal/ddi/provisioning" })}`, "x-ddi-contract": "ddi.portal.provisioning.v1", "idempotency-key": key }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() as any };
  };
  const provisioningBody = (installId: string, ownerId: string, n: string, patch: Record<string, unknown> = {}) => ({ contractVersion: "ddi.portal.provisioning.v1", redemptionId: `redemption:${n}`, licenseId: `license:${n}`, entitlementId: `entitlement:${n}`, productId: "personal-brandos", planId: "creator", ownerSubject: `TD-${ownerId}`, externalReference: `portal-install:${installId}`, ...patch });
  const fingerprint = (b: any) => createHash("sha256").update(JSON.stringify([b.redemptionId, b.licenseId, b.entitlementId, b.productId, b.planId, b.ownerSubject, b.externalReference])).digest("hex");
  const portalSql = async <T = any>(text: string, values: unknown[] = []) => { const db = new Pool({ connectionString: portalDb, max: 1 }); try { return (await db.query(text, values)).rows as T[]; } finally { await db.end(); } };

  before(async () => {
    for (const url of [ddiDb, portalDb, mdDb]) if (!url || !local(url)) throw new Error("local disposable DDI_TEST_DATABASE_URL, PORTAL_E2E_DATABASE_URL and MD_E2E_DATABASE_URL are required");

    // ---- mybrandOS white-label double ----
    const mybrand = createServer((req, res) => {
      let body = "";
      req.on("data", c => { body += c; });
      req.on("end", () => {
        mybrandRequests++;
        const { subdomain } = JSON.parse(body || "{}");
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ slug: subdomain, publicUrl: `https://${subdomain}.getlifeos.app`, adminUrl: `https://${subdomain}.getlifeos.app/admin`, studioUrl: `https://${subdomain}.getlifeos.app/admin`, trustId: `mybrand-${subdomain}` }));
      });
    });
    const mybrandBase = await listen(mybrand);
    closers.push(() => new Promise(resolve => mybrand.close(resolve)));

    // ---- Master Distributor A and B (shared database) ----
    const mdReset = new Pool({ connectionString: mdDb, max: 1 });
    await mdReset.query("DROP TABLE IF EXISTS md_tenant_bootstraps, md_service_token_replay, md_deliveries, md_uploads, app_latest, app_releases, ssl_certificates, domain_mappings, schema_migrations CASCADE");
    await mdReset.end();
    const mdModule = await importFrom(MD_ROOT, "/src/app.ts");
    const { createApp, createEngineDeps } = (mdModule.default ?? mdModule) as { createApp: Function; createEngineDeps: Function };
    const mdConfig = () => ({
      databaseUrl: mdDb,
      dnsProvider: "mock", sslProvider: "mock",
      security: {
        trustedServicesJson: JSON.stringify({
          [PORTAL.serviceId]: { permissions: ["tenants:provision", "tenants:read"], keys: { [PORTAL.keyId]: PORTAL.publicPem } },
          [PUBLISHER.serviceId]: { permissions: ["releases:publish", "releases:read"], keys: { [PUBLISHER.keyId]: PUBLISHER.publicPem } },
        }),
        artifactSigningKeysJson: "", serviceId: MD.serviceId, serviceKeyId: MD.keyId, servicePrivateKeyPem: MD.privatePem, audience: "master-distributor",
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

    // ---- Portal A and B (shared database), remote install mode ----
    Object.assign(process.env, { NODE_ENV: "test", INSTALL_MODE: "remote", MASTER_DISTRIBUTOR_URL: mdBaseA, MYBRANDOS_URL: mybrandBase, MYBRANDOS_WHITE_LABEL_SECRET: "e2e-mybrand-double" });
    const { runSchemaMigrations } = await importFrom(PORTAL_ROOT, "/apps/portal-api/src/store/migrate.ts");
    const { openStore } = await importFrom(PORTAL_ROOT, "/apps/portal-api/src/store/open.ts");
    const { createStore } = await importFrom(PORTAL_ROOT, "/apps/portal-api/src/store.ts");
    const { buildApp } = await importFrom(PORTAL_ROOT, "/apps/portal-api/src/app.ts");
    portalAuth = await importFrom(PORTAL_ROOT, "/apps/portal-api/src/lib/auth.ts");
    const reset = new Pool({ connectionString: portalDb, max: 1 });
    await reset.query("DROP SCHEMA IF EXISTS portal CASCADE; DROP SCHEMA IF EXISTS finprove CASCADE;");
    await reset.end();
    await runSchemaMigrations(portalDb);
    const integration = { trustedServices: { ddi: DDI.trusted(["ownership:verify", "provisioning:bind"]) }, signer: PORTAL.signer, productMap: { "personal-brandos": ["mybrandos"] }, production: false, databaseUrl: portalDb, masterDistributorAudience: "master-distributor" };
    portalStoreA = await openStore({ databaseUrl: portalDb });
    portalStoreB = await openStore({ databaseUrl: portalDb });
    portalA = await buildApp({ store: portalStoreA, ddiIntegration: integration });
    portalB = await buildApp({ store: portalStoreB, ddiIntegration: integration });
    // A misconfigured instance: remote mode but no Portal service identity.
    noIdentityStore = createStore();
    portalNoIdentity = await buildApp({ store: noIdentityStore, ddiIntegration: { ...integration, signer: undefined, databaseUrl: undefined } });
    portalBaseA = await portalA.listen({ port: 0, host: "127.0.0.1" });
    portalBaseB = await portalB.listen({ port: 0, host: "127.0.0.1" });
    portalBaseNoId = await portalNoIdentity.listen({ port: 0, host: "127.0.0.1" });
    closers.push(async () => { await portalA.close(); await portalB.close(); await portalNoIdentity.close(); await portalStoreA.close?.(); await portalStoreB.close?.(); });

    // ---- DDI ----
    const bootstrap = new Pool({ connectionString: ddiDb, max: 1 });
    await bootstrap.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await bootstrap.query(`CREATE SCHEMA ${SCHEMA}`);
    await bootstrap.end();
    ddiPool = new Pool({ connectionString: ddiDb, max: 12, options: `-c search_path=${SCHEMA}` });
    for (const m of ["001_ddi_foundation", "002_ddi_runtime", "003_pdi_connections", "004_connected_properties", "005_commercial_activation", "006_commercial_recovery", "007_portal_install_state", "008_download_grant_version", "009_service_token_replay"]) await migrate(ddiPool, join(import.meta.dirname, "../../migrations", `${m}.sql`));
    const ddi = new PostgresDdiRepository(ddiPool);
    commercialRepo = new PostgresCommercialRepository(ddiPool);
    await commercialRepo.setOperator(admin, "COMMERCIAL_ADMIN", "e2e", new Date());
    const ownership = new HttpPortalOwnershipVerifier({ url: `${portalBaseA}/internal/ddi/ownership/verify`, signer: DDI.signer });
    const commercial = new CommercialService({ repository: commercialRepo, pdi: ddi, ownership, provisioner: new HttpPortalProvisioner({ url: `${portalBaseA}/internal/ddi/provisioning`, signer: DDI.signer }), catalog: parseCatalog({ version: "e2e", products: [{ id: "personal-brandos", displayName: "P", plans: [{ id: "creator", edition: "creator", licenseType: "TERM", termDays: 365, renewable: true, requiresProperty: true, propertyTypes: ["PERSONAL_BRAND"], downloads: ["personal-brandos.apk"] }] }] }), pepper: "d3cc-e2e-pepper-0123456789abcdefghijklmnop" });
    const sessionClient: DigiSessionClient = { async resolve(token) { return sessions.get(token) ?? null; } };
    const api = buildApi({ service: new DurableDdiService(ddi, async () => ({ ok: false, reason: "MISSING" }), defaultAdapters(async () => null), sessionClient), commercial, serviceReplay: new PostgresReplayStore(ddiPool, "ddi_service_token_replay"), config: { ...readConfig({ DDI_ENV: "test" }), serviceSigner: DDI.signer, trustedServices: { "lifeos-portal": PORTAL.trusted(["portal:install-events"]) } } });
    ddiBase = await api.listen({ port: 0, host: "127.0.0.1" });
    closers.push(async () => { await api.close(); await ddiPool.end(); });
  });
  after(async () => { for (const close of closers.reverse()) await close().catch(() => undefined); });

  let mainInstall: any;

  test("1, 12: the real owner install authenticates to Master Distributor as the Portal, with owner context only", async () => {
    const { status, install } = await personalInstall(portalBaseA, portalStoreA, "own_d3cc_owner", "d3cc-owner");
    assert.equal(status, 201);
    assert.equal(install.status, "ready");
    const events = bootstrapEvents(mdA).filter((e: any) => e.tenantId === install.distributorTenantId || String(e.tenantId).includes("d3cc-owner"));
    assert.equal(events.length, 1, "Master Distributor received exactly one authenticated bootstrap");
    assert.equal(events[0].requestedBy, "lifeos-portal", "authenticated as the Portal service");
    assert.equal(events[0].ownerSubject, "TD-own_d3cc_owner", "owner identity carried as business context");
    assert.equal(mybrandRequests > 0, true);
    mainInstall = install;
  });

  test("2: a Portal without a service identity cannot bootstrap at Master Distributor (no user-token fallback)", async () => {
    const before = bootstrapEvents(mdA).length;
    // The personal install treats the distributor as optional, so the install itself proceeds;
    // what matters is that no unauthenticated or user-token call reached Master Distributor.
    await personalInstall(portalBaseNoId, noIdentityStore, "own_d3cc_noid", "d3cc-noid");
    assert.equal(bootstrapEvents(mdA).length, before, "nothing reached Master Distributor");
    assert.equal(await mdStatus(mdBaseA), 401, "no token");
    assert.equal(await mdStatus(mdBaseA, "Bearer not-a-token"), 401, "garbage token");
    assert.equal(await mdStatus(mdBaseA, mdToken(identity("lifeos-portal"), "GET", "/v1/distributor/domains/dom_probe/status")), 401, "unpinned key");
  });

  test("3-6: forged claims, wrong issuer/audience, wrong method/path and expiry are refused", async () => {
    const now = Math.floor(Date.now() / 1000);
    const path = "/v1/distributor/domains/dom_probe/status";
    const base = { iss: "lifeos-portal", sub: "lifeos-portal", aud: "master-distributor", iat: now, exp: now + 60, htm: "GET", htu: path };
    // 3: forged permission/role claims on a genuine Portal key grant nothing the Portal lacks.
    const forgedPublish = forge(PORTAL, { ...base, jti: "forge-publish", htm: "PUT", htu: "/v1/uploads", permissions: ["releases:publish"], roles: ["admin", "service"] });
    const up = await fetch(new URL("/v1/uploads", mdBaseA), { method: "PUT", headers: { authorization: `Bearer ${forgedPublish}`, "content-type": "application/octet-stream" }, body: Buffer.from("x") });
    assert.equal(up.status, 403);
    // 4: wrong issuer (Portal key, publisher name) and wrong audience.
    assert.equal(await mdStatus(mdBaseA, `Bearer ${forge(PORTAL, { ...base, jti: "iss", iss: "release-publisher", sub: "release-publisher" })}`), 401);
    assert.equal(await mdStatus(mdBaseA, mdToken(PORTAL, "GET", path, "ddi")), 401);
    // 5: wrong method and wrong path.
    assert.equal(await mdStatus(mdBaseA, mdToken(PORTAL, "POST", path)), 401);
    assert.equal(await mdStatus(mdBaseA, mdToken(PORTAL, "GET", "/v1/distributor/domains/other/status")), 401);
    // 6: expired.
    assert.equal(await mdStatus(mdBaseA, `Bearer ${forge(PORTAL, { ...base, jti: "expired", iat: now - 400, exp: now - 100 })}`), 401);
    // Control: a genuine token passes authentication.
    assert.equal(authenticated(await mdStatus(mdBaseA, mdToken(PORTAL, "GET", path))), true);
  });

  test("7, 8: a token is single-use across Master Distributor instances, including under concurrency", async () => {
    const path = "/v1/distributor/domains/dom_probe/status";
    const once = mdToken(PORTAL, "GET", path);
    assert.equal(authenticated(await mdStatus(mdBaseA, once)), true);
    assert.equal(await mdStatus(mdBaseA, once), 401, "replay on the same instance");
    assert.equal(await mdStatus(mdBaseB, once), 401, "replay on another instance");
    for (let round = 0; round < 5; round++) {
      const token = mdToken(PORTAL, "GET", path);
      const results = await Promise.all(Array.from({ length: 8 }, (_, i) => mdStatus(i % 2 ? mdBaseB : mdBaseA, token)));
      assert.equal(results.filter(authenticated).length, 1, `round ${round}: ${results.join(",")}`);
    }
    // Restart: a fresh Master Distributor process on the same database still refuses the token.
    const mdModule = await importFrom(MD_ROOT, "/src/app.ts");
    const restarted = await (mdModule.default ?? mdModule).createEngineDeps({ databaseUrl: mdDb, dnsProvider: "mock", sslProvider: "mock", security: mdA.config.security });
    const server = createServer((mdModule.default ?? mdModule).createApp(restarted).app);
    const base = await listen(server);
    try { assert.equal(await mdStatus(base, once), 401); }
    finally { await new Promise(r => server.close(r)); await restarted.persistence.close(); }
  });

  test("10, 11: DDI binds its license to the eligible install through the real Portal; ineligible installs are refused", async () => {
    const issued = await fetch(new URL("/admin/commercial/activation-codes", ddiBase), { method: "POST", headers: { authorization: `Bearer ${session(admin)}`, "content-type": "application/json", "idempotency-key": "d3cc-issue" }, body: JSON.stringify({ productId: "personal-brandos", planId: "creator", paymentReference: "manual", expiresInHours: 24 }) });
    const code = (await issued.json() as any).code;
    const redeem = (ownerId: string, key: string, c = code) => fetch(new URL("/me/activations/redeem", ddiBase), { method: "POST", headers: { authorization: `Bearer ${session(ownerId)}`, "content-type": "application/json", "idempotency-key": key }, body: JSON.stringify({ code: c, property: { type: "PERSONAL_BRAND", externalSystem: "lifeos", externalReference: `portal-install:${mainInstall.id}`, displayName: "brand" } }) }).then(async r => ({ status: r.status, body: await r.json() as any }));
    // 10: a different owner is refused by the Portal's authoritative owner check.
    assert.equal((await redeem("own_d3cc_intruder", "intruder")).body.code, "OWNERSHIP_NOT_VERIFIED");
    // 11: the owner's redemption binds the license on the Portal install.
    const done = await redeem("own_d3cc_owner", "owner");
    assert.equal(done.status, 200, JSON.stringify(done.body));
    assert.equal(done.body.redemption.status, "COMPLETED");
    await portalStoreA.flush();
    const rows = await portalSql(`SELECT payload FROM portal.records WHERE kind = 'installs' AND id = $1`, [mainInstall.id]);
    assert.equal(rows[0].payload.ddiLicense.licenseId, done.body.redemption.licenseId);
    const claims = await portalSql(`SELECT state, install_id FROM portal.ddi_provisioning_claims WHERE install_id = $1`, [mainInstall.id]);
    assert.deepEqual(claims, [{ state: "COMMITTED", install_id: mainInstall.id }]);
    // 10: a suspended install is locked (retryable), a failed one is refused.
    const suspended = (await personalInstall(portalBaseA, portalStoreA, "own_d3cc_susp", "d3cc-susp")).install;
    portalStoreA.updateInstall(suspended.id, { suspended: true });
    assert.equal((await provisionDirect(portalBaseA, provisioningBody(suspended.id, "own_d3cc_susp", "susp"))).status, 423);
  });

  test("9, 13: concurrent equivalent provisioning across two Portal instances resolves to one durable binding", async () => {
    const { install } = await personalInstall(portalBaseA, portalStoreA, "own_d3cc_race", "d3cc-race");
    await portalStoreA.flush();
    const body = provisioningBody(install.id, "own_d3cc_race", "race");
    // Let instance B see the install row through Postgres change notification.
    for (let i = 0; i < 50 && !portalStoreB.getInstall(install.id); i++) await new Promise(r => setTimeout(r, 100));
    assert.ok(portalStoreB.getInstall(install.id), "instance B sees the install");
    const results = await Promise.all(Array.from({ length: 8 }, (_, i) => provisionDirect(i % 2 ? portalBaseB : portalBaseA, body)));
    const statuses = results.map(r => r.status);
    assert.equal(statuses.filter(s => s === 201).length, 1, statuses.join(","));
    assert.ok(statuses.every(s => s === 201 || s === 200 || s === 503), statuses.join(","));
    // Retries of in-progress answers converge on the same reference.
    let references = results.filter(r => r.status !== 503).map(r => r.body.reference);
    for (const r of results.filter(r => r.status === 503)) {
      let retry = r;
      for (let attempt = 0; attempt < 20 && retry.status === 503; attempt++) { await new Promise(res => setTimeout(res, 200)); retry = await provisionDirect(portalBaseB, body); }
      assert.equal(retry.status, 200);
      references.push(retry.body.reference);
    }
    assert.equal(new Set(references).size, 1);
    const claims = await portalSql(`SELECT state FROM portal.ddi_provisioning_claims WHERE install_id = $1`, [install.id]);
    assert.deepEqual(claims, [{ state: "COMMITTED" }]);
    // 13: same key with a conflicting body, and a different license for the same install, on either instance.
    assert.equal((await provisionDirect(portalBaseB, { ...body, planId: "other" })).body.error, "idempotency_conflict");
    assert.equal((await provisionDirect(portalBaseA, provisioningBody(install.id, "own_d3cc_race", "race-other"))).body.error, "install_already_licensed");
    assert.equal((await provisionDirect(portalBaseB, provisioningBody(install.id, "own_d3cc_race", "race-other"))).body.error, "install_already_licensed");
  });

  test("14: a crashed or unacknowledged provisioning attempt is recovered without duplicating the binding", async () => {
    const { install } = await personalInstall(portalBaseA, portalStoreA, "own_d3cc_crash", "d3cc-crash");
    await portalStoreA.flush();
    const body = provisioningBody(install.id, "own_d3cc_crash", "crash");
    const key = `ddi-provision:${body.redemptionId}`;
    // A live claim held by another (still running) request: answer in-progress, never a second binding.
    await portalSql(`INSERT INTO portal.ddi_provisioning_claims (idempotency_key, fingerprint, install_id, license_id, state, lease_token, claimed_at) VALUES ($1,$2,$3,$4,'CLAIMED','live-lease', now())`, [key, fingerprint(body), install.id, body.licenseId]);
    assert.equal((await provisionDirect(portalBaseA, body)).status, 503);
    // The claimant crashed before committing: after the lease, a retry takes over and completes once.
    await portalSql(`UPDATE portal.ddi_provisioning_claims SET claimed_at = now() - interval '5 minutes' WHERE idempotency_key = $1`, [key]);
    const recovered = await provisionDirect(portalBaseB, body);
    assert.equal(recovered.status, 201, JSON.stringify(recovered.body));
    const replay = await provisionDirect(portalBaseA, body);
    assert.equal(replay.status, 200);
    assert.equal(replay.body.reference, recovered.body.reference);
    assert.deepEqual(await portalSql(`SELECT state FROM portal.ddi_provisioning_claims WHERE idempotency_key = $1`, [key]), [{ state: "COMMITTED" }]);
    // A committed request replays its original outcome even after the install changes.
    portalStoreA.updateInstall(install.id, { suspended: true });
    assert.equal((await provisionDirect(portalBaseA, body)).status, 200);
  });

  test("7: a Portal service token is single-use across Portal instances", async () => {
    const token = signServiceToken(DDI.signer, { audience: "lifeos-portal", method: "POST", path: "/internal/ddi/ownership/verify" });
    const verify = (base: string) => fetch(new URL("/internal/ddi/ownership/verify", base), { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ ownerSubject: "TD-own_d3cc_owner", externalSystem: "lifeos", externalReference: `portal-install:${mainInstall.id}`, type: "PERSONAL_BRAND" }) }).then(r => r.status);
    const statuses = await Promise.all([verify(portalBaseA), verify(portalBaseB), verify(portalBaseA), verify(portalBaseB)]);
    assert.equal(statuses.filter(s => s === 200).length, 1, statuses.join(","));
    assert.ok(statuses.filter(s => s !== 200).every(s => s === 401));
  });

  test("15: production configuration fails closed", async () => {
    const { readDdiIntegrationConfig } = await importFrom(PORTAL_ROOT, "/apps/portal-api/src/lib/service-token.ts");
    const prodKey = identity("lifeos-portal", "ci-ephemeral-portal");
    const prod = { NODE_ENV: "production", PORTAL_SERVICE_ID: "lifeos-portal", PORTAL_SERVICE_KEY_ID: prodKey.keyId, PORTAL_SERVICE_PRIVATE_KEY: prodKey.privatePem, DATABASE_URL: "postgresql://x@db.internal/portal", INSTALL_MODE: "remote", MASTER_DISTRIBUTOR_URL: "https://md.example" };
    assert.doesNotThrow(() => readDdiIntegrationConfig(prod));
    assert.throws(() => readDdiIntegrationConfig({ ...prod, PORTAL_SERVICE_PRIVATE_KEY: undefined }), /PORTAL_DDI_CONFIGURATION_INVALID/, "remote without Portal identity");
    assert.throws(() => readDdiIntegrationConfig({ ...prod, MASTER_DISTRIBUTOR_URL: "http://md.example" }), /PORTAL_DDI_CONFIGURATION_INVALID/, "plaintext MD");
    assert.throws(() => readDdiIntegrationConfig({ ...prod, PORTAL_SERVICE_KEY_ID: "test-portal" }), /SERVICE_SIGNING_KEY_INVALID/, "test signing key");
    assert.throws(() => readDdiIntegrationConfig({ ...prod, DATABASE_URL: "", PORTAL_TRUSTED_SERVICES: JSON.stringify({ ddi: { permissions: ["ownership:verify"], keys: { "ci-ephemeral-ddi": DDI.publicPem } } }) }), /PORTAL_DDI_CONFIGURATION_INVALID/, "no shared replay store");
    assert.throws(() => readDdiIntegrationConfig({ ...prod, PORTAL_TRUSTED_SERVICES: JSON.stringify({ ddi: { permissions: ["ownership:verify"], keys: { "test-ddi": DDI.publicPem } } }) }), /PORTAL_DDI_CONFIGURATION_INVALID/, "test trust anchor");
    const mdRuntime = await importFrom(MD_ROOT, "/src/security/runtime.ts");
    const mdLoad = await importFrom(MD_ROOT, "/src/config/index.ts");
    const mdProd = (mdLoad.default ?? mdLoad).loadConfig({ nodeEnv: "production", databaseUrl: "postgresql://x@db/md", storage: { provider: "volume", bucket: "b", publicBaseUrl: "https://cdn", volumePath: "./unused", s3: { endpoint: "", region: "", accessKeyId: "", secretAccessKey: "" } }, security: { ...mdA.config.security, ddiBaseUrl: "https://ddi.example" } });
    assert.throws(() => (mdRuntime.default ?? mdRuntime).createSecurityRuntime(mdProd), /MD_SECURITY_CONFIGURATION_INVALID/, "MD without shared replay store (and with test keys)");
    assert.throws(() => buildApi({ service: {} as any, config: { ...readConfig({ DDI_ENV: "test" }), environment: "production", trustedServices: { "lifeos-portal": PORTAL.trusted(["portal:install-events"]) } } }), /DDI_PRODUCTION_CONFIGURATION_INVALID/, "DDI without shared replay store");
    // The D3A shared secret is refused in production even where it is configured.
    const { buildApp } = await importFrom(PORTAL_ROOT, "/apps/portal-api/src/app.ts");
    const { createStore } = await importFrom(PORTAL_ROOT, "/apps/portal-api/src/store.ts");
    const legacy = await buildApp({ store: createStore(), ddiOwnershipSharedSecret: "legacy-d3a-secret", ddiIntegration: { trustedServices: {}, productMap: {}, production: false } });
    const previous = process.env.NODE_ENV;
    try {
      process.env.NODE_ENV = "production";
      const res = await legacy.inject({ method: "POST", url: "/internal/ddi/ownership/verify", headers: { "x-ddi-ownership-secret": "legacy-d3a-secret" }, payload: { ownerSubject: "TD-x", externalSystem: "lifeos", externalReference: "portal-install:x", type: "PERSONAL_BRAND" } });
      assert.equal(res.statusCode, 403);
    } finally { process.env.NODE_ENV = previous; await legacy.close(); }
  });
});
