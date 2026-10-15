import test, { after, before, describe } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { Pool } from "pg";
import type { Actor, DigiOwnerId } from "../packages/contracts/src/index.ts";
import { buildApi } from "../apps/api/src/app.ts";
import { CommercialService, type CommercialProvisioner, type ProvisioningRequest } from "../packages/service/src/commercial.ts";
import { parseCatalog } from "../packages/service/src/commercial-catalog.ts";
import { PostgresCommercialRepository } from "../packages/service/src/commercial-repository.ts";
import { readConfig } from "../packages/service/src/config.ts";
import type { DigiSessionClient } from "../packages/service/src/digi.ts";
import type { OwnershipRequest, OwnershipVerification, OwnershipVerifier } from "../packages/service/src/ownership.ts";
import { migrate } from "../packages/service/src/postgres.ts";
import { PostgresDdiRepository } from "../packages/service/src/postgres-repository.ts";
import { DurableDdiService, defaultAdapters } from "../packages/service/src/runtime.ts";
import { testServiceIdentity } from "./helpers/service-keys.ts";

/*
 * D3C-A integration readiness.
 * REAL:    DDI HTTP API on a socket, D1 DurableDdiService, CommercialService, PostgreSQL.
 * DOUBLES: Digi session resolution, Portal ownership (D3A contract), Portal provisioning
 *          (PROPOSED ddi.portal.provisioning.v1; no Portal endpoint exists yet), and the
 *          Master Distributor (PROPOSED fulfillment; it calls DDI's real redeem endpoint).
 */
const databaseUrl = process.env.DDI_TEST_DATABASE_URL ?? "";
const schema = "ddi_commercial_integration";
const PEPPER = "d3c-test-pepper-0123456789abcdefghijklmnop";
const distributorIdentity = testServiceIdentity("master-distributor");
const START = Date.parse("2026-10-16T09:00:00.000Z");
const catalog = parseCatalog({
  version: "d3c-test",
  products: [{ id: "personal-brandos", displayName: "Personal BrandOS", plans: [{ id: "creator", edition: "creator", licenseType: "TERM", termDays: 365, renewable: true, requiresProperty: true, propertyTypes: ["PERSONAL_BRAND"], downloads: ["personal-brandos.apk", "personal-brandos.web"] }] }],
});

/** D3A ownership contract double: the authoritative PortalInstall owner and readiness. */
class PortalOwnershipDouble implements OwnershipVerifier {
  installs = new Map<string, { subject: string; state: "ready" | "pending" }>();
  set(install: string, subject: string, state: "ready" | "pending") { this.installs.set(`portal-install:${install}`, { subject, state }); }
  async verify(input: OwnershipRequest): Promise<OwnershipVerification> {
    const install = this.installs.get(input.externalReference);
    if (!install || install.subject !== input.trustIdSubject) throw new Error("OWNERSHIP_NOT_VERIFIED");
    if (install.state === "pending" && input.purpose !== "BOOTSTRAP") throw new Error("OWNERSHIP_VERIFICATION_PENDING");
    return { verified: true, issuer: "portal-double", evidenceId: `${input.externalReference}:${input.trustIdSubject}:${install.state}`, verifiedAt: new Date().toISOString(), readiness: install.state === "ready" ? "READY" : "PENDING" };
  }
}

/**
 * Proposed Portal provisioning contract double. Semantics it must honour:
 * idempotent by key (same key + same payload -> same reference, one effect),
 * same key + different payload -> PROVISIONING_REJECTED, outage -> UNAVAILABLE.
 */
class PortalProvisioningDouble implements CommercialProvisioner {
  mode: "up" | "down" | "reject" = "up";
  calls: ProvisioningRequest[] = [];
  effects = new Map<string, { reference: string; fingerprint: string }>();
  async provision(input: ProvisioningRequest) {
    this.calls.push(input);
    if (this.mode === "down") throw new Error("PROVISIONING_UNAVAILABLE");
    if (this.mode === "reject") throw new Error("PROVISIONING_REJECTED");
    const fingerprint = JSON.stringify([input.ownerId, input.propertyId, input.externalReference, input.productId, input.planId, input.licenseId]);
    const prior = this.effects.get(input.idempotencyKey);
    if (prior) {
      if (prior.fingerprint !== fingerprint) throw new Error("PROVISIONING_REJECTED");
      return { reference: prior.reference };
    }
    const reference = `portal-provisioning:${this.effects.size + 1}`;
    this.effects.set(input.idempotencyKey, { reference, fingerprint });
    return { reference };
  }
}

/** Proposed Master Distributor double. It owns artifact metadata; DDI owns authorization. */
class MasterDistributorDouble {
  down = false;
  registry = new Map([
    ["personal-brandos.apk", { appId: "personal-brandos", version: "1.4.0", platform: "apk", checksumSha256: "a".repeat(64) }],
    ["personal-brandos.web", { appId: "personal-brandos", version: "1.4.0", platform: "web", checksumSha256: "b".repeat(64) }],
  ]);
  private ddiBase: () => string;
  constructor(ddiBase: () => string) { this.ddiBase = ddiBase; }
  async fulfill(input: { token: string; artifactId: string; propertyId?: string }) {
    if (this.down) throw new Error("DISTRIBUTOR_UNAVAILABLE");
    const response = await fetch(new URL("/internal/downloads/redeem", this.ddiBase()), { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${distributorIdentity.token("ddi", "POST", "/internal/downloads/redeem")}`, "x-correlation-id": `md-${input.artifactId}` }, body: JSON.stringify({ token: input.token, artifactId: input.artifactId, version: "1.4.0", propertyId: input.propertyId }) });
    const body = await response.json() as { code?: string; artifactId?: string; ownerId?: string };
    if (!response.ok) return { status: response.status, code: body.code };
    const artifact = this.registry.get(body.artifactId!);
    if (!artifact) return { status: 404, code: "ARTIFACT_NOT_PUBLISHED" };
    return { status: 200, ownerId: body.ownerId, artifact };
  }
}

describe("D3C-A Portal x Master Distributor integration readiness", { concurrency: 1 }, () => {
  let pool: Pool;
  let ddi: PostgresDdiRepository;
  let repository: PostgresCommercialRepository;
  let commercial: CommercialService;
  let ddiBase = "";
  let now = START;
  let closeApi: () => Promise<unknown> = async () => undefined;
  const ownership = new PortalOwnershipDouble();
  const provisioning = new PortalProvisioningDouble();
  const distributor = new MasterDistributorDouble(() => ddiBase);
  const sessions = new Map<string, { ownerId: DigiOwnerId; sessionId: string; subject: string }>();
  const session = (ownerId: string) => { const token = `session-${ownerId}`; sessions.set(token, { ownerId: ownerId as DigiOwnerId, sessionId: token, subject: `TD-${ownerId}` }); return token; };
  const actor = (ownerId: string): Actor => ({ ownerId: ownerId as DigiOwnerId, subject: `TD-${ownerId}`, kind: "HUMAN", verified: true });
  const admin = "own_d3c_admin";
  const call = async (method: string, path: string, token?: string, body?: unknown, headers: Record<string, string> = {}) => {
    const response = await fetch(new URL(path, ddiBase), { method, headers: { ...(token ? { authorization: token.startsWith("Application ") ? token : `Bearer ${token}` } : {}), ...(body !== undefined ? { "content-type": "application/json" } : {}), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, body: await response.json() as any };
  };
  const issue = async () => {
    const issued = await call("POST", "/admin/commercial/activation-codes", session(admin), { productId: "personal-brandos", planId: "creator", paymentReference: "manual-transfer", expiresInHours: 24 }, { "idempotency-key": `issue-${Math.random()}` });
    assert.equal(issued.status, 201, JSON.stringify(issued.body));
    return issued.body.code as string;
  };
  const redeem = async (ownerId: string, install: string, key: string) => call("POST", "/me/activations/redeem", session(ownerId), { code: await issue(), property: { type: "PERSONAL_BRAND", externalSystem: "lifeos", externalReference: `portal-install:${install}`, displayName: install } }, { "idempotency-key": key });
  const count = async (sql: string, values: unknown[] = []) => Number((await pool.query<{ n: string }>(`SELECT count(*)::text AS n FROM ${sql}`, values)).rows[0]!.n);
  const later = (ms: number) => { now += ms; };

  before(async () => {
    if (!databaseUrl) throw new Error("DDI_TEST_DATABASE_URL_REQUIRED");
    if (!["127.0.0.1", "localhost", "::1"].includes(new URL(databaseUrl).hostname)) throw new Error("DDI Postgres tests only run against a local disposable database");
    const bootstrap = new Pool({ connectionString: databaseUrl, max: 1 });
    await bootstrap.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await bootstrap.query(`CREATE SCHEMA ${schema}`);
    await bootstrap.end();
    pool = new Pool({ connectionString: databaseUrl, max: 16, options: `-c search_path=${schema}` });
    for (const migration of ["001_ddi_foundation.sql", "002_ddi_runtime.sql", "003_pdi_connections.sql", "004_connected_properties.sql", "005_commercial_activation.sql", "006_commercial_recovery.sql", "007_portal_install_state.sql", "008_download_grant_version.sql", "009_service_token_replay.sql"]) await migrate(pool, join("migrations", migration));
    ddi = new PostgresDdiRepository(pool);
    repository = new PostgresCommercialRepository(pool);
    await repository.setOperator(admin, "COMMERCIAL_ADMIN", "test-bootstrap", new Date(START));
    commercial = new CommercialService({ repository, pdi: ddi, ownership, provisioner: provisioning, catalog, pepper: PEPPER, clock: () => new Date(now), downloadTtlSeconds: 60, outbox: { baseDelayMs: 1_000, maxDelayMs: 10_000, leaseMs: 20_000, maxAttempts: 3 } });
    const sessionClient: DigiSessionClient = { async resolve(token) { return sessions.get(token) ?? null; } };
    const service = new DurableDdiService(ddi, async () => ({ ok: false, reason: "MISSING" }), defaultAdapters(async () => null), sessionClient);
    const api = buildApi({ service, commercial, config: { ...readConfig({ DDI_ENV: "test" }), trustedServices: { "master-distributor": distributorIdentity.trusted(["downloads:redeem"]) } } });
    ddiBase = await api.listen({ port: 0, host: "127.0.0.1" });
    closeApi = () => api.close();
  });
  after(async () => { await closeApi(); await pool?.end(); });

  test("1 + 15: activation completes through provisioning on the owner's single PDI", async () => {
    const owner = "own_d3c_success";
    await ddi.provision(owner as DigiOwnerId, { type: "PERSONAL", idempotencyKey: "d3c-success-pdi" });
    ownership.set("success", `TD-${owner}`, "ready");
    const result = await redeem(owner, "success", "success");
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.equal(result.body.redemption.status, "COMPLETED");
    assert.equal(provisioning.effects.size >= 1, true);
    assert.equal((await ddi.getProperty(result.body.redemption.propertyId))?.status, "ACTIVE");
    assert.match((await ddi.getProperty(result.body.redemption.propertyId))!.ownershipEvidence, /portal:portal-double:.*:ready:/);
    assert.equal(await count(`ddi_infrastructures WHERE owner_id = $1`, [owner]), 1);
  });

  test("2 + 3: Portal provisioning outage is a durable pending state that recovers without false success", async () => {
    const owner = "own_d3c_outage";
    ownership.set("outage", `TD-${owner}`, "ready");
    provisioning.mode = "down";
    const pending = await redeem(owner, "outage", "outage");
    assert.equal(pending.status, 202);
    assert.equal(pending.body.redemption.status, "PROVISIONING_PENDING");
    assert.equal(pending.body.redemption.provisionedAt, undefined);
    assert.equal(pending.body.redemption.lastError, "PROVISIONING_UNAVAILABLE");
    const id = pending.body.redemption.id;
    later(2_000);
    assert.equal((await commercial.runOutbox({ aggregateId: id })).retried, 1, "still down: retried, not completed");
    provisioning.mode = "up";
    later(5_000);
    assert.equal((await commercial.runOutbox({ aggregateId: id })).completed, 1);
    const status = await call("GET", `/me/activations/${id}`, session(owner));
    assert.equal(status.body.status, "COMPLETED");
    assert.equal(new Set(provisioning.calls.filter(item => item.redemptionId === id).map(item => item.idempotencyKey)).size, 1);
  });

  test("4: duplicate provisioning deliveries produce one Portal effect", async () => {
    const owner = "own_d3c_duplicate";
    ownership.set("duplicate", `TD-${owner}`, "pending");
    const pending = await redeem(owner, "duplicate", "duplicate");
    const id = pending.body.redemption.id;
    const key = `ddi-provision:${id}`;
    ownership.set("duplicate", `TD-${owner}`, "ready");
    later(5_000);
    await Promise.all([commercial.runOutbox({ aggregateId: id }), commercial.runOutbox({ aggregateId: id }), commercial.runOutbox({ aggregateId: id })]);
    await pool.query(`UPDATE ddi_commercial_outbox SET status = 'PENDING', next_attempt_at = $2 WHERE aggregate_id = $1`, [id, new Date(now).toISOString()]);
    await commercial.runOutbox({ aggregateId: id });
    assert.equal(provisioning.calls.filter(item => item.idempotencyKey === key).length, 1);
    assert.equal([...provisioning.effects.keys()].filter(item => item === key).length, 1);
    assert.equal((await repository.getRedemption(id))?.redemption.status, "COMPLETED");
  });

  test("5: a worker crash after Portal success but before DDI acknowledgement re-converges on one effect", async () => {
    const owner = "own_d3c_crash";
    ownership.set("crash", `TD-${owner}`, "ready");
    provisioning.mode = "down";
    const pending = await redeem(owner, "crash", "crash");
    const id = pending.body.redemption.id;
    provisioning.mode = "up";
    later(5_000);
    // The worker claims, the Portal call succeeds, then the process dies before markProvisioned/settle.
    const [claimed] = await repository.claimOutbox({ now: new Date(now), limit: 1, leaseMs: 20_000, aggregateId: id });
    assert.ok(claimed);
    const license = await repository.getLicense(pending.body.redemption.licenseId);
    const first = await provisioning.provision({ idempotencyKey: `ddi-provision:${id}`, redemptionId: id, ownerId: owner, infrastructureId: pending.body.redemption.infrastructureId, propertyId: pending.body.redemption.propertyId, externalSystem: "lifeos", externalReference: "portal-install:crash", productId: license!.productId, planId: license!.planId, entitlementId: license!.entitlementId, licenseId: license!.id });
    assert.equal((await repository.getRedemption(id))?.redemption.provisionedAt, undefined, "DDI has not acknowledged");
    assert.equal((await commercial.runOutbox({ aggregateId: id })).processed, 0, "live lease is respected");
    later(21_000);
    assert.equal((await commercial.runOutbox({ aggregateId: id })).completed, 1);
    const done = await repository.getRedemption(id);
    assert.equal(done?.redemption.provisioningReference, first.reference);
    assert.equal([...provisioning.effects.keys()].filter(item => item === `ddi-provision:${id}`).length, 1);
    assert.equal(await repository.settleOutbox(claimed, { status: "DEAD", at: new Date(now), error: "STALE" }), false);
  });

  test("6 + 16: privilege waits for READY, and the final check rejects a changed or stale owner", async () => {
    const owner = "own_d3c_handover";
    ownership.set("handover", `TD-${owner}`, "pending");
    const pending = await redeem(owner, "handover", "handover");
    const { id, propertyId, licenseId, infrastructureId } = pending.body.redemption;
    assert.equal((await ddi.getProperty(propertyId))?.status, "PENDING_ACTIVATION");
    // No privilege before activation: no download, no property application, no license validity.
    assert.equal((await call("POST", `/me/licenses/${licenseId}/downloads`, session(owner), { artifactId: "personal-brandos.apk", version: "1.4.0" })).body.code, "PROPERTY_NOT_ACTIVE");
    await assert.rejects(ddi.registerApplication(owner as DigiOwnerId, infrastructureId, { type: "WEB", displayName: "early", propertyId, capabilities: [], idempotencyKey: "handover-app" }), /PROPERTY_NOT_ACTIVE/);
    assert.equal((await call("GET", `/me/licenses/${licenseId}`, session(owner))).body.valid, false);
    // The Portal install changes hands and becomes READY for someone else.
    ownership.set("handover", "TD-own_d3c_new_owner", "ready");
    later(5_000);
    await commercial.runOutbox({ aggregateId: id });
    assert.equal((await ddi.getProperty(propertyId))?.status, "FAILED");
    assert.equal((await repository.getLicense(licenseId))?.status, "SUSPENDED");
    // Recovery cannot resurrect it: the requeued job re-verifies and stays closed.
    const requeued = await call("POST", `/admin/commercial/redemptions/${id}/requeue`, session(admin), { reason: "owner disputes handover" });
    assert.equal(requeued.status, 200, JSON.stringify(requeued.body));
    assert.equal((await ddi.getProperty(propertyId))?.status, "FAILED");
    assert.equal(requeued.body.redemption.status, "ATTENTION_REQUIRED");
    // DDI-side owner binding: a READY answer cannot promote a property DDI records for someone else.
    await pool.query(`UPDATE ddi_connected_properties SET status = 'PENDING_ACTIVATION' WHERE id = $1`, [propertyId]);
    await pool.query(`UPDATE ddi_connected_properties SET owner_id = 'own_d3c_intruder' WHERE id = $1`, [propertyId]);
    assert.equal(await repository.activateProperty(id, new Date(now), "tamper", "receipt"), false);
    assert.equal((await ddi.getProperty(propertyId))?.status, "PENDING_ACTIVATION");
  });

  test("7-13: Master Distributor fulfilment through DDI's single-use grant", async () => {
    const owner = "own_d3c_download";
    const other = "own_d3c_download_other";
    ownership.set("download-a", `TD-${owner}`, "ready");
    ownership.set("download-b", `TD-${owner}`, "ready");
    const a = (await redeem(owner, "download-a", "download-a")).body.redemption;
    const b = (await redeem(owner, "download-b", "download-b")).body.redemption;
    const grant = async (licenseId: string, artifactId = "personal-brandos.apk") => call("POST", `/me/licenses/${licenseId}/downloads`, session(owner), { artifactId, version: "1.4.0" });
    // 13: artifact mismatch does not consume; the right artifact then succeeds.
    const g1 = (await grant(a.licenseId)).body;
    assert.equal((await distributor.fulfill({ token: g1.token, artifactId: "personal-brandos.web" })).code, "DOWNLOAD_SCOPE_MISMATCH");
    // 11: a distributor fulfilling for property B cannot spend property A's grant.
    assert.equal((await distributor.fulfill({ token: g1.token, artifactId: "personal-brandos.apk", propertyId: b.propertyId })).code, "DOWNLOAD_SCOPE_MISMATCH");
    const delivered = await distributor.fulfill({ token: g1.token, artifactId: "personal-brandos.apk", propertyId: a.propertyId });
    assert.equal(delivered.status, 200);
    assert.equal(delivered.ownerId, owner);
    assert.equal(delivered.artifact?.checksumSha256.length, 64);
    // 9: reuse.
    assert.equal((await distributor.fulfill({ token: g1.token, artifactId: "personal-brandos.apk" })).code, "DOWNLOAD_GRANT_CONSUMED");
    // 11: an application bound to property B cannot validate property A's license.
    // The one-time credential is returned at registration only (RegisteredApplication).
    const appB = await ddi.registerApplication(owner as DigiOwnerId, b.infrastructureId, { type: "WEB", displayName: "B app", propertyId: b.propertyId, capabilities: [], idempotencyKey: "download-app-b" }) as unknown as { applicationCredential: string };
    const crossProperty = await call("POST", "/licenses/verify", `Application ${appB.applicationCredential}`, { licenseId: a.licenseId });
    assert.deepEqual(crossProperty.body, { valid: false, reason: "PROPERTY_MISMATCH" });
    assert.equal((await call("POST", "/licenses/verify", `Application ${appB.applicationCredential}`, { licenseId: b.licenseId })).body.valid, true);
    // 10: cross-owner.
    assert.equal((await call("POST", `/me/licenses/${a.licenseId}/downloads`, session(other), { artifactId: "personal-brandos.apk", version: "1.4.0" })).status, 404);
    // 12: distributor outage consumes nothing; the grant simply expires and a fresh one works later.
    const g2 = (await grant(a.licenseId)).body;
    distributor.down = true;
    await assert.rejects(distributor.fulfill({ token: g2.token, artifactId: "personal-brandos.apk" }), /DISTRIBUTOR_UNAVAILABLE/);
    distributor.down = false;
    // 8: expiry.
    later(61_000);
    assert.equal((await distributor.fulfill({ token: g2.token, artifactId: "personal-brandos.apk" })).code, "DOWNLOAD_GRANT_EXPIRED");
    assert.equal((await distributor.fulfill({ token: (await grant(a.licenseId)).body.token, artifactId: "personal-brandos.apk" })).status, 200);
    // 7: revocation after issuance, before fulfilment.
    const g3 = (await grant(a.licenseId)).body;
    assert.equal((await call("POST", `/admin/commercial/licenses/${a.licenseId}/revoke`, session(admin), { reason: "refund" })).status, 200);
    assert.equal((await distributor.fulfill({ token: g3.token, artifactId: "personal-brandos.apk" })).code, "LICENSE_REVOKED");
    // A forged distributor credential is refused before any grant lookup.
    const forged = await fetch(new URL("/internal/downloads/redeem", ddiBase), { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${testServiceIdentity("master-distributor").token("ddi", "POST", "/internal/downloads/redeem")}` }, body: JSON.stringify({ token: g3.token, artifactId: "personal-brandos.apk", version: "1.4.0" }) });
    // Same service id, but a key DDI never pinned: rejected.
    assert.equal(forged.status, 401);
  });

  test("14: operator requeue is authorized, audited, bounded, restart-safe and creates nothing new", async () => {
    const owner = "own_d3c_requeue";
    ownership.set("requeue", `TD-${owner}`, "ready");
    provisioning.mode = "reject";
    const failed = await redeem(owner, "requeue", "requeue");
    const id = failed.body.redemption.id;
    assert.equal(failed.body.redemption.status, "ATTENTION_REQUIRED");
    const before = { entitlements: await count(`ddi_entitlements WHERE owner_id = $1`, [owner]), licenses: await count(`ddi_licenses WHERE owner_id = $1`, [owner]), properties: await count(`ddi_connected_properties WHERE owner_id = $1`, [owner]), pdis: await count(`ddi_infrastructures WHERE owner_id = $1`, [owner]) };
    assert.equal((await call("POST", `/admin/commercial/redemptions/${id}/requeue`, session(owner), { reason: "self" })).status, 403);
    assert.equal((await call("POST", `/admin/commercial/redemptions/${id}/requeue`, undefined, { reason: "anon" })).status, 401);
    assert.equal((await call("POST", `/admin/commercial/redemptions/${id}/requeue`, session(admin), {})).body.code, "REASON_REQUIRED");
    // Two failing requeues, then one durable requeue that a restarted service processes.
    for (const attempt of [1, 2]) {
      const response = await call("POST", `/admin/commercial/redemptions/${id}/requeue`, session(admin), { reason: `retry ${attempt}` });
      assert.equal(response.body.requeueCount, attempt);
      assert.equal(response.body.redemption.status, "ATTENTION_REQUIRED");
    }
    provisioning.mode = "up";
    await repository.requeueOutbox(id, { actor: `operator:${admin}`, reason: "portal fixed", at: new Date(now), correlationId: "requeue-3" });
    const restartedPool = new Pool({ connectionString: databaseUrl, max: 4, options: `-c search_path=${schema}` });
    try {
      const restarted = new CommercialService({ repository: new PostgresCommercialRepository(restartedPool), pdi: new PostgresDdiRepository(restartedPool), ownership, provisioner: provisioning, catalog, pepper: PEPPER, clock: () => new Date(now) });
      assert.equal((await restarted.runOutbox({ aggregateId: id })).completed, 1);
    } finally { await restartedPool.end(); }
    assert.equal((await repository.getRedemption(id))?.redemption.status, "COMPLETED");
    assert.equal((await call("POST", `/admin/commercial/redemptions/${id}/requeue`, session(admin), { reason: "again" })).body.code, "OUTBOX_JOB_COMPLETE");
    const afterCounts = { entitlements: await count(`ddi_entitlements WHERE owner_id = $1`, [owner]), licenses: await count(`ddi_licenses WHERE owner_id = $1`, [owner]), properties: await count(`ddi_connected_properties WHERE owner_id = $1`, [owner]), pdis: await count(`ddi_infrastructures WHERE owner_id = $1`, [owner]) };
    assert.deepEqual(afterCounts, before);
    assert.deepEqual(before, { entitlements: 1, licenses: 1, properties: 1, pdis: 1 });
    const audits = (await repository.audits()).filter(item => item.eventType === "OUTBOX_REQUEUED" && item.redemptionId === id);
    // Same frozen-clock timestamp; order by the requeue counter rather than audit insertion.
    assert.deepEqual(audits.map(item => [item.actor, item.reason, item.result]).sort((x, y) => x[2]!.localeCompare(y[2]!)), [[`operator:${admin}`, "retry 1", "REQUEUED:1/3"], [`operator:${admin}`, "retry 2", "REQUEUED:2/3"], [`operator:${admin}`, "portal fixed", "REQUEUED:3/3"]]);
    // The bound holds.
    ownership.set("capped", "TD-own_d3c_capped", "ready");
    provisioning.mode = "reject";
    try {
      const capped = (await redeem("own_d3c_capped", "capped", "capped")).body.redemption;
      assert.equal(capped.status, "ATTENTION_REQUIRED");
      for (let attempt = 1; attempt <= 3; attempt++) assert.equal((await repository.requeueOutbox(capped.id, { actor: `operator:${admin}`, reason: "r", at: new Date(now), correlationId: `cap-${attempt}` })).requeueCount, attempt);
      await assert.rejects(repository.requeueOutbox(capped.id, { actor: `operator:${admin}`, reason: "r", at: new Date(now), correlationId: "cap-4" }), /OUTBOX_REQUEUE_LIMIT/);
    } finally { provisioning.mode = "up"; }
  });
});
