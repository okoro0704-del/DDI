import test, { after, before, describe } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { Pool } from "pg";
import type { Actor, ConnectedPropertyType } from "../packages/contracts/src/index.ts";
import { buildApi, type DdiApiService } from "../apps/api/src/app.ts";
import { parseActivationCode } from "../packages/service/src/activation-code.ts";
import { CommercialService, type CommercialProvisioner, type ProvisioningRequest } from "../packages/service/src/commercial.ts";
import { parseCatalog } from "../packages/service/src/commercial-catalog.ts";
import { PostgresCommercialRepository } from "../packages/service/src/commercial-repository.ts";
import { readConfig } from "../packages/service/src/config.ts";
import type { OwnershipRequest, OwnershipVerification, OwnershipVerifier } from "../packages/service/src/ownership.ts";
import { migrate } from "../packages/service/src/postgres.ts";
import { PostgresDdiRepository } from "../packages/service/src/postgres-repository.ts";

const databaseUrl = process.env.DDI_TEST_DATABASE_URL ?? "";
const schema = "ddi_commercial";
const local = (url: string) => ["127.0.0.1", "localhost", "::1"].includes(new URL(url).hostname);
const PEPPER = "d3b-test-pepper-0123456789abcdefghijklmnop";
const DISTRIBUTOR_SECRET = "d3b-test-distributor-secret-0123456789abcdef";
const START = Date.parse("2026-10-15T10:00:00.000Z");
const catalog = parseCatalog({
  version: "test-2026-10-15",
  products: [
    { id: "mybrandos", displayName: "MyBrandOS", plans: [{ id: "creator-term", edition: "creator", licenseType: "TERM", termDays: 30, renewable: true, requiresProperty: true, propertyTypes: ["PERSONAL_BRAND", "BUSINESS"], downloads: ["mybrandos-desktop"] }] },
    { id: "toolkit", displayName: "Toolkit", plans: [{ id: "perpetual", edition: "standard", licenseType: "PERPETUAL", renewable: false, requiresProperty: false, propertyTypes: [], downloads: ["toolkit-cli"] }] },
  ],
});

/** Stands in for the Portal's authoritative PortalInstall lookup. */
class FakePortal implements OwnershipVerifier {
  installs = new Map<string, { subject: string; state: "ready" | "pending" | "failed" }>();
  down = false;
  calls: OwnershipRequest[] = [];
  install(reference: string, subject: string, state: "ready" | "pending" | "failed" = "ready") { this.installs.set(`portal-install:${reference}`, { subject, state }); }
  async verify(input: OwnershipRequest): Promise<OwnershipVerification> {
    this.calls.push(input);
    if (this.down) throw new Error("OWNERSHIP_VERIFICATION_UNAVAILABLE");
    const install = this.installs.get(input.externalReference);
    if (!install || install.subject !== input.trustIdSubject) throw new Error("OWNERSHIP_NOT_VERIFIED");
    if (install.state === "failed") throw new Error("OWNERSHIP_VERIFICATION_PENDING");
    const readiness = install.state === "ready" ? "READY" as const : "PENDING" as const;
    if (readiness === "PENDING" && input.purpose !== "BOOTSTRAP") throw new Error("OWNERSHIP_VERIFICATION_PENDING");
    return { verified: true, issuer: "fake-portal", evidenceId: `${input.externalReference}:${install.subject}`, verifiedAt: new Date().toISOString(), readiness };
  }
}

/** Idempotent by key, like the contract requires of a real provisioner. */
class FakeProvisioner implements CommercialProvisioner {
  mode: "up" | "down" | "reject" = "up";
  calls: ProvisioningRequest[] = [];
  references = new Map<string, string>();
  async provision(input: ProvisioningRequest) {
    this.calls.push(input);
    if (this.mode === "down") throw new Error("PROVISIONING_UNAVAILABLE");
    if (this.mode === "reject") throw new Error("PROVISIONING_REJECTED");
    const reference = this.references.get(input.idempotencyKey) ?? `prov:${this.references.size + 1}`;
    this.references.set(input.idempotencyKey, reference);
    return { reference };
  }
}

const actor = (ownerId: string, subject = `TD-${ownerId}`): Actor => ({ ownerId: ownerId as Actor["ownerId"], subject, kind: "HUMAN", verified: true });
const brand = (reference: string, type: ConnectedPropertyType = "PERSONAL_BRAND") => ({ type, externalSystem: "lifeos", externalReference: `portal-install:${reference}`, displayName: `Brand ${reference}` });

describe("D3B commercial activation, licensing and property provisioning", { concurrency: 1 }, () => {
  let pool: Pool;
  let ddi: PostgresDdiRepository;
  let repository: PostgresCommercialRepository;
  let portal: FakePortal;
  let provisioner: FakeProvisioner;
  let service: CommercialService;
  let now = START;
  const clock = () => new Date(now);
  const admin = actor("own_d3b_admin");
  const issuer = actor("own_d3b_issuer");
  const make = (target = pool) => new CommercialService({ repository: new PostgresCommercialRepository(target), pdi: new PostgresDdiRepository(target), ownership: portal, provisioner, catalog, pepper: PEPPER, clock, downloadTtlSeconds: 120, outbox: { baseDelayMs: 5_000, maxDelayMs: 60_000, leaseMs: 30_000, maxAttempts: 25 } });
  const issue = async (productId = "mybrandos", planId = "creator-term", hours = 24) => {
    const issued = await service.issueCode(issuer, { productId, planId, paymentReference: "manual-bank-transfer-ref", expiresInHours: hours, idempotencyKey: `issue-${Math.random()}` }, "issue");
    assert.ok(issued.code);
    return { code: issued.code, id: issued.activationCode.id };
  };
  const count = async (sql: string, values: unknown[] = []) => Number((await pool.query<{ n: string }>(`SELECT count(*)::text AS n FROM ${sql}`, values)).rows[0]!.n);
  const codeStatus = async (id: string) => (await repository.getCode(id))!.status;
  const events = async (type: string, filter: (event: { redemptionId?: string; licenseId?: string; ownerId?: string }) => boolean = () => true) => (await repository.audits()).filter(event => event.eventType === type && filter(event)).length;

  before(async () => {
    if (!databaseUrl) throw new Error("DDI_TEST_DATABASE_URL_REQUIRED");
    if (!local(databaseUrl)) throw new Error("DDI Postgres tests only run against a local disposable database");
    const bootstrap = new Pool({ connectionString: databaseUrl, max: 1 });
    await bootstrap.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await bootstrap.query(`CREATE SCHEMA ${schema}`);
    await bootstrap.end();
    pool = new Pool({ connectionString: databaseUrl, max: 16, options: `-c search_path=${schema}` });
    for (const migration of ["001_ddi_foundation.sql", "002_ddi_runtime.sql", "003_pdi_connections.sql", "004_connected_properties.sql", "005_commercial_activation.sql", "006_commercial_recovery.sql"]) await migrate(pool, join("migrations", migration));
    // Migrations are re-runnable without error.
    await migrate(pool, join("migrations", "005_commercial_activation.sql"));
    ddi = new PostgresDdiRepository(pool);
    repository = new PostgresCommercialRepository(pool);
    portal = new FakePortal();
    provisioner = new FakeProvisioner();
    service = make();
    await repository.setOperator(admin.ownerId, "COMMERCIAL_ADMIN", "test-bootstrap", new Date(START));
    await repository.setOperator(issuer.ownerId, "COMMERCIAL_ISSUER", "test-bootstrap", new Date(START));
  });
  after(async () => { await pool?.end(); });

  test("issuance: operator-only, idempotent, unpredictable, and never stored in plaintext", async () => {
    await assert.rejects(service.issueCode(actor("own_d3b_nobody"), { productId: "toolkit", planId: "perpetual", paymentReference: "p", expiresInHours: 1, idempotencyKey: "k" }, "c"), /OPERATOR_REQUIRED/);
    await assert.rejects(service.issueCode(null, { productId: "toolkit", planId: "perpetual", paymentReference: "p", expiresInHours: 1, idempotencyKey: "k" }, "c"), /OWNER_REQUIRED/);
    await assert.rejects(service.issueCode(issuer, { productId: "toolkit", planId: "gold-unlimited", paymentReference: "p", expiresInHours: 1, idempotencyKey: "k" }, "c"), /PLAN_NOT_FOUND/);
    await assert.rejects(service.issueCode(issuer, { productId: "toolkit", planId: "perpetual", paymentReference: "p", expiresInHours: 0, idempotencyKey: "k" }, "c"), /INVALID_REQUEST/);
    const first = await service.issueCode(issuer, { productId: "toolkit", planId: "perpetual", paymentReference: "invoice-0001", expiresInHours: 48, idempotencyKey: "issue-idem" }, "c");
    const replay = await service.issueCode(issuer, { productId: "toolkit", planId: "perpetual", paymentReference: "invoice-0001", expiresInHours: 48, idempotencyKey: "issue-idem" }, "c");
    assert.match(first.code!, /^DDI(-[0-9A-HJKMNP-TV-Z]{4}){8}$/);
    assert.equal(replay.created, false);
    assert.equal(replay.code, undefined);
    assert.equal(replay.activationCode.id, first.activationCode.id);
    await assert.rejects(service.issueCode(issuer, { productId: "toolkit", planId: "perpetual", paymentReference: "invoice-9999", expiresInHours: 48, idempotencyKey: "issue-idem" }, "c"), /IDEMPOTENCY_CONFLICT/);
    const parsed = parseActivationCode(first.code)!;
    const stored = (await pool.query<{ row: string }>(`SELECT row_to_json(c)::text AS row FROM ddi_activation_codes c WHERE id = $1`, [first.activationCode.id])).rows[0]!.row;
    assert.equal(stored.includes(parsed.secret), false);
    assert.equal(stored.includes(first.code!), false);
    const many = await Promise.all(Array.from({ length: 20 }, (_, index) => service.issueCode(issuer, { productId: "toolkit", planId: "perpetual", paymentReference: `batch-${index}`, expiresInHours: 1, idempotencyKey: `batch-${index}` }, "c")));
    assert.equal(new Set(many.map(item => item.code)).size, 20);
    assert.equal(await events("ACTIVATION_CODE_ISSUED") >= 21, true);
  });

  test("1 + 9: valid redemption reuses the existing Personal PDI and activates an entitled property", async () => {
    const owner = actor("own_d3b_valid");
    const existing = await ddi.provision(owner.ownerId, { type: "PERSONAL", idempotencyKey: "d3b-valid-pdi" });
    portal.install("valid-brand", owner.subject!);
    const { code, id } = await issue();
    const { redemption, replayed } = await service.redeem(owner, { code: code.toLowerCase().replace(/-/g, " "), idempotencyKey: "valid-1", property: brand("valid-brand") }, "valid");
    assert.equal(replayed, false);
    assert.equal(redemption.status, "COMPLETED");
    assert.equal(redemption.infrastructureId, existing.id);
    assert.equal(await codeStatus(id), "REDEEMED");
    const license = await repository.getLicense(redemption.licenseId);
    const entitlement = await repository.getEntitlement(redemption.entitlementId);
    assert.equal(license?.status, "ACTIVE");
    assert.equal(entitlement?.status, "ACTIVE");
    assert.equal(license?.propertyId, redemption.propertyId);
    assert.equal(license?.expiresAt, new Date(START + 30 * 86_400_000).toISOString());
    assert.equal((await ddi.getProperty(redemption.propertyId!))?.status, "ACTIVE");
    assert.equal((await ddi.getProperty(redemption.propertyId!))?.infrastructureId, existing.id);
    assert.equal((await service.verifyLicense(redemption.licenseId, { ownerId: owner.ownerId, productId: "mybrandos" })).valid, true);
    assert.equal(await count(`ddi_infrastructures WHERE owner_id = $1 AND type = 'PERSONAL'`, [owner.ownerId]), 1);
    for (const event of ["REDEMPTION_ATTEMPTED", "REDEMPTION_SUCCEEDED", "ENTITLEMENT_CREATED", "LICENSE_ISSUED", "PROVISIONING_REQUESTED", "PROVISIONING_SUCCEEDED", "PROPERTY_ACTIVATED"]) {
      assert.equal(await events(event, item => item.ownerId === owner.ownerId) >= 1, true, event);
    }
    // Neither the code, its secret, nor the hash leaks into audits, outbox, or redemption records.
    const parsed = parseActivationCode(code)!;
    const hash = (await pool.query<{ secret_hash: string }>(`SELECT secret_hash FROM ddi_activation_codes WHERE id = $1`, [id])).rows[0]!.secret_hash;
    for (const table of ["ddi_commercial_audits", "ddi_commercial_outbox", "ddi_activation_redemptions", "ddi_entitlements", "ddi_licenses", "ddi_connection_audits"]) {
      const dump = (await pool.query<{ row: string }>(`SELECT row_to_json(t)::text AS row FROM ${table} t`)).rows.map(row => row.row).join("\n");
      for (const secret of [code, parsed.secret, hash]) assert.equal(dump.includes(secret), false, `${table} leaks a secret`);
    }
    const payload = (await pool.query<{ payload: Record<string, unknown> }>(`SELECT payload FROM ddi_commercial_outbox WHERE aggregate_id = $1`, [redemption.id])).rows[0]!.payload;
    assert.deepEqual(Object.keys(payload), ["redemptionId"]);
  });

  test("2: invalid activation codes fail closed, never reach the Portal, and are rate limited", async () => {
    const owner = actor("own_d3b_invalid");
    portal.install("invalid-brand", owner.subject!);
    const { code, id } = await issue();
    const wrongSecret = `${code.slice(0, -1)}${code.endsWith("0") ? "1" : "0"}`;
    const before = portal.calls.length;
    for (const candidate of ["", "hello", 12345, null, "DDI-0000", `DDI-${"Z".repeat(32)}`, wrongSecret, `${code}0`, `XYZ${code.slice(3)}`]) {
      await assert.rejects(service.redeem(owner, { code: candidate, idempotencyKey: `invalid-${String(candidate)}`, property: brand("invalid-brand") }, "invalid"), /ACTIVATION_CODE_INVALID/);
    }
    assert.equal(portal.calls.length, before);
    assert.equal(await codeStatus(id), "ISSUED");
    assert.equal(await count(`ddi_entitlements WHERE owner_id = $1`, [owner.ownerId]), 0);
    await assert.rejects(service.redeem(owner, { code: wrongSecret, idempotencyKey: "invalid-10" }, "invalid"), /ACTIVATION_CODE_INVALID/);
    // Ten guesses inside fifteen minutes lock the owner out, even for a correct code.
    await assert.rejects(service.redeem(owner, { code, idempotencyKey: "invalid-valid", property: brand("invalid-brand") }, "invalid"), /ACTIVATION_RATE_LIMITED/);
    assert.equal(await codeStatus(id), "ISSUED");
    now = START + 16 * 60_000;
    try {
      const { redemption } = await service.redeem(owner, { code, idempotencyKey: "invalid-valid", property: brand("invalid-brand") }, "invalid");
      assert.equal(redemption.status, "COMPLETED");
    } finally { now = START; }
    assert.equal(await events("REDEMPTION_FAILED", item => item.ownerId === owner.ownerId) >= 11, true);
  });

  test("3: an expired activation code fails closed and is not consumed", async () => {
    const owner = actor("own_d3b_expired");
    portal.install("expired-brand", owner.subject!);
    const { code, id } = await issue("mybrandos", "creator-term", 1);
    now = START + 2 * 3_600_000;
    try {
      await assert.rejects(service.redeem(owner, { code, idempotencyKey: "expired-1", property: brand("expired-brand") }, "expired"), /ACTIVATION_CODE_EXPIRED/);
    } finally { now = START; }
    assert.equal(await codeStatus(id), "ISSUED");
    assert.equal(await count(`ddi_entitlements WHERE source_code_id = $1`, [id]), 0);
    const revoked = await issue("toolkit", "perpetual");
    await assert.rejects(service.revokeCode(issuer, revoked.id, "r"), /OPERATOR_REQUIRED/);
    await service.revokeCode(admin, revoked.id, "r");
    await assert.rejects(service.redeem(owner, { code: revoked.code, idempotencyKey: "expired-2" }, "revoked"), /ACTIVATION_CODE_REVOKED/);
  });

  test("4: a redeemed code is never accepted twice; only the identical request replays", async () => {
    const owner = actor("own_d3b_once");
    const other = actor("own_d3b_once_other");
    const { code, id } = await issue("toolkit", "perpetual");
    const first = await service.redeem(owner, { code, idempotencyKey: "once-1" }, "once");
    await assert.rejects(service.redeem(other, { code, idempotencyKey: "once-1" }, "once"), /ACTIVATION_CODE_ALREADY_REDEEMED/);
    await assert.rejects(service.redeem(owner, { code, idempotencyKey: "once-2" }, "once"), /ACTIVATION_CODE_ALREADY_REDEEMED/);
    const replay = await service.redeem(owner, { code, idempotencyKey: "once-1" }, "once");
    assert.equal(replay.replayed, true);
    assert.equal(replay.redemption.id, first.redemption.id);
    const different = await issue("toolkit", "perpetual");
    await assert.rejects(service.redeem(owner, { code: different.code, idempotencyKey: "once-1" }, "once"), /IDEMPOTENCY_CONFLICT/);
    assert.equal(await codeStatus(different.id), "ISSUED");
    assert.equal(await count(`ddi_entitlements WHERE source_code_id = $1`, [id]), 1);
    assert.equal(await count(`ddi_licenses l JOIN ddi_entitlements e ON e.id = l.entitlement_id WHERE e.source_code_id = $1`, [id]), 1);
  });

  test("5: concurrent redemption of one code is atomic", async () => {
    const { code, id } = await issue("toolkit", "perpetual");
    const owners = Array.from({ length: 12 }, (_, index) => actor(`own_d3b_race_${index}`));
    const results = await Promise.allSettled(owners.map((owner, index) => service.redeem(owner, { code, idempotencyKey: `race-${index}` }, "race")));
    const won = results.filter(result => result.status === "fulfilled");
    assert.equal(won.length, 1);
    for (const result of results) if (result.status === "rejected") assert.match(String(result.reason), /ACTIVATION_CODE_ALREADY_REDEEMED/);
    assert.equal(await count(`ddi_entitlements WHERE source_code_id = $1`, [id]), 1);
    assert.equal(await count(`ddi_activation_redemptions WHERE code_id = $1`, [id]), 1);
    // Identical concurrent retries from one owner converge on one redemption.
    const same = actor("own_d3b_race_same");
    portal.install("race-brand", same.subject!);
    const second = await issue();
    const retries = await Promise.all(Array.from({ length: 6 }, () => service.redeem(same, { code: second.code, idempotencyKey: "same-key", property: brand("race-brand") }, "race")));
    assert.equal(new Set(retries.map(item => item.redemption.id)).size, 1);
    assert.equal(await count(`ddi_connected_properties WHERE external_reference = 'portal-install:race-brand'`), 1);
  });

  test("6: redemption requires an authenticated owner; a code never authenticates", async () => {
    const { code, id } = await issue("toolkit", "perpetual");
    await assert.rejects(service.redeem(null, { code, idempotencyKey: "anon" }, "anon"), /OWNER_REQUIRED/);
    await assert.rejects(service.redeem({ ...actor("own_d3b_unverified"), verified: false }, { code, idempotencyKey: "anon" }, "anon"), /OWNER_REQUIRED/);
    const sessions = new Map<string, Actor>([["session-api", actor("own_d3b_api")], ["session-nobody", actor("own_d3b_api_nobody")], ["session-admin", issuer]]);
    const api = buildApi({
      service: { async authenticate(token: string) { return sessions.get(token) ?? null; }, async authenticateApplication() { return null; }, async getInfrastructure(infrastructureId: string) { return ddi.getInfrastructure(infrastructureId); } } as unknown as DdiApiService,
      config: { ...readConfig({ DDI_ENV: "test" }), downloadDistributorSecret: DISTRIBUTOR_SECRET },
      commercial: service,
    });
    try {
      const anonymous = await api.inject({ method: "POST", url: "/me/activations/redeem", headers: { "idempotency-key": "api-1" }, payload: { code } });
      assert.equal(anonymous.statusCode, 401);
      const forgedRole = await api.inject({ method: "POST", url: "/admin/commercial/activation-codes", headers: { authorization: "Bearer session-nobody", "x-ddi-role": "COMMERCIAL_ADMIN", "x-admin": "true", "idempotency-key": "api-issue" }, payload: { productId: "toolkit", planId: "perpetual", paymentReference: "p", expiresInHours: 1 } });
      assert.equal(forgedRole.statusCode, 403);
      assert.equal(forgedRole.json().code, "OPERATOR_REQUIRED");
      assert.equal(await codeStatus(id), "ISSUED");
      const issued = await api.inject({ method: "POST", url: "/admin/commercial/activation-codes", headers: { authorization: "Bearer session-admin", "idempotency-key": "api-issue" }, payload: { productId: "toolkit", planId: "perpetual", paymentReference: "api-invoice", expiresInHours: 1 } });
      assert.equal(issued.statusCode, 201);
      assert.equal(issued.headers["cache-control"], "no-store");
      const replayIssue = await api.inject({ method: "POST", url: "/admin/commercial/activation-codes", headers: { authorization: "Bearer session-admin", "idempotency-key": "api-issue" }, payload: { productId: "toolkit", planId: "perpetual", paymentReference: "api-invoice", expiresInHours: 1 } });
      assert.equal(replayIssue.statusCode, 200);
      assert.equal(replayIssue.json().code, undefined);
      // A client-supplied owner id is ignored; the session decides the owner.
      const redeemed = await api.inject({ method: "POST", url: "/me/activations/redeem", headers: { authorization: "Bearer session-api", "idempotency-key": "api-1" }, payload: { code: issued.json().code, ownerId: "own_d3b_victim" } });
      assert.equal(redeemed.statusCode, 200, redeemed.body);
      assert.equal(redeemed.json().redemption.ownerId, "own_d3b_api");
      const licenseId = redeemed.json().redemption.licenseId;
      const download = await api.inject({ method: "POST", url: `/me/licenses/${licenseId}/downloads`, headers: { authorization: "Bearer session-api" }, payload: { artifactId: "toolkit-cli" } });
      assert.equal(download.statusCode, 200);
      const crossOwner = await api.inject({ method: "POST", url: `/me/licenses/${licenseId}/downloads`, headers: { authorization: "Bearer session-nobody" }, payload: { artifactId: "toolkit-cli" } });
      assert.equal(crossOwner.statusCode, 404);
      const unauthenticatedDistributor = await api.inject({ method: "POST", url: "/internal/downloads/redeem", headers: { "x-ddi-distributor-secret": "guess" }, payload: { token: download.json().token, artifactId: "toolkit-cli" } });
      assert.equal(unauthenticatedDistributor.statusCode, 403);
      const delivered = await api.inject({ method: "POST", url: "/internal/downloads/redeem", headers: { "x-ddi-distributor-secret": DISTRIBUTOR_SECRET }, payload: { token: download.json().token, artifactId: "toolkit-cli" } });
      assert.equal(delivered.statusCode, 200);
      assert.equal(delivered.json().ownerId, "own_d3b_api");
      const reused = await api.inject({ method: "POST", url: "/internal/downloads/redeem", headers: { "x-ddi-distributor-secret": DISTRIBUTOR_SECRET }, payload: { token: download.json().token, artifactId: "toolkit-cli" } });
      assert.equal(reused.statusCode, 403);
      assert.equal(reused.json().code, "DOWNLOAD_GRANT_CONSUMED");
    } finally { await api.close(); }
  });

  test("7: forged property ownership is rejected before the code is consumed", async () => {
    const owner = actor("own_d3b_forger");
    portal.install("victim-brand", "TD-own_d3b_victim");
    const { code, id } = await issue();
    await assert.rejects(service.redeem(owner, { code, idempotencyKey: "forge-1", property: brand("victim-brand") }, "forge"), /OWNERSHIP_NOT_VERIFIED/);
    await assert.rejects(service.redeem({ ...owner, subject: undefined }, { code, idempotencyKey: "forge-2", property: brand("victim-brand") }, "forge"), /TRUSTID_SUBJECT_REQUIRED/);
    await assert.rejects(service.redeem(owner, { code, idempotencyKey: "forge-3", property: { ...brand("victim-brand"), type: "SPACE" } }, "forge"), /PROPERTY_TYPE_NOT_ENTITLED/);
    await assert.rejects(service.redeem(owner, { code, idempotencyKey: "forge-4" }, "forge"), /PROPERTY_REQUIRED/);
    assert.equal(await codeStatus(id), "ISSUED");
    assert.equal(await count(`ddi_connected_properties WHERE external_reference = 'portal-install:victim-brand'`), 0);
  });

  test("8: a product purchase cannot activate another owner's connected property", async () => {
    const victim = actor("own_d3b_cross_victim");
    const attacker = actor("own_d3b_cross_attacker");
    portal.install("cross-brand", victim.subject!);
    const owned = await service.redeem(victim, { code: (await issue()).code, idempotencyKey: "cross-victim", property: brand("cross-brand") }, "cross");
    // Even if the Portal record were stale or reassigned, DDI keeps the existing owner binding.
    portal.install("cross-brand", attacker.subject!);
    const { code, id } = await issue();
    await assert.rejects(service.redeem(attacker, { code, idempotencyKey: "cross-attacker", property: brand("cross-brand") }, "cross"), /PROPERTY_REFERENCE_CONFLICT/);
    assert.equal(await codeStatus(id), "ISSUED");
    const property = await ddi.getProperty(owned.redemption.propertyId!);
    assert.equal(property?.ownerId, victim.ownerId);
    assert.equal(await count(`ddi_licenses WHERE property_id = $1`, [owned.redemption.propertyId]), 1);
  });

  test("9 + 10: many activations keep one Personal PDI, including concurrent first activations", async () => {
    const owner = actor("own_d3b_many");
    for (const reference of ["many-brand", "many-business"]) portal.install(reference, owner.subject!);
    const brandResult = await service.redeem(owner, { code: (await issue()).code, idempotencyKey: "many-1", property: brand("many-brand") }, "many");
    const businessResult = await service.redeem(owner, { code: (await issue()).code, idempotencyKey: "many-2", property: brand("many-business", "BUSINESS") }, "many");
    const toolkit = await service.redeem(owner, { code: (await issue("toolkit", "perpetual")).code, idempotencyKey: "many-3" }, "many");
    assert.equal(new Set([brandResult, businessResult, toolkit].map(item => item.redemption.infrastructureId)).size, 1);
    assert.notEqual(brandResult.redemption.propertyId, businessResult.redemption.propertyId);
    assert.equal(await count(`ddi_infrastructures WHERE owner_id = $1`, [owner.ownerId]), 1);
    const fresh = actor("own_d3b_fresh");
    const references = ["fresh-a", "fresh-b", "fresh-c", "fresh-d"];
    for (const reference of references) portal.install(reference, fresh.subject!);
    const codes = await Promise.all(references.map(() => issue()));
    const concurrent = await Promise.all(references.map((reference, index) => service.redeem(fresh, { code: codes[index]!.code, idempotencyKey: `fresh-${index}`, property: brand(reference) }, "fresh")));
    assert.equal(new Set(concurrent.map(item => item.redemption.infrastructureId)).size, 1);
    assert.equal(await count(`ddi_infrastructures WHERE owner_id = $1`, [fresh.ownerId]), 1);
    assert.equal(await count(`ddi_connected_properties WHERE owner_id = $1`, [fresh.ownerId]), 4);
    // A pre-claimed, client-chosen idempotency key cannot block another owner's activation.
    const target = actor("own_d3b_dos_target");
    await ddi.provision(actor("own_d3b_dos_attacker").ownerId, { type: "PERSONAL", idempotencyKey: `commercial-pdi:${target.ownerId}` });
    const unblocked = await service.redeem(target, { code: (await issue("toolkit", "perpetual")).code, idempotencyKey: "dos" }, "dos");
    assert.equal(unblocked.redemption.status, "COMPLETED");
    assert.equal(await count(`ddi_infrastructures WHERE owner_id = $1`, [target.ownerId]), 1);
  });

  test("11: an elapsed license term expires and fails closed", async () => {
    const owner = actor("own_d3b_expiry");
    portal.install("expiry-brand", owner.subject!);
    const { redemption } = await service.redeem(owner, { code: (await issue()).code, idempotencyKey: "expiry", property: brand("expiry-brand") }, "expiry");
    now = START + 31 * 86_400_000;
    try {
      assert.deepEqual(await service.verifyLicense(redemption.licenseId), { valid: false, reason: "LICENSE_EXPIRED" });
      assert.equal((await repository.getLicense(redemption.licenseId))?.status, "EXPIRED");
      assert.equal((await repository.getEntitlement(redemption.entitlementId))?.status, "EXPIRED");
      await assert.rejects(service.authorizeDownload(owner, redemption.licenseId, "mybrandos-desktop", "expiry"), /LICENSE_EXPIRED/);
      await assert.rejects(service.changeLicense(admin, redemption.licenseId, "REINSTATE", "retry", "expiry"), /LICENSE_NOT_MODIFIABLE/);
      assert.equal(await events("LICENSE_EXPIRED", item => item.licenseId === redemption.licenseId), 1);
    } finally { now = START; }
    const perpetual = await service.redeem(owner, { code: (await issue("toolkit", "perpetual")).code, idempotencyKey: "expiry-perpetual" }, "expiry");
    now = START + 3650 * 86_400_000;
    try { assert.equal((await service.verifyLicense(perpetual.redemption.licenseId)).valid, true); }
    finally { now = START; }
  });

  test("12: suspension and revocation are operator-only and fail closed", async () => {
    const owner = actor("own_d3b_lifecycle");
    const { redemption } = await service.redeem(owner, { code: (await issue("toolkit", "perpetual")).code, idempotencyKey: "lifecycle" }, "lifecycle");
    await assert.rejects(service.changeLicense(owner, redemption.licenseId, "SUSPEND", "self", "c"), /OPERATOR_REQUIRED/);
    await assert.rejects(service.changeLicense(issuer, redemption.licenseId, "SUSPEND", "issuer", "c"), /OPERATOR_REQUIRED/);
    await service.changeLicense(admin, redemption.licenseId, "SUSPEND", "chargeback-review", "c");
    assert.deepEqual(await service.verifyLicense(redemption.licenseId), { valid: false, reason: "LICENSE_SUSPENDED" });
    await assert.rejects(service.authorizeDownload(owner, redemption.licenseId, "toolkit-cli", "c"), /LICENSE_SUSPENDED/);
    await service.changeLicense(admin, redemption.licenseId, "REINSTATE", "cleared", "c");
    assert.equal((await service.verifyLicense(redemption.licenseId)).valid, true);
    await service.changeEntitlement(admin, redemption.entitlementId, "SUSPEND", "entitlement-review", "c");
    assert.equal((await repository.getLicense(redemption.licenseId))?.status, "SUSPENDED");
    await service.changeEntitlement(admin, redemption.entitlementId, "REINSTATE", "cleared", "c");
    assert.equal((await service.verifyLicense(redemption.licenseId)).valid, true);
    await service.changeLicense(admin, redemption.licenseId, "REVOKE", "refund", "c");
    assert.deepEqual(await service.verifyLicense(redemption.licenseId), { valid: false, reason: "LICENSE_REVOKED" });
    await assert.rejects(service.changeLicense(admin, redemption.licenseId, "REINSTATE", "undo", "c"), /LICENSE_NOT_MODIFIABLE/);
    for (const event of ["LICENSE_SUSPENDED", "LICENSE_REINSTATED", "LICENSE_REVOKED", "ENTITLEMENT_SUSPENDED", "ENTITLEMENT_REINSTATED"]) assert.equal(await events(event, item => item.ownerId === owner.ownerId) >= 1, true, event);
    // A revoked operator binding stops working immediately.
    const former = actor("own_d3b_former_operator");
    await repository.setOperator(former.ownerId, "COMMERCIAL_ADMIN", "test", new Date(START));
    await repository.setOperator(former.ownerId, null, "test", new Date(START));
    await assert.rejects(service.issueCode(former, { productId: "toolkit", planId: "perpetual", paymentReference: "p", expiresInHours: 1, idempotencyKey: "former" }, "c"), /OPERATOR_REQUIRED/);
  });

  test("13 + 14: downloads need a valid owned license, the entitled artifact, and a single-use scoped grant", async () => {
    const owner = actor("own_d3b_download");
    const stranger = actor("own_d3b_download_stranger");
    portal.install("download-brand", owner.subject!);
    const { redemption } = await service.redeem(owner, { code: (await issue()).code, idempotencyKey: "download", property: brand("download-brand") }, "download");
    await assert.rejects(service.authorizeDownload(null, redemption.licenseId, "mybrandos-desktop", "d"), /OWNER_REQUIRED/);
    await assert.rejects(service.authorizeDownload(owner, redemption.licenseId, "toolkit-cli", "d"), /DOWNLOAD_NOT_ENTITLED/);
    await assert.rejects(service.authorizeDownload(owner, redemption.licenseId, "../../etc/passwd", "d"), /INVALID_REQUEST/);
    await assert.rejects(service.authorizeDownload(owner, "license:00000000-0000-0000-0000-000000000000", "mybrandos-desktop", "d"), /LICENSE_NOT_FOUND/);
    await assert.rejects(service.authorizeDownload(stranger, redemption.licenseId, "mybrandos-desktop", "d"), /LICENSE_NOT_FOUND/);
    const grant = await service.authorizeDownload(owner, redemption.licenseId, "mybrandos-desktop", "d");
    assert.equal(Date.parse(grant.expiresAt) - START, 120_000);
    assert.equal(JSON.stringify(grant).includes("http"), false);
    await assert.rejects(service.redeemDownload(grant.token, { artifactId: "toolkit-cli" }, "d"), /DOWNLOAD_SCOPE_MISMATCH/);
    await assert.rejects(service.redeemDownload(grant.token, { artifactId: "mybrandos-desktop", productId: "toolkit" }, "d"), /DOWNLOAD_SCOPE_MISMATCH/);
    await assert.rejects(service.redeemDownload(`ddidl_${"A".repeat(43)}`, { artifactId: "mybrandos-desktop" }, "d"), /DOWNLOAD_GRANT_INVALID/);
    const delivered = await service.redeemDownload(grant.token, { artifactId: "mybrandos-desktop", productId: "mybrandos" }, "d");
    assert.equal(delivered.ownerId, owner.ownerId);
    await assert.rejects(service.redeemDownload(grant.token, { artifactId: "mybrandos-desktop" }, "d"), /DOWNLOAD_GRANT_CONSUMED/);
    const late = await service.authorizeDownload(owner, redemption.licenseId, "mybrandos-desktop", "d");
    now = START + 121_000;
    try { await assert.rejects(service.redeemDownload(late.token, { artifactId: "mybrandos-desktop" }, "d"), /DOWNLOAD_GRANT_EXPIRED/); }
    finally { now = START; }
    // Revoking the property after issuance denies the outstanding grant.
    const pending = await service.authorizeDownload(owner, redemption.licenseId, "mybrandos-desktop", "d");
    await ddi.revokeProperty(owner.ownerId, redemption.propertyId!, "download-revoke");
    await assert.rejects(service.redeemDownload(pending.token, { artifactId: "mybrandos-desktop" }, "d"), /PROPERTY_NOT_ACTIVE/);
    const second = await service.redeem(owner, { code: (await issue("toolkit", "perpetual")).code, idempotencyKey: "download-2" }, "download");
    const revokedLater = await service.authorizeDownload(owner, second.redemption.licenseId, "toolkit-cli", "d");
    await service.changeLicense(admin, second.redemption.licenseId, "REVOKE", "refund", "d");
    await assert.rejects(service.redeemDownload(revokedLater.token, { artifactId: "toolkit-cli" }, "d"), /LICENSE_REVOKED/);
    assert.equal(await events("DOWNLOAD_DENIED", item => item.ownerId === stranger.ownerId) >= 1, true);
    const grants = (await pool.query<{ row: string }>(`SELECT row_to_json(g)::text AS row FROM ddi_download_grants g`)).rows.map(row => row.row).join("\n");
    for (const token of [grant.token, late.token, pending.token]) assert.equal(grants.includes(token), false);
  });

  test("15: provisioning-service failure leaves a durable, truthful pending state", async () => {
    const owner = actor("own_d3b_provfail");
    portal.install("provfail-brand", owner.subject!);
    provisioner.mode = "down";
    try {
      const { redemption } = await service.redeem(owner, { code: (await issue()).code, idempotencyKey: "provfail", property: brand("provfail-brand") }, "provfail");
      assert.equal(redemption.status, "PROVISIONING_PENDING");
      assert.equal(redemption.lastError, "PROVISIONING_UNAVAILABLE");
      assert.equal(redemption.provisionedAt, undefined);
      // Activation is independent of the external provisioning step.
      assert.equal((await ddi.getProperty(redemption.propertyId!))?.status, "ACTIVE");
      const [job] = await repository.outboxFor(redemption.id);
      assert.equal(job?.status, "PENDING");
      assert.equal(job?.lastError, "PROVISIONING_UNAVAILABLE");
      assert.equal(await events("PROVISIONING_FAILED", item => item.redemptionId === redemption.id), 1);
      provisioner.mode = "reject";
      const rejected = await service.redeem(owner, { code: (await issue("toolkit", "perpetual")).code, idempotencyKey: "provfail-reject" }, "provfail");
      assert.equal(rejected.redemption.status, "ATTENTION_REQUIRED");
      assert.equal((await repository.outboxFor(rejected.redemption.id))[0]?.status, "DEAD");
    } finally { provisioner.mode = "up"; }
  });

  test("16: a retry after partial failure completes once without duplicating records", async () => {
    const owner = actor("own_d3b_retry");
    portal.install("retry-brand", owner.subject!);
    provisioner.mode = "down";
    const { redemption } = await service.redeem(owner, { code: (await issue()).code, idempotencyKey: "retry", property: brand("retry-brand") }, "retry");
    provisioner.mode = "up";
    assert.equal((await service.runOutbox({ aggregateId: redemption.id })).processed, 0, "backoff must be honoured");
    now = START + 10 * 60_000;
    try { assert.equal((await service.runOutbox({ aggregateId: redemption.id })).completed, 1); }
    finally { now = START; }
    const done = await repository.getRedemption(redemption.id);
    assert.equal(done?.redemption.status, "COMPLETED");
    assert.equal(done?.redemption.lastError, undefined);
    const keys = provisioner.calls.filter(call => call.redemptionId === redemption.id).map(call => call.idempotencyKey);
    assert.equal(keys.length, 2);
    assert.equal(new Set(keys).size, 1);
    assert.equal(await count(`ddi_entitlements WHERE owner_id = $1`, [owner.ownerId]), 1);
    assert.equal(await events("PROVISIONING_SUCCEEDED", item => item.redemptionId === redemption.id), 1);
  });

  test("17: the outbox recovers a job abandoned by a crashed worker after restart", async () => {
    const owner = actor("own_d3b_restart");
    portal.install("restart-brand", owner.subject!);
    provisioner.mode = "down";
    const { redemption } = await service.redeem(owner, { code: (await issue()).code, idempotencyKey: "restart", property: brand("restart-brand") }, "restart");
    provisioner.mode = "up";
    // A worker claims the due job, then its process dies before settling.
    const crashed = new Pool({ connectionString: databaseUrl, max: 2, options: `-c search_path=${schema}` });
    now = START + 10 * 60_000;
    const claimed = await new PostgresCommercialRepository(crashed).claimOutbox({ now: new Date(now), limit: 10, leaseMs: 30_000, aggregateId: redemption.id });
    assert.equal(claimed.length, 1);
    await crashed.end();
    // A restarted process (fresh pool and service) cannot steal a live lease...
    const restartedPool = new Pool({ connectionString: databaseUrl, max: 4, options: `-c search_path=${schema}` });
    try {
      const restarted = make(restartedPool);
      assert.equal((await restarted.runOutbox({ aggregateId: redemption.id })).processed, 0);
      // ...but recovers the job once the lease expires.
      now += 31_000;
      assert.equal((await restarted.runOutbox({ aggregateId: redemption.id })).completed, 1);
      assert.equal((await repository.getRedemption(redemption.id))?.redemption.status, "COMPLETED");
      // The crashed worker's stale lease can no longer settle anything.
      assert.equal(await repository.settleOutbox(claimed[0]!, { status: "DEAD", at: new Date(now), error: "STALE" }), false);
      assert.equal((await repository.outboxFor(redemption.id))[0]?.status, "DONE");
    } finally { now = START; await restartedPool.end(); }
  });

  test("18: duplicate delivery and concurrent workers stay idempotent", async () => {
    const owner = actor("own_d3b_dupe");
    portal.install("dupe-brand", owner.subject!, "pending");
    const { redemption } = await service.redeem(owner, { code: (await issue()).code, idempotencyKey: "dupe", property: brand("dupe-brand") }, "dupe");
    assert.equal(redemption.status, "PROVISIONING_PENDING");
    portal.install("dupe-brand", owner.subject!, "ready");
    now = START + 10 * 60_000;
    const workers = [make(), make(), make()];
    try {
      const results = await Promise.all(workers.map(worker => worker.runOutbox({ aggregateId: redemption.id })));
      assert.equal(results.reduce((total, item) => total + item.processed, 0), 1, "SKIP LOCKED delivers a due job to one worker");
      // At-least-once redelivery of an already completed job.
      await pool.query(`UPDATE ddi_commercial_outbox SET status = 'PENDING', next_attempt_at = $2 WHERE aggregate_id = $1`, [redemption.id, new Date(now).toISOString()]);
      const callsBefore = provisioner.calls.length;
      assert.equal((await service.runOutbox({ aggregateId: redemption.id })).completed, 1);
      assert.equal(provisioner.calls.length, callsBefore);
    } finally { now = START; }
    assert.equal(await events("PROPERTY_ACTIVATED", item => item.redemptionId === redemption.id), 1);
    assert.equal(await events("PROVISIONING_SUCCEEDED", item => item.redemptionId === redemption.id), 1);
    assert.equal((await service.redeem(owner, { code: "unused", idempotencyKey: "dupe" }, "dupe").catch(error => error)).message, "ACTIVATION_CODE_INVALID");
  });

  test("19: ownership-verification failure never consumes a code or grants a property", async () => {
    const owner = actor("own_d3b_ownfail");
    portal.install("ownfail-brand", owner.subject!, "pending");
    const { code, id } = await issue();
    portal.down = true;
    try { await assert.rejects(service.redeem(owner, { code, idempotencyKey: "ownfail", property: brand("ownfail-brand") }, "ownfail"), /OWNERSHIP_VERIFICATION_UNAVAILABLE/); }
    finally { portal.down = false; }
    assert.equal(await codeStatus(id), "ISSUED");
    assert.equal(await count(`ddi_entitlements WHERE source_code_id = $1`, [id]), 0);
    portal.install("ownfail-failed", owner.subject!, "failed");
    await assert.rejects(service.redeem(owner, { code, idempotencyKey: "ownfail-failed", property: brand("ownfail-failed") }, "ownfail"), /OWNERSHIP_VERIFICATION_PENDING/);
    assert.equal(await codeStatus(id), "ISSUED");
    // Bootstrapped while pending, then the authoritative record moves to someone else.
    const { redemption } = await service.redeem(owner, { code, idempotencyKey: "ownfail-2", property: brand("ownfail-brand") }, "ownfail");
    portal.install("ownfail-brand", "TD-someone-else", "ready");
    now = START + 10 * 60_000;
    try { assert.equal((await service.runOutbox({ aggregateId: redemption.id })).dead, 1); }
    finally { now = START; }
    assert.equal((await ddi.getProperty(redemption.propertyId!))?.status, "FAILED");
    assert.equal((await repository.getLicense(redemption.licenseId))?.status, "SUSPENDED");
    assert.equal((await repository.getRedemption(redemption.id))?.redemption.status, "ATTENTION_REQUIRED");
    await assert.rejects(service.authorizeDownload(owner, redemption.licenseId, "mybrandos-desktop", "ownfail"), /LICENSE_SUSPENDED/);
  });

  test("20: PortalInstall bootstrap: provisioning proceeds, privileges wait for READY", async () => {
    const owner = actor("own_d3b_bootstrap");
    portal.install("bootstrap-brand", owner.subject!, "pending");
    const { redemption } = await service.redeem(owner, { code: (await issue()).code, idempotencyKey: "bootstrap", property: brand("bootstrap-brand") }, "bootstrap");
    // The external provisioning step completes before READY, which breaks the cycle.
    assert.equal(redemption.status, "PROVISIONING_PENDING");
    assert.ok(redemption.provisionedAt);
    assert.equal(redemption.lastError, "OWNERSHIP_VERIFICATION_PENDING");
    assert.equal((await ddi.getProperty(redemption.propertyId!))?.status, "PENDING_ACTIVATION");
    assert.deepEqual(await service.verifyLicense(redemption.licenseId), { valid: false, reason: "PROPERTY_NOT_ACTIVE" });
    await assert.rejects(service.authorizeDownload(owner, redemption.licenseId, "mybrandos-desktop", "bootstrap"), /PROPERTY_NOT_ACTIVE/);
    await assert.rejects(ddi.registerApplication(owner.ownerId, redemption.infrastructureId, { type: "WEB", displayName: "Early app", propertyId: redemption.propertyId, capabilities: ["identity.currentActor"], idempotencyKey: "bootstrap-app-early" }), /PROPERTY_NOT_ACTIVE/);
    portal.install("bootstrap-brand", owner.subject!, "ready");
    now = START + 10 * 60_000;
    try {
      assert.equal((await service.runOutbox({ aggregateId: redemption.id })).completed, 1);
      const done = await repository.getRedemption(redemption.id);
      assert.equal(done?.redemption.status, "COMPLETED");
      assert.ok(done?.redemption.activatedAt);
      assert.equal((await ddi.getProperty(redemption.propertyId!))?.status, "ACTIVE");
      assert.ok((await service.authorizeDownload(owner, redemption.licenseId, "mybrandos-desktop", "bootstrap")).token);
      const app = await ddi.registerApplication(owner.ownerId, redemption.infrastructureId, { type: "WEB", displayName: "Ready app", propertyId: redemption.propertyId, capabilities: ["identity.currentActor"], idempotencyKey: "bootstrap-app-ready" });
      assert.equal(app.propertyId, redemption.propertyId);
    } finally { now = START; }
    assert.equal(provisioner.calls.filter(call => call.redemptionId === redemption.id).length, 1);
    const activations = portal.calls.filter(call => call.externalReference === "portal-install:bootstrap-brand").map(call => call.purpose);
    assert.deepEqual([...new Set(activations)].sort(), ["ACTIVATE", "BOOTSTRAP"]);
  });
});
