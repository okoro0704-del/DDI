/**
 * D3C-B end-to-end local acceptance.
 *
 * REAL (one process, separate real HTTP servers on 127.0.0.1, separate PostgreSQL 16 databases):
 *   - DDI API: DurableDdiService, CommercialService, HttpPortalOwnershipVerifier,
 *     HttpPortalProvisioner, PostgresPortalInstallState, service-token auth.
 *   - LifeOS Portal API: buildApp + row-level Postgres store, /internal/ddi/* routes,
 *     install-event outbox and its delivery worker.
 *   - Master Distributor: createApp + Postgres persistence + volume storage on disk,
 *     upload/publish/sign/verify, fulfilment that redeems at DDI over HTTP, delivery.
 * DOUBLES (explicit):
 *   - Digi session resolution (TrustID / Digi Core are not part of this flow).
 *   - Portal installs are created through the Portal store API rather than the owner-facing
 *     install orchestrator (which needs Finprove, TrustID and live distributor bootstrap).
 *   - Scenario 5 injects a lost HTTP response at DDI's client; the real Portal still commits.
 *
 * Run (from the Portal worktree, which provides tsx):
 *   DDI_TEST_DATABASE_URL=... PORTAL_E2E_DATABASE_URL=... MD_E2E_DATABASE_URL=... \
 *   node --import tsx --test <DDI>/tests/e2e/d3cb-acceptance.e2e.ts
 */
import test, { after, before, describe } from "node:test";
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign as edSign } from "node:crypto";
import { mkdtemp, readdir, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { Pool } from "pg";
import type { Actor, DigiOwnerId } from "../../packages/contracts/src/index.ts";
import { buildApi } from "../../apps/api/src/app.ts";
import { CommercialService } from "../../packages/service/src/commercial.ts";
import { parseCatalog } from "../../packages/service/src/commercial-catalog.ts";
import { PostgresCommercialRepository } from "../../packages/service/src/commercial-repository.ts";
import { readConfig } from "../../packages/service/src/config.ts";
import type { DigiSessionClient } from "../../packages/service/src/digi.ts";
import { HttpPortalOwnershipVerifier } from "../../packages/service/src/ownership.ts";
import { migrate } from "../../packages/service/src/postgres.ts";
import { PostgresDdiRepository } from "../../packages/service/src/postgres-repository.ts";
import { PostgresPortalInstallState, reconcilePortalInstalls } from "../../packages/service/src/portal-install-state.ts";
import { HttpPortalProvisioner } from "../../packages/service/src/portal-provisioner.ts";
import { DurableDdiService, defaultAdapters } from "../../packages/service/src/runtime.ts";
import { signServiceToken, type ServiceSigner, type TrustedService } from "../../packages/service/src/service-token.ts";

const PORTAL_ROOT = process.env.PORTAL_ROOT ?? "C:/Users/Hp/Desktop/portal-trustid-adapter";
const MD_ROOT = process.env.MD_ROOT ?? "C:/Users/Hp/Desktop/Master Distribution/master-distributor-engine";
const ddiDb = process.env.DDI_TEST_DATABASE_URL ?? "";
const portalDb = process.env.PORTAL_E2E_DATABASE_URL ?? "";
const mdDb = process.env.MD_E2E_DATABASE_URL ?? "";
const SCHEMA = "ddi_d3cb_e2e";
const PEPPER = "d3cb-e2e-pepper-0123456789abcdefghijklmnopq";

const identity = (serviceId: string) => {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const keyId = `test-${serviceId}`;
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
const SIGNING = identity("artifact-publisher");
/** Cross-repo dynamic import; Windows absolute paths must be file:// URLs. */
const importFrom = (root: string, rel: string) => import(pathToFileURL(join(root, rel)).href);
const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const local = (url: string) => ["127.0.0.1", "localhost", "::1"].includes(new URL(url).hostname);
const listen = (server: Server) => new Promise<string>(resolve => server.listen(0, "127.0.0.1", () => { const a = server.address(); resolve(`http://127.0.0.1:${typeof a === "object" && a ? a.port : 0}`); }));
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

describe("D3C-B acceptance: DDI x Portal x Master Distributor (real local services)", { concurrency: 1 }, () => {
  let pool: Pool;
  let ddi: PostgresDdiRepository;
  let commercialRepo: PostgresCommercialRepository;
  let commercial: CommercialService;
  let installState: PostgresPortalInstallState;
  let service: DurableDdiService;
  let ownership: HttpPortalOwnershipVerifier;
  let portalStore: any;
  let portalApp: any;
  let md: any;
  let mdServer: Server;
  let ddiBase = "";
  let portalBase = "";
  let mdBase = "";
  let artifactDir = "";
  let skewMs = 0;
  let loseNextProvisioningResponse = false;
  const closers: Array<() => Promise<unknown>> = [];
  const sessions = new Map<string, { ownerId: DigiOwnerId; sessionId: string; subject: string }>();
  const session = (ownerId: string) => { const token = `session-${ownerId}`; sessions.set(token, { ownerId: ownerId as DigiOwnerId, sessionId: token, subject: `TD-${ownerId}` }); return token; };
  const admin = "own_e2e_admin";
  const clock = () => new Date(Date.now() + skewMs);

  const ddiCall = async (method: string, path: string, token?: string, body?: unknown, headers: Record<string, string> = {}) => {
    const response = await fetch(new URL(path, ddiBase), { method, headers: { ...(token ? { authorization: token.includes(" ") ? token : `Bearer ${token}` } : {}), ...(body !== undefined ? { "content-type": "application/json" } : {}), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, body: await response.json().catch(() => ({})) as any };
  };
  const mdCall = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const response = await fetch(new URL(path, mdBase), { method, headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, body: await response.json().catch(() => ({})) as any };
  };
  const fulfil = (grantToken: string, artifactId: string, version: string, propertyId?: string) => mdCall("POST", "/v1/fulfillment/ddi-grants", { grantToken, artifactId, version, propertyId });
  const issue = async () => {
    const issued = await ddiCall("POST", "/admin/commercial/activation-codes", session(admin), { productId: "personal-brandos", planId: "creator", paymentReference: "manual-e2e", expiresInHours: 24 }, { "idempotency-key": `e2e-${Math.random()}` });
    assert.equal(issued.status, 201, JSON.stringify(issued.body));
    return issued.body.code as string;
  };
  const portalOwner = (ownerId: string) => portalStore.getUserByTrustId(`TD-${ownerId}`) ?? portalStore.upsertUser({ trustId: `TD-${ownerId}`, displayName: ownerId, trustTier: null, identityStatus: null });
  const portalInstall = (ownerId: string, status = "provisioning", appId = "mybrandos") => {
    const user = portalOwner(ownerId);
    return portalStore.createInstall({ ownerUserId: user.id, ownerTrustId: `TD-${ownerId}`, appId, osId: appId, verticalId: "creator", displayName: `${ownerId} brand`, subdomain: `e2e-${Math.random().toString(36).slice(2, 10)}`, distributorTenantId: `tid-${ownerId}`, modulesEnabled: [], seedApplied: true, status });
  };
  const redeem = async (ownerId: string, installId: string, key: string, code?: string) => ddiCall("POST", "/me/activations/redeem", session(ownerId), { code: code ?? await issue(), property: { type: "PERSONAL_BRAND", externalSystem: "lifeos", externalReference: `portal-install:${installId}`, displayName: installId } }, { "idempotency-key": key });
  const runOutbox = async (id: string) => { skewMs += 120_000; return commercial.runOutbox({ aggregateId: id }); };
  const deliverEvents = async () => {
    const { deliverDdiInstallEvents } = await importFrom(PORTAL_ROOT, "/apps/portal-api/src/services/ddi-install-events.ts");
    return deliverDdiInstallEvents({ store: portalStore, url: `${ddiBase}/internal/portal/install-events`, signer: PORTAL.signer, now: () => new Date(Date.now() + 3_600_000) });
  };
  const count = async (sql: string, values: unknown[] = []) => Number((await pool.query<{ n: string }>(`SELECT count(*)::text AS n FROM ${sql}`, values)).rows[0]!.n);
  const publish = async (appId: string, version: string, access: "licensed" | "public", platforms: string[]) => {
    const artifacts = [];
    for (const platform of platforms) {
      const bytes = Buffer.from(`${appId}-${version}-${platform}-bytes-${"z".repeat(256)}`);
      const filename = `${appId}-${version}.${platform}`;
      const up = await fetch(new URL("/v1/uploads", mdBase), { method: "PUT", headers: { "content-type": "application/octet-stream", authorization: `Bearer ${signServiceToken(PUBLISHER.signer, { audience: "master-distributor", method: "PUT", path: "/v1/uploads" })}` }, body: bytes });
      const uploaded = await up.json() as { uploadId: string; sha256: string };
      assert.equal(uploaded.sha256, sha256(bytes));
      const statement = Buffer.from(["md.artifact-signature.v1", appId, version, platform, filename, sha256(bytes), String(bytes.length)].join("\n"));
      artifacts.push({ platform, filename, uploadId: uploaded.uploadId, checksumSha256: uploaded.sha256, signature: { keyId: SIGNING.keyId, value: edSign(null, statement, SIGNING.privateKey).toString("base64url") } });
    }
    const response = await fetch(new URL("/v1/releases", mdBase), { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${signServiceToken(PUBLISHER.signer, { audience: "master-distributor", method: "POST", path: "/v1/releases" })}` }, body: JSON.stringify({ appId, version, access, artifacts }) });
    assert.equal(response.status, 201, await response.clone().text());
    return response.json() as Promise<{ release: { artifacts: Array<{ objectKey: string; platform: string }> } }>;
  };
  /** Read straight from the Portal's Postgres records, not the in-process cache. */
  const portalBindings = async () => {
    await portalStore.flush();
    const db = new Pool({ connectionString: portalDb, max: 1 });
    try { return (await db.query<{ payload: { installId: string; redemptionId: string } }>(`SELECT payload FROM portal.records WHERE kind = 'ddiProvisioning'`)).rows.map(row => row.payload); }
    finally { await db.end(); }
  };
  const download = async (url: string) => { const r = await fetch(url); return { status: r.status, headers: r.headers, bytes: Buffer.from(await r.arrayBuffer()) }; };

  before(async () => {
    for (const url of [ddiDb, portalDb, mdDb]) if (!url || !local(url)) throw new Error("local disposable DDI_TEST_DATABASE_URL, PORTAL_E2E_DATABASE_URL and MD_E2E_DATABASE_URL are required");
    process.env.NODE_ENV = "test";

    // ---- LifeOS Portal (real, Postgres store) ----
    const { runSchemaMigrations } = await importFrom(PORTAL_ROOT, "/apps/portal-api/src/store/migrate.ts");
    const { openStore } = await importFrom(PORTAL_ROOT, "/apps/portal-api/src/store/open.ts");
    const { buildApp } = await importFrom(PORTAL_ROOT, "/apps/portal-api/src/app.ts");
    const reset = new Pool({ connectionString: portalDb, max: 1 });
    await reset.query("DROP SCHEMA IF EXISTS portal CASCADE; DROP SCHEMA IF EXISTS finprove CASCADE;");
    await reset.end();
    await runSchemaMigrations(portalDb);
    portalStore = await openStore({ databaseUrl: portalDb });
    portalApp = await buildApp({ store: portalStore, ddiIntegration: { trustedServices: { ddi: DDI.trusted(["ownership:verify", "provisioning:bind"]) }, signer: PORTAL.signer, productMap: { "personal-brandos": ["mybrandos"] }, production: false } });
    portalBase = await portalApp.listen({ port: 0, host: "127.0.0.1" });
    closers.push(() => portalApp.close());

    // ---- DDI (real, Postgres) ----
    const bootstrap = new Pool({ connectionString: ddiDb, max: 1 });
    await bootstrap.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await bootstrap.query(`CREATE SCHEMA ${SCHEMA}`);
    await bootstrap.end();
    pool = new Pool({ connectionString: ddiDb, max: 16, options: `-c search_path=${SCHEMA}` });
    for (const m of ["001_ddi_foundation", "002_ddi_runtime", "003_pdi_connections", "004_connected_properties", "005_commercial_activation", "006_commercial_recovery", "007_portal_install_state", "008_download_grant_version", "009_service_token_replay"]) await migrate(pool, join(import.meta.dirname, "../../migrations", `${m}.sql`));
    ddi = new PostgresDdiRepository(pool);
    commercialRepo = new PostgresCommercialRepository(pool);
    installState = new PostgresPortalInstallState(pool);
    await commercialRepo.setOperator(admin, "COMMERCIAL_ADMIN", "e2e", new Date());
    ownership = new HttpPortalOwnershipVerifier({ url: `${portalBase}/internal/ddi/ownership/verify`, signer: DDI.signer });
    // Real Portal; scenario 5 drops the HTTP response after the Portal has committed.
    const provisioningFetch = (async (url: string | URL, init?: RequestInit) => {
      if (!loseNextProvisioningResponse) return fetch(url, init);
      loseNextProvisioningResponse = false;
      const { signal, ...rest } = init ?? {};
      await fetch(url, rest);
      throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
    }) as typeof fetch;
    const provisioner = new HttpPortalProvisioner({ url: `${portalBase}/internal/ddi/provisioning`, signer: DDI.signer, fetch: provisioningFetch, timeoutMs: 5_000 });
    const catalog = parseCatalog({ version: "e2e", products: [{ id: "personal-brandos", displayName: "Personal BrandOS", plans: [{ id: "creator", edition: "creator", licenseType: "TERM", termDays: 365, renewable: true, requiresProperty: true, propertyTypes: ["PERSONAL_BRAND"], downloads: ["personal-brandos.apk", "personal-brandos.web"] }] }] });
    commercial = new CommercialService({ repository: commercialRepo, pdi: ddi, ownership, provisioner, catalog, pepper: PEPPER, clock, downloadTtlSeconds: 60, outbox: { baseDelayMs: 1_000, maxDelayMs: 30_000, leaseMs: 20_000, maxAttempts: 10 } });
    const sessionClient: DigiSessionClient = { async resolve(token) { return sessions.get(token) ?? null; } };
    service = new DurableDdiService(ddi, async () => ({ ok: false, reason: "MISSING" }), defaultAdapters(async () => null), sessionClient);
    const ddiApi = buildApi({ service, commercial, installState, config: { ...readConfig({ DDI_ENV: "test" }), serviceSigner: DDI.signer, trustedServices: { "lifeos-portal": PORTAL.trusted(["portal:install-events"]), "master-distributor": MD.trusted(["downloads:redeem"]) } } });
    ddiBase = await ddiApi.listen({ port: 0, host: "127.0.0.1" });
    closers.push(() => ddiApi.close());

    // ---- Master Distributor (real, Postgres + volume storage) ----
    const mdReset = new Pool({ connectionString: mdDb, max: 1 });
    await mdReset.query("DROP TABLE IF EXISTS md_tenant_bootstraps, md_service_token_replay, md_deliveries, md_uploads, app_latest, app_releases, ssl_certificates, domain_mappings, schema_migrations CASCADE");
    await mdReset.end();
    artifactDir = await mkdtemp(join(tmpdir(), "md-d3cb-"));
    const mdModule = await importFrom(MD_ROOT, "/src/app.ts");
    const { createApp, createEngineDeps } = (mdModule.default ?? mdModule) as { createApp: Function; createEngineDeps: Function };
    md = await createEngineDeps({
      databaseUrl: mdDb,
      enableGuestDownloads: true,
      storage: { provider: "volume", bucket: "e2e", publicBaseUrl: "unused", volumePath: artifactDir, s3: { endpoint: "", region: "", accessKeyId: "", secretAccessKey: "" } },
      security: {
        trustedServicesJson: JSON.stringify({ [PUBLISHER.serviceId]: { permissions: ["releases:publish", "releases:read"], keys: { [PUBLISHER.keyId]: PUBLISHER.publicPem } } }),
        artifactSigningKeysJson: JSON.stringify({ [SIGNING.keyId]: SIGNING.publicPem }),
        serviceId: MD.serviceId, serviceKeyId: MD.keyId, servicePrivateKeyPem: MD.privatePem, audience: "master-distributor",
        ddiBaseUrl: ddiBase, ddiAudience: "ddi", ddiTimeoutMs: 5_000, deliveryTtlSeconds: 15, maxUploadBytes: 1024 * 1024,
      },
    });
    mdServer = createServer(createApp(md).app);
    mdBase = await listen(mdServer);
    md.config.publicBaseUrl = mdBase;
    closers.push(async () => { await new Promise(resolve => mdServer.close(resolve)); await md.persistence.close(); });
    closers.push(async () => { await pool.end(); });

    await publish("personal-brandos", "1.4.0", "licensed", ["apk", "web"]);
    await publish("personal-brandos", "1.5.0", "licensed", ["apk"]);
    await publish("lifeos", "1.0.0", "public", ["web"]);
  });
  after(async () => { for (const close of closers.reverse()) await close().catch(() => undefined); await portalStore?.close?.().catch(() => undefined); });

  let main: { ownerId: string; installId: string; redemption: any };

  test("1-3, 7, 25: redemption reuses the PDI, provisions through the real Portal, and activates on READY", async () => {
    const ownerId = "own_e2e_main";
    const existing = await ddi.provision(ownerId as DigiOwnerId, { type: "PERSONAL", idempotencyKey: "e2e-main-pdi" });
    const install = portalInstall(ownerId, "provisioning");
    const portalInstallsBefore = portalStore.listAllInstalls().length;
    const redeemed = await redeem(ownerId, install.id, "main");
    assert.equal(redeemed.status, 202, JSON.stringify(redeemed.body));
    const redemption = redeemed.body.redemption;
    assert.equal(redemption.infrastructureId, existing.id, "existing PDI reused");
    // Real Portal provisioning happened: the binding exists on the Portal install and DDI holds the Portal's reference.
    assert.equal(redemption.provisioningReference, `portal-ddi:${install.id}:${redemption.licenseId}`);
    assert.equal(portalStore.getInstall(install.id).ddiLicense.licenseId, redemption.licenseId);
    assert.equal((await ddi.getProperty(redemption.propertyId))?.status, "PENDING_ACTIVATION");
    assert.equal(redemption.lastError, "OWNERSHIP_VERIFICATION_PENDING", "not READY yet: no activation");
    portalStore.updateInstall(install.id, { status: "ready" });
    assert.equal((await runOutbox(redemption.id)).completed, 1);
    assert.equal((await ddi.getProperty(redemption.propertyId))?.status, "ACTIVE");
    assert.equal((await commercialRepo.getRedemption(redemption.id))?.redemption.status, "COMPLETED");
    assert.equal(await count(`ddi_infrastructures WHERE owner_id = $1`, [ownerId]), 1);
    assert.equal(portalStore.listAllInstalls().length, portalInstallsBefore, "no Portal install created");
    main = { ownerId, installId: install.id, redemption };
  });

  test("4 + 5: duplicate provisioning and a lost Portal response converge on one Portal binding", async () => {
    const ownerId = "own_e2e_timeout";
    const install = portalInstall(ownerId, "ready");
    loseNextProvisioningResponse = true;
    const redeemed = await redeem(ownerId, install.id, "timeout");
    const redemption = redeemed.body.redemption;
    // The Portal committed, but DDI never saw the answer: no false success, just a retry.
    assert.equal(redemption.provisionedAt, undefined);
    assert.equal(redemption.lastError, "PROVISIONING_UNAVAILABLE");
    assert.equal(portalStore.getInstall(install.id).ddiLicense.licenseId, redemption.licenseId);
    const key = `ddi-provision:${redemption.id}`;
    assert.ok(portalStore.ddiProvisioningGet(key));
    assert.equal((await runOutbox(redemption.id)).completed, 1);
    const done = (await commercialRepo.getRedemption(redemption.id))!.redemption;
    assert.equal(done.provisioningReference, portalStore.ddiProvisioningGet(key).reference, "same Portal result for the retried key");
    // Duplicate delivery of the same provisioning request returns the identical reference.
    const replay = await new HttpPortalProvisioner({ url: `${portalBase}/internal/ddi/provisioning`, signer: DDI.signer }).provision({ idempotencyKey: key, redemptionId: redemption.id, ownerId, infrastructureId: redemption.infrastructureId, propertyId: redemption.propertyId, externalSystem: "lifeos", externalReference: `portal-install:${install.id}`, productId: "personal-brandos", planId: "creator", entitlementId: redemption.entitlementId, licenseId: redemption.licenseId, ownerSubject: `TD-${ownerId}` });
    assert.equal(replay.reference, done.provisioningReference);
    assert.equal((await portalBindings()).filter(row => row.installId === install.id).length, 1);
  });

  test("6 + 28: an abandoned outbox job is recovered by a restarted DDI process", async () => {
    const ownerId = "own_e2e_restart";
    const install = portalInstall(ownerId, "provisioning");
    const redeemed = await redeem(ownerId, install.id, "restart");
    const id = redeemed.body.redemption.id;
    portalStore.updateInstall(install.id, { status: "ready" });
    skewMs += 120_000;
    const crashed = new Pool({ connectionString: ddiDb, max: 2, options: `-c search_path=${SCHEMA}` });
    const [claimed] = await new PostgresCommercialRepository(crashed).claimOutbox({ now: clock(), limit: 1, leaseMs: 20_000, aggregateId: id });
    assert.ok(claimed, "worker claimed then died");
    await crashed.end();
    const restartedPool = new Pool({ connectionString: ddiDb, max: 4, options: `-c search_path=${SCHEMA}` });
    try {
      const restarted = new CommercialService({ repository: new PostgresCommercialRepository(restartedPool), pdi: new PostgresDdiRepository(restartedPool), ownership, provisioner: new HttpPortalProvisioner({ url: `${portalBase}/internal/ddi/provisioning`, signer: DDI.signer }), catalog: parseCatalog({ version: "e2e", products: [{ id: "personal-brandos", displayName: "P", plans: [{ id: "creator", edition: "creator", licenseType: "TERM", termDays: 365, renewable: true, requiresProperty: true, propertyTypes: ["PERSONAL_BRAND"], downloads: ["personal-brandos.apk"] }] }] }), pepper: PEPPER, clock });
      assert.equal((await restarted.runOutbox({ aggregateId: id })).processed, 0, "live lease respected");
      skewMs += 30_000;
      assert.equal((await restarted.runOutbox({ aggregateId: id })).completed, 1);
    } finally { await restartedPool.end(); }
    assert.equal((await ddi.getProperty(redeemed.body.redemption.propertyId))?.status, "ACTIVE");
  });

  test("8: a READY install for a different owner never activates the property", async () => {
    const victim = "own_e2e_victim";
    const install = portalInstall(victim, "ready");
    const attempt = await redeem("own_e2e_intruder", install.id, "intruder");
    assert.equal(attempt.body.code, "OWNERSHIP_NOT_VERIFIED");
    // Bootstrapped for the right owner, then the authoritative record names someone else before READY.
    const pending = portalInstall("own_e2e_handover", "provisioning");
    const redeemed = await redeem("own_e2e_handover", pending.id, "handover");
    portalStore.updateInstall(pending.id, { ownerTrustId: "TD-own_e2e_new_owner", status: "ready" });
    await runOutbox(redeemed.body.redemption.id);
    assert.equal((await ddi.getProperty(redeemed.body.redemption.propertyId))?.status, "FAILED");
    assert.equal((await commercialRepo.getLicense(redeemed.body.redemption.licenseId))?.status, "SUSPENDED");
  });

  test("11-16: Master Distributor fulfils only the exact owner, license, property, artifact and version", async () => {
    const { ownerId, redemption } = main;
    const grant = async (artifactId = "personal-brandos.apk", version = "1.4.0") => (await ddiCall("POST", `/me/licenses/${redemption.licenseId}/downloads`, session(ownerId), { artifactId, version })).body;
    // 16: wrong version and wrong artifact are refused and do not consume the grant.
    const g = await grant();
    assert.equal((await fulfil(g.token, "personal-brandos.apk", "1.5.0")).body.error, "DOWNLOAD_SCOPE_MISMATCH");
    assert.equal((await fulfil(g.token, "personal-brandos.web", "1.4.0")).body.error, "DOWNLOAD_SCOPE_MISMATCH");
    // 15: cross-property.
    assert.equal((await fulfil(g.token, "personal-brandos.apk", "1.4.0", "property:not-this-one")).body.error, "DOWNLOAD_SCOPE_MISMATCH");
    const delivered = await fulfil(g.token, "personal-brandos.apk", "1.4.0", redemption.propertyId);
    assert.equal(delivered.status, 201, JSON.stringify(delivered.body));
    assert.equal(delivered.body.version, "1.4.0");
    const bytes = await download(delivered.body.deliveryUrl);
    assert.equal(bytes.status, 200);
    assert.equal(sha256(bytes.bytes), delivered.body.checksumSha256);
    assert.equal(bytes.headers.get("x-artifact-sha256"), delivered.body.checksumSha256);
    // 13: reuse of the DDI grant and of the delivery.
    assert.equal((await fulfil(g.token, "personal-brandos.apk", "1.4.0")).body.error, "DOWNLOAD_GRANT_CONSUMED");
    assert.equal((await download(delivered.body.deliveryUrl)).status, 410);
    // 14: cross-owner.
    assert.equal((await ddiCall("POST", `/me/licenses/${redemption.licenseId}/downloads`, session("own_e2e_stranger"), { artifactId: "personal-brandos.apk", version: "1.4.0" })).status, 404);
    // 12: expired grant (DDI clock beyond the 60 s grant TTL).
    const late = await grant();
    skewMs += 61_000;
    assert.equal((await fulfil(late.token, "personal-brandos.apk", "1.4.0")).body.error, "DOWNLOAD_GRANT_EXPIRED");
    // 11: license suspension after issuance denies fulfilment.
    const before = await grant();
    assert.equal((await ddiCall("POST", `/admin/commercial/licenses/${redemption.licenseId}/suspend`, session(admin), { reason: "review" })).status, 200);
    assert.equal((await fulfil(before.token, "personal-brandos.apk", "1.4.0")).body.error, "LICENSE_SUSPENDED");
    assert.equal((await ddiCall("POST", `/admin/commercial/licenses/${redemption.licenseId}/reinstate`, session(admin), { reason: "ok" })).status, 200);
  });

  test("17, 18, 21-23: private artifacts stay private; public, integrity and expiry policies hold", async () => {
    // 17: no guest path to a licensed artifact; guessed delivery tokens fail.
    assert.equal((await mdCall("GET", "/downloads/personal-brandos/latest?platform=apk")).status, 404);
    assert.equal((await download(`${mdBase}/v1/delivery/mddl_${"A".repeat(43)}`)).status, 404);
    assert.equal((await mdCall("GET", "/v1/releases/personal-brandos/1.4.0/download?platform=apk")).status, 401);
    // 18: explicitly public release.
    const pub = await mdCall("GET", "/downloads/lifeos/latest?platform=web");
    assert.equal(pub.status, 201);
    const pubBytes = await download(pub.body.deliveryUrl);
    assert.equal(pubBytes.status, 200);
    assert.equal(sha256(pubBytes.bytes), pub.body.checksumSha256);
    // 21: missing checksum.
    const up = await fetch(new URL("/v1/uploads", mdBase), { method: "PUT", headers: { "content-type": "application/octet-stream", authorization: `Bearer ${signServiceToken(PUBLISHER.signer, { audience: "master-distributor", method: "PUT", path: "/v1/uploads" })}` }, body: Buffer.from("no checksum") });
    const uploaded = await up.json() as { uploadId: string };
    const missing = await fetch(new URL("/v1/releases", mdBase), { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${signServiceToken(PUBLISHER.signer, { audience: "master-distributor", method: "POST", path: "/v1/releases" })}` }, body: JSON.stringify({ appId: "liveos", version: "1.0.0", artifacts: [{ platform: "web", filename: "x.tgz", uploadId: uploaded.uploadId, signature: { keyId: SIGNING.keyId, value: "x" } }] }) });
    assert.equal(missing.status, 400);
    assert.equal((await missing.json() as { error: string }).error, "CHECKSUM_REQUIRED");
    // 22: tampering on disk is detected at delivery.
    const tampered = await publish("realestateos", "2.0.0", "public", ["web"]);
    await writeFile(join(artifactDir, tampered.release.artifacts[0]!.objectKey), Buffer.from("trojaned bytes"));
    const t = await mdCall("GET", "/downloads/realestateos/latest?platform=web");
    const tamperedDownload = await download(t.body.deliveryUrl);
    assert.equal(tamperedDownload.status, 500);
    assert.match(tamperedDownload.bytes.toString(), /ARTIFACT_INTEGRITY_FAILURE/);
    // 23: delivery expiry, in real time (TTL 15 s).
    const expiring = await mdCall("GET", "/downloads/lifeos/latest?platform=web");
    await sleep(16_000);
    assert.equal((await download(expiring.body.deliveryUrl)).status, 410);
    assert.ok((await readdir(artifactDir)).length > 0, "real volume storage used");
  });

  test("19 + 20: invalid service tokens and forged permission claims are refused everywhere", async () => {
    const rogue = identity("master-distributor");
    const redeemPath = "/internal/downloads/redeem";
    const unpinned = await ddiCall("POST", redeemPath, `Bearer ${signServiceToken(rogue.signer, { audience: "ddi", method: "POST", path: redeemPath })}`, { token: "ddidl_x", artifactId: "personal-brandos.apk", version: "1.4.0" });
    assert.equal(unpinned.status, 401);
    // The Portal's genuine key, claiming the distributor's permission: DDI grants only what it configured for the Portal.
    const now = Math.floor(Date.now() / 1000);
    const h = Buffer.from(JSON.stringify({ alg: "EdDSA", typ: "digiconomy-service+jwt", kid: PORTAL.keyId })).toString("base64url");
    const p = Buffer.from(JSON.stringify({ iss: PORTAL.serviceId, sub: PORTAL.serviceId, aud: "ddi", iat: now, exp: now + 60, jti: "forged-role", htm: "POST", htu: redeemPath, permissions: ["downloads:redeem"], roles: ["admin", "service"] })).toString("base64url");
    const forged = `${h}.${p}.${edSign(null, Buffer.from(`${h}.${p}`), PORTAL.privateKey).toString("base64url")}`;
    assert.equal((await ddiCall("POST", redeemPath, `Bearer ${forged}`, { token: "ddidl_x", artifactId: "personal-brandos.apk", version: "1.4.0" })).status, 403);
    // Portal refuses a token that is not DDI's; MD refuses the old HS256 development secret path entirely.
    const portalForged = await fetch(new URL("/internal/ddi/provisioning", portalBase), { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${signServiceToken(rogue.signer, { audience: "lifeos-portal", method: "POST", path: "/internal/ddi/provisioning" })}`, "x-ddi-contract": "ddi.portal.provisioning.v1" }, body: "{}" });
    assert.equal(portalForged.status, 401);
    const events = await ddiCall("POST", "/internal/portal/install-events", `Bearer ${signServiceToken(MD.signer, { audience: "ddi", method: "POST", path: "/internal/portal/install-events" })}`, {});
    assert.equal(events.status, 403, "the distributor may not publish Portal events");
    assert.equal((await mdCall("POST", "/v1/releases", { appId: "lifeos" }, { authorization: "Bearer not-a-token" })).status, 401);
  });

  test("9, 10, 27: suspension and retirement propagate durably; lost and reordered events are safe", async () => {
    const ownerId = "own_e2e_events";
    const install = portalInstall(ownerId, "ready");
    const redemption = (await redeem(ownerId, install.id, "events")).body.redemption;
    assert.equal((await ddi.getProperty(redemption.propertyId))?.status, "ACTIVE");
    const app = await ddi.registerApplication(ownerId as DigiOwnerId, redemption.infrastructureId, { type: "WEB", displayName: "events app", propertyId: redemption.propertyId, capabilities: ["identity.currentActor"], idempotencyKey: "e2e-events-app" });
    const executeAs = () => service.execute({ infrastructureId: redemption.infrastructureId, applicationId: app.id, capability: "identity.currentActor", action: "identity.currentActor", resource: "r", audience: "ddi", actor: { ownerId: ownerId as DigiOwnerId, kind: "SERVICE", verified: true, authorityActor: `app:${app.id}` }, correlationId: "e2e-exec" });

    // 9: suspension in the Portal reaches DDI through the real outbox.
    portalStore.updateInstall(install.id, { suspended: true });
    const delivered = await deliverEvents();
    assert.ok(delivered.delivered >= 1);
    assert.equal((await ddi.getProperty(redemption.propertyId))?.status, "SUSPENDED");
    assert.equal((await executeAs()).reason, "PROPERTY_NOT_ACTIVE");
    assert.equal((await ddiCall("POST", `/me/licenses/${redemption.licenseId}/downloads`, session(ownerId), { artifactId: "personal-brandos.apk", version: "1.4.0" })).body.code, "PROPERTY_NOT_ACTIVE");
    // A stale READY / provisioning retry cannot reactivate it.
    await commercialRepo.activateProperty(redemption.id, new Date(), "stale-ready");
    assert.equal((await ddi.getProperty(redemption.propertyId))?.status, "SUSPENDED");

    // 27a: reordered delivery. Newest is a suspension; the older reinstatement arrives late and
    // must not re-activate the property (a sequence-blind consumer would end ACTIVE here).
    portalStore.updateInstall(install.id, { suspended: false });
    portalStore.updateInstall(install.id, { suspended: true });
    const pending = portalStore.listDdiInstallEvents().filter((e: any) => e.installId === install.id && e.status === "PENDING");
    assert.deepEqual(pending.map((e: any) => e.type), ["INSTALL_REINSTATED", "INSTALL_SUSPENDED"]);
    const post = (event: any) => ddiCall("POST", "/internal/portal/install-events", `Bearer ${signServiceToken(PORTAL.signer, { audience: "ddi", method: "POST", path: "/internal/portal/install-events" })}`, { contractVersion: "portal.install-events.v1", eventId: event.id, type: event.type, installId: event.installId, externalReference: event.externalReference, ownerSubject: event.ownerSubject, sequence: event.sequence, state: event.state, correlationId: event.correlationId, occurredAt: event.occurredAt });
    assert.equal((await post(pending[1])).body.outcome, "APPLIED");
    assert.equal((await post(pending[0])).body.outcome, "STALE");
    assert.equal((await ddi.getProperty(redemption.propertyId))?.status, "SUSPENDED", "the late reinstatement is ignored");
    await deliverEvents();
    assert.equal((await ddi.getProperty(redemption.propertyId))?.status, "SUSPENDED", "re-delivered duplicates are inert");
    portalStore.updateInstall(install.id, { suspended: false });
    await deliverEvents();
    assert.equal((await ddi.getProperty(redemption.propertyId))?.status, "ACTIVE");

    // 27b: a lost suspension event is recovered by reconciliation against the real Portal.
    portalStore.updateInstall(install.id, { suspended: true });
    for (const e of portalStore.listDdiInstallEvents().filter((x: any) => x.status === "PENDING")) portalStore.updateDdiInstallEvent(e.id, { status: "DELIVERED", outcome: "LOST_IN_TEST" });
    assert.equal((await ddi.getProperty(redemption.propertyId))?.status, "ACTIVE", "DDI has not heard");
    await reconcilePortalInstalls({ store: installState, ownership });
    assert.equal((await ddi.getProperty(redemption.propertyId))?.status, "SUSPENDED");
    // ...and a lost reinstatement is recovered only because the Portal reports a newer sequence.
    portalStore.updateInstall(install.id, { suspended: false });
    for (const e of portalStore.listDdiInstallEvents().filter((x: any) => x.status === "PENDING")) portalStore.updateDdiInstallEvent(e.id, { status: "DELIVERED", outcome: "LOST_IN_TEST" });
    await reconcilePortalInstalls({ store: installState, ownership });
    assert.equal((await ddi.getProperty(redemption.propertyId))?.status, "ACTIVE");
    await reconcilePortalInstalls({ store: installState, ownership });
    assert.equal((await ddi.getProperty(redemption.propertyId))?.status, "ACTIVE", "a repeated READY at the same sequence changes nothing");

    // Owner-account suspension also propagates.
    portalStore.updateUser(portalOwner(ownerId).id, { suspended: true });
    await deliverEvents();
    assert.equal((await ddi.getProperty(redemption.propertyId))?.status, "SUSPENDED");
    portalStore.updateUser(portalOwner(ownerId).id, { suspended: false });
    await deliverEvents();
    assert.equal((await ddi.getProperty(redemption.propertyId))?.status, "ACTIVE");

    // 10: retirement revokes; revoked property is denied capabilities and cannot return.
    portalStore.deleteInstall(install.id);
    await deliverEvents();
    assert.equal((await ddi.getProperty(redemption.propertyId))?.status, "REVOKED");
    assert.equal((await executeAs()).reason, "PROPERTY_NOT_ACTIVE");
    assert.deepEqual(await commercial.verifyLicense(redemption.licenseId), { valid: false, reason: "PROPERTY_NOT_ACTIVE" });
    const state = await installState.state(`portal-install:${install.id}`);
    assert.equal(state?.retired, true);
  });

  test("24: failed Portal provisioning is recovered by an audited operator requeue", async () => {
    const ownerId = "own_e2e_requeue";
    // A failed Portal install never verifies, so the code is not consumed.
    const failed = portalInstall(ownerId, "failed");
    assert.equal((await redeem(ownerId, failed.id, "requeue-failed")).body.code, "OWNERSHIP_VERIFICATION_PENDING");
    const install = portalInstall(ownerId, "provisioning");
    // Make the real Portal reject provisioning: install bound to a different license already.
    portalStore.updateInstall(install.id, { ddiLicense: { licenseId: "license:other", entitlementId: "entitlement:other", productId: "personal-brandos", planId: "creator", redemptionId: "redemption:other", reference: "x", boundAt: new Date().toISOString() } });
    const rejected = (await redeem(ownerId, install.id, "requeue-2")).body.redemption;
    assert.equal(rejected.status, "ATTENTION_REQUIRED");
    assert.equal(rejected.lastError, "PROVISIONING_REJECTED");
    // The Portal operator fixes the conflicting binding; the DDI operator requeues.
    portalStore.updateInstall(install.id, { ddiLicense: undefined, status: "ready" });
    assert.equal((await ddiCall("POST", `/admin/commercial/redemptions/${rejected.id}/requeue`, session(ownerId), { reason: "self" })).status, 403);
    const requeued = await ddiCall("POST", `/admin/commercial/redemptions/${rejected.id}/requeue`, session(admin), { reason: "portal binding conflict resolved" });
    assert.equal(requeued.status, 200, JSON.stringify(requeued.body));
    assert.equal(requeued.body.redemption.status, "COMPLETED");
    assert.equal(portalStore.getInstall(install.id).ddiLicense.licenseId, rejected.licenseId);
    assert.equal(await count(`ddi_licenses WHERE owner_id = $1`, [ownerId]), 1);
  });

  test("26: concurrent redemption and Portal suspension never leave an active property", async () => {
    for (let round = 0; round < 3; round++) {
      const ownerId = `own_e2e_race_${round}`;
      const install = portalInstall(ownerId, "ready");
      const code = await issue();
      const [redeemed] = await Promise.all([
        redeem(ownerId, install.id, `race-${round}`, code),
        (async () => { await sleep(round * 15); portalStore.updateInstall(install.id, { suspended: true }); await deliverEvents(); })(),
      ]);
      await deliverEvents();
      const propertyId = redeemed.body.redemption?.propertyId;
      if (propertyId) {
        if (redeemed.body.redemption.status !== "COMPLETED") await runOutbox(redeemed.body.redemption.id);
        await reconcilePortalInstalls({ store: installState, ownership });
        assert.notEqual((await ddi.getProperty(propertyId))?.status, "ACTIVE", `round ${round}`);
      } else {
        assert.match(String(redeemed.body.code), /OWNERSHIP_VERIFICATION_PENDING/, `round ${round}: suspended before bootstrap`);
      }
    }
  });

  test("25: no duplicate PDI, property, installation, license or provisioning binding", async () => {
    const dupPdi = await pool.query(`SELECT owner_id FROM ddi_infrastructures WHERE type = 'PERSONAL' GROUP BY owner_id HAVING count(*) > 1`);
    assert.equal(dupPdi.rowCount, 0);
    const dupProperty = await pool.query(`SELECT external_reference FROM ddi_connected_properties GROUP BY external_system, external_reference HAVING count(*) > 1`);
    assert.equal(dupProperty.rowCount, 0);
    const dupLicense = await pool.query(`SELECT entitlement_id FROM ddi_licenses GROUP BY entitlement_id HAVING count(*) > 1`);
    assert.equal(dupLicense.rowCount, 0);
    const installs = portalStore.listAllInstalls();
    assert.equal(new Set(installs.map((i: { id: string }) => i.id)).size, installs.length);
    const bindings = await portalBindings();
    assert.equal(new Set(bindings.map(b => b.redemptionId)).size, bindings.length);
  });

  test("28: a restarted Portal still holds undelivered events and delivers them", async () => {
    const ownerId = "own_e2e_portal_restart";
    const install = portalInstall(ownerId, "ready");
    const redemption = (await redeem(ownerId, install.id, "portal-restart")).body.redemption;
    portalStore.updateInstall(install.id, { suspended: true });
    await portalStore.flush();
    const { openStore } = await importFrom(PORTAL_ROOT, "/apps/portal-api/src/store/open.ts");
    const reopened = await openStore({ databaseUrl: portalDb });
    try {
      const pendingAfterRestart = reopened.listDdiInstallEvents().filter((e: any) => e.installId === install.id && e.status === "PENDING");
      assert.equal(pendingAfterRestart.length, 1, "durable in Postgres across restart");
      const { deliverDdiInstallEvents } = await importFrom(PORTAL_ROOT, "/apps/portal-api/src/services/ddi-install-events.ts");
      assert.equal((await deliverDdiInstallEvents({ store: reopened, url: `${ddiBase}/internal/portal/install-events`, signer: PORTAL.signer })).delivered >= 1, true);
      assert.equal((await ddi.getProperty(redemption.propertyId))?.status, "SUSPENDED");
      await reopened.flush();
    } finally { await reopened.close(); }
  });
});
