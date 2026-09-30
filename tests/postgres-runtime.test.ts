import test, { after, before, describe } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import * as jose from "jose";
import { Pool } from "pg";
import type { Actor } from "../packages/contracts/src/index.ts";
import { mapAuthorityReason } from "../packages/service/src/digi.ts";
import { migrate } from "../packages/service/src/postgres.ts";
import { PostgresDdiRepository } from "../packages/service/src/postgres-repository.ts";
import { DurableDdiService, authorityVerifier, defaultAdapters } from "../packages/service/src/runtime.ts";

const databaseUrl = process.env.DDI_TEST_DATABASE_URL ?? "";
const SCHEMA = "ddi_accept";
const DIGI_SCHEMA = "digi_ddi_owner_proof";
const ISSUER = "https://trustedid.netlify.app/api";
const AUDIENCE = "digiconomy:digi";
const bridgeUrl = pathToFileURL("C:/Users/Hp/Desktop/TRUST ID/packages/digi-bridge/dist/index.js").href;
const authorityUrl = pathToFileURL("C:/Users/Hp/Desktop/TRUST ID/packages/digi-authority/dist/index.js").href;
const verifierUrl = pathToFileURL("C:/Users/Hp/Desktop/TRUST ID/packages/authority-verifier/dist/index.js").href;

function assertLocal(url: string) {
  const host = new URL(url).hostname;
  if (!["127.0.0.1", "localhost", "::1"].includes(host)) throw new Error("DDI Postgres tests only run against a local disposable database");
}

async function count(pool: Pool, table: string) {
  const result = await pool.query<{ n: string }>(`SELECT count(*)::text AS n FROM ${table}`);
  return Number(result.rows[0]?.n ?? 0);
}

describe("DDI postgres runtime", { concurrency: 1 }, () => {
  let pool: Pool;
  let repository: PostgresDdiRepository;
  before(async () => {
    if (!databaseUrl) throw new Error("DDI_TEST_DATABASE_URL_REQUIRED");
    assertLocal(databaseUrl);
    const admin = new Pool({ connectionString: databaseUrl, max: 1, connectionTimeoutMillis: 5000 });
    await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await admin.query(`CREATE SCHEMA ${SCHEMA}`);
    await admin.end();
    pool = new Pool({ connectionString: databaseUrl, max: 12, connectionTimeoutMillis: 5000, options: `-c search_path=${SCHEMA}` });
    await migrate(pool, join("migrations", "001_ddi_foundation.sql"));
    await migrate(pool, join("migrations", "002_ddi_runtime.sql"));
    await migrate(pool, join("migrations", "003_pdi_connections.sql"));
    repository = new PostgresDdiRepository(pool);
  });
  after(async () => { await pool?.end(); });

  test("migration rollback stays on one connection and rejects destructive SQL", async () => {
    const root = await mkdtemp(join(tmpdir(), "ddi-migrate-"));
    const bad = join(root, "bad.sql");
    await writeFile(bad, "CREATE TABLE ddi_tx_probe (id INT);\nSELECT 1/0;\n");
    await assert.rejects(migrate(pool, bad), /division by zero/i);
    const present = await pool.query(`SELECT to_regclass('ddi_tx_probe') AS name`);
    assert.equal(present.rows[0]?.name, null);
    const drop = join(root, "drop.sql");
    await writeFile(drop, "DROP TABLE ddi_infrastructures;\n");
    await assert.rejects(migrate(pool, drop), /DESTRUCTIVE_MIGRATION_REJECTED/);
    assert.equal(await count(pool, "ddi_infrastructures"), 0);
  });

  test("canonical Digi owner, restart, one personal PDI, and creator execution", async () => {
    const bridge = await import(bridgeUrl) as {
      openPostgresDigiCore(url: string, options: { schema: string }): Promise<{ owners: { findByIssuerSubject(issuer: string, subject: string): Promise<{ ownerId: string; subject: string } | null> }; replay: unknown; sessions: { resolve(token: string): Promise<{ id: string; ownerId: string } | null> }; runWrite<T>(fn: () => Promise<T>): Promise<T>; close(): Promise<void> }>;
      exchangeTrustIdAssertion(input: Record<string, unknown>): Promise<{ ok: true; ownerId: string; sessionToken: string; subject: string } | { ok: false; reason: string }>;
      createJwksCache(input: { jwksUrl: string; fetchImpl?: typeof fetch }): unknown;
    };
    const admin = new Pool({ connectionString: databaseUrl, max: 1, connectionTimeoutMillis: 5000 });
    await admin.query(`DROP SCHEMA IF EXISTS ${DIGI_SCHEMA} CASCADE`);
    await admin.end();
    const { privateKey, publicKey } = await jose.generateKeyPair("EdDSA", { extractable: true });
    const publicJwk = await jose.exportJWK(publicKey);
    publicJwk.kid = createHash("sha256").update(JSON.stringify(publicJwk)).digest("hex").slice(0, 16);
    publicJwk.alg = "EdDSA";
    publicJwk.use = "sig";
    const sign = (jti: string) => new jose.SignJWT({}).setProtectedHeader({ alg: "EdDSA", kid: publicJwk.kid, typ: "JWT" }).setIssuer(ISSUER).setAudience(AUDIENCE).setSubject("subject-ddi-proof").setIssuedAt().setExpirationTime("1m").setJti(jti).sign(privateKey);
    const core = await bridge.openPostgresDigiCore(databaseUrl, { schema: DIGI_SCHEMA });
    try {
      const jwks = bridge.createJwksCache({ jwksUrl: "https://jwks.test/jwks.json", fetchImpl: async () => new Response(JSON.stringify({ keys: [publicJwk] }), { status: 200, headers: { "content-type": "application/json" } }) });
      const first = await bridge.exchangeTrustIdAssertion({ assertion: await sign(randomUUID()), expectedIssuer: ISSUER, expectedAudience: AUDIENCE, jwks, owners: core.owners, replay: core.replay, sessions: core.sessions, runWrite: core.runWrite });
      const second = await bridge.exchangeTrustIdAssertion({ assertion: await sign(randomUUID()), expectedIssuer: ISSUER, expectedAudience: AUDIENCE, jwks, owners: core.owners, replay: core.replay, sessions: core.sessions, runWrite: core.runWrite });
      assert.equal(first.ok && second.ok, true);
      if (!first.ok || !second.ok) return;
      assert.equal(second.ownerId, first.ownerId);
      assert.notEqual(first.ownerId, "subject-ddi-proof");
      const session = await core.sessions.resolve(first.sessionToken);
      assert.equal(session?.ownerId, first.ownerId);
      const other = await jose.generateKeyPair("EdDSA", { extractable: true });
      const badJwk = await jose.exportJWK(other.publicKey);
      badJwk.kid = "other";
      badJwk.alg = "EdDSA";
      const bad = await new jose.SignJWT({}).setProtectedHeader({ alg: "EdDSA", kid: "other", typ: "JWT" }).setIssuer(ISSUER).setAudience(AUDIENCE).setSubject("subject-ddi-proof").setIssuedAt().setExpirationTime("1m").setJti(randomUUID()).sign(other.privateKey);
      const rejected = await bridge.exchangeTrustIdAssertion({ assertion: bad, expectedIssuer: ISSUER, expectedAudience: AUDIENCE, jwks, owners: core.owners, replay: core.replay, sessions: core.sessions, runWrite: core.runWrite });
      assert.equal(rejected.ok, false);
      const actor: Actor = { ownerId: first.ownerId as Actor["ownerId"], subject: "subject-ddi-proof", kind: "HUMAN", verified: true, authorityActor: "human:ddi-user" };
      const service = new DurableDdiService(repository, async () => ({ ok: true, grantId: "grant:fixture" }), defaultAdapters(async () => ({ subject: "subject-ddi-proof" })), undefined, { async ensureGrant() { return { grantId: "grant:fixture" }; }, async revokeGrant() { return undefined; } });
      const personalA = await service.provision(actor, { type: "PERSONAL", idempotencyKey: "personal-a" });
      const personalB = await service.provision(actor, { type: "PERSONAL", idempotencyKey: "personal-b" });
      assert.equal(personalB.id, personalA.id);
      const infra = await service.provision(actor, { type: "CREATOR", idempotencyKey: "creator-1" });
      const retried = await service.provision(actor, { type: "CREATOR", idempotencyKey: "creator-1" });
      assert.equal(retried.id, infra.id);
      const app = await service.registerApp(actor, infra.id, { type: "REFERENCE", displayName: "Reference", publicUrl: "https://reference.example.test", capabilities: ["identity.currentActor"], idempotencyKey: "app-1" });
      assert.deepEqual(app.grantedCapabilities, []);
      const granted = await service.grantCapabilities(actor, infra.id, app.id, ["identity.currentActor"]);
      assert.deepEqual(granted.grantedCapabilities, ["identity.currentActor"]);
      await service.bind(actor, infra.id, "identity", "TrustID", "trustid:configured");
      const connection = await service.requestConnection(app.id, ["identity.currentActor"], "request-1", "connection-creator");
      await service.approveConnection(actor, connection.id, ["identity.currentActor"], "approve-1");
      const result = await service.execute({ infrastructureId: infra.id, applicationId: app.id, capability: "identity.currentActor", action: "identity.currentActor", resource: `infrastructure:${infra.id}`, audience: "ddi", actor, authority: { token: "fixture" }, correlationId: "allow-1", executionMode: "SPACE", payload: { assertion: "not-a-token" } });
      assert.equal(result.status, "COMPLETED");
      assert.equal((result.data as { ownerId: string; subject: string }).ownerId, first.ownerId);
      assert.equal((result.data as { subject: string }).subject, "subject-ddi-proof");
      const stored = await pool.query<{ owner_id: string; owner_subject: string }>(`SELECT owner_id, owner_subject FROM ddi_infrastructures WHERE id = $1`, [infra.id]);
      assert.equal(stored.rows[0]?.owner_id, first.ownerId);
      assert.equal(stored.rows[0]?.owner_subject, "");
      const restartedPool = new Pool({ connectionString: databaseUrl, max: 2, connectionTimeoutMillis: 5000, options: `-c search_path=${SCHEMA}` });
      const restarted = new PostgresDdiRepository(restartedPool);
      const snapshot = await restarted.snapshot();
      assert.equal(snapshot.infrastructures.some(item => item.id === infra.id && item.ownerId === first.ownerId), true);
      assert.equal(snapshot.applications.some(item => item.id === app.id && item.grantedCapabilities.includes("identity.currentActor")), true);
      assert.equal(snapshot.bindings.some(item => item.infrastructureId === infra.id && item.provider === "TrustID"), true);
      assert.equal(snapshot.relationships.filter(item => item.from === infra.id || item.to === infra.id).length >= 2, true);
      assert.equal(snapshot.audits.some(item => item.correlationId === "allow-1" && item.decision === "ALLOW" && item.executionMode === "SPACE" && item.ownerId === first.ownerId), true);
      assert.equal(JSON.stringify(snapshot.audits).includes("not-a-token"), false);
      await restartedPool.end();
      const identity = await core.owners.findByIssuerSubject(ISSUER, "subject-ddi-proof");
      assert.equal(identity?.ownerId, first.ownerId);
      assert.equal(identity?.subject, "subject-ddi-proof");
    } finally { await core.close(); }
  });

  test("idempotency and binding concurrency keep one row", async () => {
    const ownerId = "own_concurrent" as Actor["ownerId"];
    const actor: Actor = { ownerId, kind: "HUMAN", verified: true };
    const before = await count(pool, "ddi_infrastructures");
    const results = await Promise.all(Array.from({ length: 8 }, () => repository.provision(ownerId, { type: "CREATOR", idempotencyKey: "concurrent-provision" })));
    assert.equal(new Set(results.map(item => item.id)).size, 1);
    assert.equal(await count(pool, "ddi_infrastructures") - before, 1);
    await assert.rejects(repository.provision("own_other" as Actor["ownerId"], { type: "CREATOR", idempotencyKey: "concurrent-provision" }), /IDEMPOTENCY_OWNER_MISMATCH/);
    const infra = results[0]!;
    const bindings = await Promise.all(Array.from({ length: 6 }, () => repository.bind(ownerId, infra.id, "identity", "TrustID")));
    assert.equal(new Set(bindings.map(item => item.id)).size, 1);
    await assert.rejects(repository.bind(ownerId, infra.id, "identity", "ElfCom"), /PROVIDER_CONFLICT/);
    const bound = await pool.query<{ n: string }>(`SELECT count(*)::text AS n FROM ddi_primitive_bindings WHERE infrastructure_id = $1 AND namespace = 'identity'`, [infra.id]);
    assert.equal(Number(bound.rows[0]?.n), 1);
    const apps = await Promise.all(Array.from({ length: 4 }, () => repository.registerApplication(ownerId, infra.id, { type: "REFERENCE", displayName: "Concurrent", capabilities: ["identity.read"], idempotencyKey: "concurrent-app" })));
    assert.equal(new Set(apps.map(item => item.id)).size, 1);
    assert.deepEqual(apps[0]?.grantedCapabilities, []);
  });

  test("stateful Digi Authority allow, deny, revoke, and one-time consume", async () => {
    const authority = await import(authorityUrl) as {
      MemoryAuthorityStore: new () => { createGrant(input: Record<string, unknown>): Promise<{ id: string }>; isJtiConsumed(jti: string): Promise<boolean> };
      AuthorityService: new (options: Record<string, unknown>) => { issueToken(ownerId: string, grantId: string): Promise<{ ok: true; token: string; jti: string } | { ok: false; reason: string }>; useToken(input: Record<string, string>): Promise<{ ok: boolean; grantId?: string; reason?: string }>; revoke(ownerId: string, grantId: string): Promise<{ ok: boolean }> };
      generateAuthoritySigningKey(): Promise<{ publicJwk: jose.JWK }>;
    };
    const verifier = await import(verifierUrl) as { verifyAuthority(input: Record<string, unknown>): Promise<{ ok: boolean; reason?: string }> };
    const store = new authority.MemoryAuthorityStore();
    const key = await authority.generateAuthoritySigningKey();
    const service = new authority.AuthorityService({ store, signingKey: key, persistence: "memory" });
    const ownerId = "own_authority_proof";
    const actorKey = "human:ddi-user";
    async function grant(oneTime: boolean) {
      const created = await store.createGrant({ id: `auth_${randomUUID()}`, ownerId, actorType: "human", actorId: "ddi-user", audience: "ddi", actions: ["identity.currentActor"], resources: ["infrastructure:owned"], limits: {}, conditions: {}, approvalMode: "ALLOW", consequence: "LOW", oneTime, validFrom: new Date(), validUntil: new Date(Date.now() + 60 * 60 * 1000), status: "ACTIVE" });
      const issued = await service.issueToken(ownerId, created.id);
      assert.equal(issued.ok, true);
      if (!issued.ok) throw new Error("token");
      return { grantId: created.id, token: issued.token, jti: issued.jti };
    }
    const client = { async consume(input: { token: string; audience: string; actor: string; action: string; resource: string; ownerId: string }) {
      const verified = await verifier.verifyAuthority({ ...input, publicJwks: [key.publicJwk] });
      if (!verified.ok) return mapAuthorityReason(verified.reason ?? "INVALID");
      const used = await service.useToken({ token: input.token, expectedAudience: input.audience, expectedActor: input.actor, expectedAction: input.action, expectedResource: input.resource });
      return used.ok && used.grantId ? { ok: true as const, grantId: used.grantId } : mapAuthorityReason(used.reason ?? "INVALID");
    } };
    const durable = new DurableDdiService(repository, authorityVerifier(client), defaultAdapters(async () => ({ subject: "subject-ddi-proof" })), undefined, { async ensureGrant() { return { grantId: "grant:connection" }; }, async revokeGrant() { return undefined; } });
    const actor: Actor = { ownerId: ownerId as Actor["ownerId"], kind: "HUMAN", verified: true, authorityActor: actorKey };
    const infra = await durable.provision(actor, { type: "BUSINESS", idempotencyKey: `authority-${randomUUID()}` });
    const app = await durable.registerApp(actor, infra.id, { type: "REFERENCE", displayName: "Authority", capabilities: ["identity.currentActor"], idempotencyKey: `authority-app-${randomUUID()}` });
    await durable.bind(actor, infra.id, "identity", "TrustID");
    const connection = await durable.requestConnection(app.id, ["identity.currentActor"], "authority-connection", `authority-connection-${randomUUID()}`);
    await durable.approveConnection(actor, connection.id, ["identity.currentActor"], "authority-approve");
    const execute = (token: string, changes: Partial<{ action: string; resource: string; audience: string; actor: string; ownerId: string }> = {}) => durable.execute({ infrastructureId: infra.id, applicationId: app.id, capability: "identity.currentActor", action: changes.action ?? "identity.currentActor", resource: changes.resource ?? "infrastructure:owned", audience: changes.audience ?? "ddi", actor: { ...actor, ownerId: (changes.ownerId ?? ownerId) as Actor["ownerId"], authorityActor: changes.actor ?? actorKey }, authority: { token }, correlationId: randomUUID() });
    const once = await grant(true);
    const wrongOwner = await client.consume({ token: once.token, audience: "ddi", actor: actorKey, action: "identity.currentActor", resource: "infrastructure:owned", ownerId: "own_wrong" });
    assert.equal(wrongOwner.ok, false);
    assert.equal(await store.isJtiConsumed(once.jti), false);
    assert.equal((await execute(once.token, { ownerId: "own_wrong" })).reason, "OWNER_MISMATCH");
    assert.equal((await execute(once.token, { action: "identity.write" })).reason, "AUTHORITY_WRONG_ACTION");
    assert.equal(await store.isJtiConsumed(once.jti), false);
    const allowed = await execute(once.token);
    assert.equal(allowed.status, "COMPLETED");
    const replay = await execute(once.token);
    assert.equal(replay.status, "DENIED");
    const live = await grant(false);
    assert.equal((await execute(live.token, { actor: "service:other" })).status, "DENIED");
    assert.equal((await execute(live.token, { resource: "infrastructure:other" })).status, "DENIED");
    assert.equal((await execute(live.token, { audience: "other" })).status, "DENIED");
    await service.revoke(ownerId, live.grantId);
    assert.equal((await execute(live.token)).status, "DENIED");
    const failing = new DurableDdiService(repository, async () => { throw new Error("authority down"); }, defaultAdapters(async () => { throw new Error("adapter down"); }));
    const unavailable = await failing.execute({ infrastructureId: infra.id, applicationId: app.id, capability: "identity.currentActor", action: "identity.currentActor", resource: "infrastructure:owned", audience: "ddi", actor, authority: { token: "x" }, correlationId: "authority-down" });
    assert.equal(unavailable.status, "FAILED");
    assert.equal(unavailable.reason, "AUTHORITY_UNAVAILABLE");
    const audits = await repository.snapshot();
    assert.equal(audits.audits.some(item => item.correlationId === "authority-down" && item.decision === "FAILED"), true);
    assert.equal(JSON.stringify(audits.audits).includes(once.token), false);
  });
});
