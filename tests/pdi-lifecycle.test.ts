import test, { after, before, describe } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import * as jose from "jose";
import { Pool } from "pg";
import type { Actor, Capability } from "../packages/contracts/src/index.ts";
import { authorityBinding } from "../packages/core/src/connection.ts";
import { migrate } from "../packages/service/src/postgres.ts";
import { PostgresDdiRepository } from "../packages/service/src/postgres-repository.ts";
import { DurableDdiService, authorityVerifier, defaultAdapters } from "../packages/service/src/runtime.ts";

const databaseUrl = process.env.DDI_TEST_DATABASE_URL ?? "";
const SCHEMA = "ddi_pdi_accept";
const DIGI_SCHEMA = "digi_pdi_owner_proof";
const ISSUER = "https://trustedid.netlify.app/api";
const AUDIENCE = "digiconomy:digi";
const bridgeUrl = pathToFileURL("C:/Users/Hp/Desktop/TRUST ID/packages/digi-bridge/dist/index.js").href;
const authorityUrl = pathToFileURL("C:/Users/Hp/Desktop/TRUST ID/packages/digi-authority/dist/index.js").href;
const verifierUrl = pathToFileURL("C:/Users/Hp/Desktop/TRUST ID/packages/authority-verifier/dist/index.js").href;
const caps: Capability[] = ["identity.currentActor", "data.read", "communication.send"];

function assertLocal(url: string) {
  const host = new URL(url).hostname;
  if (!["127.0.0.1", "localhost", "::1"].includes(host)) throw new Error("DDI Postgres tests only run against a local disposable database");
}

describe("PDI application connection lifecycle", { concurrency: 1 }, () => {
  let pool: Pool;
  let repository: PostgresDdiRepository;
  before(async () => {
    if (!databaseUrl) throw new Error("DDI_TEST_DATABASE_URL_REQUIRED");
    assertLocal(databaseUrl);
    const admin = new Pool({ connectionString: databaseUrl, max: 1, connectionTimeoutMillis: 5000 });
    await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await admin.query(`CREATE SCHEMA ${SCHEMA}`);
    await admin.end();
    pool = new Pool({ connectionString: databaseUrl, max: 20, connectionTimeoutMillis: 5000, options: `-c search_path=${SCHEMA}` });
    await migrate(pool, join("migrations", "001_ddi_foundation.sql"));
    await migrate(pool, join("migrations", "002_ddi_runtime.sql"));
    await migrate(pool, join("migrations", "003_pdi_connections.sql"));
    repository = new PostgresDdiRepository(pool);
  });
  after(async () => { await pool?.end(); });

  test("one personal PDI is enforced by PostgreSQL and lookup does not create it", async () => {
    const index = await pool.query<{ indexdef: string }>(`SELECT indexdef FROM pg_indexes WHERE schemaname = current_schema() AND indexname = 'ddi_personal_owner_uidx'`);
    assert.match(index.rows[0]?.indexdef ?? "", /UNIQUE/i);
    assert.match(index.rows[0]?.indexdef ?? "", /PERSONAL/);
    const ownerId = "own_lookup" as Actor["ownerId"];
    const actor: Actor = { ownerId, kind: "HUMAN", verified: true };
    assert.equal(await repository.findPersonal(ownerId), null);
    const created = await Promise.all(Array.from({ length: 16 }, (_, index) => repository.provision(ownerId, { type: "PERSONAL", idempotencyKey: `personal-${index}` })));
    assert.equal(new Set(created.map(item => item.id)).size, 1);
    const rows = await pool.query<{ n: string }>(`SELECT count(*)::text AS n FROM ddi_infrastructures WHERE owner_id = $1 AND type = 'PERSONAL'`, [ownerId]);
    assert.equal(Number(rows.rows[0]?.n), 1);
    const found = await repository.findPersonal(ownerId);
    assert.equal(found?.id, created[0]?.id);
    const createdAudits = await repository.connectionAudits();
    assert.equal(createdAudits.filter(item => item.eventType === "PDI_CREATED" && item.infrastructureId === created[0]?.id).length, 1);
    const creatorA = await repository.provision(ownerId, { type: "CREATOR", idempotencyKey: "creator-a" });
    const creatorB = await repository.provision(ownerId, { type: "CREATOR", idempotencyKey: "creator-b" });
    assert.notEqual(creatorA.id, creatorB.id);
    assert.notEqual(creatorA.id, created[0]?.id);
    const business = await repository.provision(ownerId, { type: "BUSINESS", idempotencyKey: "business-a" });
    assert.notEqual(business.id, created[0]?.id);
    const personalRows = await pool.query<{ n: string }>(`SELECT count(*)::text AS n FROM ddi_infrastructures WHERE owner_id = $1 AND type = 'PERSONAL'`, [ownerId]);
    assert.equal(Number(personalRows.rows[0]?.n), 1);
  });

  test("connection requests stay distinct from registration and do not grant authority", async () => {
    const ownerId = "own_request" as Actor["ownerId"];
    const actor: Actor = { ownerId, kind: "HUMAN", verified: true };
    const infra = await repository.provision(ownerId, { type: "PERSONAL", idempotencyKey: "request-pdi" });
    const app = await repository.registerApplication(ownerId, infra.id, { type: "REFERENCE", displayName: "Requester", capabilities: caps, idempotencyKey: "request-app" }) as { id: string; applicationCredential?: string; requestedCapabilities: Capability[] };
    assert.equal(app.applicationCredential?.startsWith("ddiapp_"), true);
    const resolved = await repository.findApplicationByCredential(app.applicationCredential ?? "");
    assert.equal(resolved?.id, app.id);
    assert.equal(await repository.findApplicationByCredential("ddiapp_not-the-secret"), null);
    await assert.rejects(repository.requestConnection("app:missing", ["identity.currentActor"], "missing", "missing-key"), /UNKNOWN_APPLICATION/);
    await assert.rejects(repository.requestConnection(app.id, ["jobs.run"], "unrequested", "unrequested-key"), /CAPABILITY_NOT_REQUESTED/);
    const first = await repository.requestConnection(app.id, caps, "request-1", "same-key");
    const same = await repository.requestConnection(app.id, caps, "request-1b", "same-key");
    assert.equal(same.id, first.id);
    assert.equal(first.status, "REQUESTED");
    assert.deepEqual(first.approvedCapabilities, []);
    assert.deepEqual(first.authorityGrantRefs, []);
    const other = await repository.registerApplication(ownerId, infra.id, { type: "REFERENCE", displayName: "Other", capabilities: caps, idempotencyKey: "other-app" });
    await assert.rejects(repository.requestConnection(other.id, caps, "stolen-key", "same-key"), /IDEMPOTENCY_OWNER_MISMATCH/);
    const parallel = await Promise.all(Array.from({ length: 8 }, (_, index) => repository.requestConnection(app.id, caps, `parallel-${index}`, `parallel-${index}`)));
    assert.equal(new Set(parallel.map(item => item.id)).size, 1);
    const count = await pool.query<{ n: string }>(`SELECT count(*)::text AS n FROM ddi_connections WHERE infrastructure_id = $1 AND application_id = $2`, [infra.id, app.id]);
    assert.equal(Number(count.rows[0]?.n), 1);
    await assert.rejects(repository.approveConnection("own_wrong" as Actor["ownerId"], first.id, ["identity.currentActor"], "wrong-owner", { async ensureGrant() { return { grantId: "should-not" }; } }), /OWNER_REQUIRED/);
    const unchanged = await repository.getConnection(first.id);
    assert.equal(unchanged?.status, "REQUESTED");
    assert.deepEqual(unchanged?.approvedCapabilities, []);
    const stored = JSON.stringify(await repository.snapshot());
    assert.equal(stored.includes(app.applicationCredential ?? "missing-secret"), false);
    assert.equal(actor.ownerId, ownerId);
  });

  test("owner consent activates through Digi Authority, execution, revocation, and reconnection", async () => {
    const bridge = await import(bridgeUrl) as {
      openPostgresDigiCore(url: string, options: { schema: string }): Promise<{ owners: unknown; replay: unknown; sessions: { resolve(token: string): Promise<{ ownerId: string } | null> }; runWrite<T>(fn: () => Promise<T>): Promise<T>; close(): Promise<void> }>;
      exchangeTrustIdAssertion(input: Record<string, unknown>): Promise<{ ok: true; ownerId: string; sessionToken: string; subject: string } | { ok: false; reason: string }>;
      createJwksCache(input: { jwksUrl: string; fetchImpl?: typeof fetch }): unknown;
    };
    const authority = await import(authorityUrl) as {
      MemoryAuthorityStore: new () => { isJtiConsumed(jti: string): Promise<boolean>; createGrant(input: Record<string, unknown>): Promise<{ id: string }> };
      AuthorityService: new (options: Record<string, unknown>) => {
        check(input: Record<string, unknown>): Promise<{ decision: string; grantId?: string; requestId?: string }>;
        approveRequest(ownerId: string, requestId: string, opts?: { oneTime?: boolean }): Promise<{ ok: true; grant: { id: string } } | { ok: false; reason: string }>;
        listActive(ownerId: string): Promise<{ id: string; actorType: string; actorId: string; actions: string[]; resources: string[]; audience: string; status: string }[]>;
        inspect(grantId: string): Promise<{ status: string } | null>;
        issueToken(ownerId: string, grantId: string): Promise<{ ok: true; token: string; jti: string } | { ok: false; reason: string }>;
        useToken(input: Record<string, string>): Promise<{ ok: boolean; reason?: string; grantId?: string }>;
        revoke(ownerId: string, grantId: string): Promise<{ ok: boolean }>;
      };
      generateAuthoritySigningKey(): Promise<Record<string, unknown>>;
    };
    const verifier = await import(verifierUrl) as { verifyAuthority(input: Record<string, unknown>): Promise<{ ok: boolean; reason?: string }> };
    const admin = new Pool({ connectionString: databaseUrl, max: 1, connectionTimeoutMillis: 5000 });
    await admin.query(`DROP SCHEMA IF EXISTS ${DIGI_SCHEMA} CASCADE`);
    await admin.end();
    const { privateKey, publicKey } = await jose.generateKeyPair("EdDSA", { extractable: true });
    const publicJwk = await jose.exportJWK(publicKey);
    publicJwk.kid = createHash("sha256").update(JSON.stringify(publicJwk)).digest("hex").slice(0, 16);
    publicJwk.alg = "EdDSA";
    publicJwk.use = "sig";
    const sign = (jti: string) => new jose.SignJWT({}).setProtectedHeader({ alg: "EdDSA", kid: publicJwk.kid, typ: "JWT" }).setIssuer(ISSUER).setAudience(AUDIENCE).setSubject("subject-pdi-proof").setIssuedAt().setExpirationTime("2m").setJti(jti).sign(privateKey);
    const core = await bridge.openPostgresDigiCore(databaseUrl, { schema: DIGI_SCHEMA });
    const store = new authority.MemoryAuthorityStore();
    const key = await authority.generateAuthoritySigningKey();
    let service: InstanceType<typeof authority.AuthorityService> | undefined;
    try {
      const jwks = bridge.createJwksCache({ jwksUrl: "https://jwks.test/jwks.json", fetchImpl: async () => new Response(JSON.stringify({ keys: [publicJwk] }), { status: 200, headers: { "content-type": "application/json" } }) });
      const exchanged = await bridge.exchangeTrustIdAssertion({ assertion: await sign(randomUUID()), expectedIssuer: ISSUER, expectedAudience: AUDIENCE, jwks, owners: core.owners, replay: core.replay, sessions: core.sessions, runWrite: core.runWrite });
      assert.equal(exchanged.ok, true);
      if (!exchanged.ok) return;
      const session = await core.sessions.resolve(exchanged.sessionToken);
      assert.equal(session?.ownerId, exchanged.ownerId);
      const ownerId = exchanged.ownerId as Actor["ownerId"];
      const actor: Actor = { ownerId, kind: "HUMAN", verified: true };
      assert.equal(await repository.findPersonal(ownerId), null);
      const infra = await repository.provision(ownerId, { type: "PERSONAL", idempotencyKey: "e2e-pdi" });
      const again = await repository.provision(ownerId, { type: "PERSONAL", idempotencyKey: "e2e-pdi-again" });
      assert.equal(again.id, infra.id);
      const registered = await repository.registerApplication(ownerId, infra.id, { type: "REFERENCE", displayName: "Proof", capabilities: caps, idempotencyKey: "e2e-app" }) as { id: string; applicationCredential?: string };
      service = new authority.AuthorityService({
        store,
        signingKey: key,
        persistence: "memory",
        policies: [{ actorType: "app", actorId: registered.id, audience: "ddi", rules: [{ actions: caps, decision: "ASK_OWNER" }] }],
      });
      const grants = grantPort(service);
      const durable = new DurableDdiService(repository, authorityVerifier(clientFor(verifier, service, key)), defaultAdapters(async () => ({ subject: "subject-pdi-proof" })), undefined, grants);
      const requested = await durable.requestConnection(registered.id, caps, "e2e-request", "e2e-connection");
      const before = await durable.execute(execution(infra.id, registered.id, ownerId, "identity.currentActor", "before-approval"));
      assert.equal(before.reason, "CONNECTION_NOT_ACTIVE");
      await assert.rejects(durable.approveConnection({ ownerId: "own_other" as Actor["ownerId"], kind: "HUMAN", verified: true }, requested.id, ["identity.currentActor"], "other-owner", exchanged.sessionToken), /OWNER_REQUIRED/);
      await assert.rejects(durable.approveConnection(actor, requested.id, ["jobs.run"], "not-requested"), /CAPABILITY_NOT_REQUESTED/);
      let failedOnce = false;
      const failing = new DurableDdiService(repository, async () => ({ ok: true, grantId: "unused" }), defaultAdapters(async () => ({ subject: "subject-pdi-proof" })), undefined, {
        async ensureGrant(input) {
          const grant = await grants.ensureGrant(input);
          if (!failedOnce) { failedOnce = true; throw new Error("persist failed"); }
          return grant;
        },
        revokeGrant: input => grants.revokeGrant(input),
      });
      await assert.rejects(failing.approveConnection(actor, requested.id, ["identity.currentActor", "data.read"], "persist-fail"), /AUTHORITY_GRANT_UNAVAILABLE/);
      assert.equal((await repository.getConnection(requested.id))?.status, "REQUESTED");
      const approved = await durable.approveConnection(actor, requested.id, ["identity.currentActor", "data.read"], "e2e-approve", exchanged.sessionToken);
      assert.equal(approved.status, "ACTIVE");
      assert.deepEqual([...approved.approvedCapabilities].sort(), ["data.read", "identity.currentActor"]);
      assert.equal(approved.approvedCapabilities.includes("communication.send"), false);
      assert.equal(approved.authorityGrantRefs.length, 2);
      assert.equal(new Set(approved.authorityGrantRefs.map(item => item.grantId)).size, 2);
      const repeated = await durable.approveConnection(actor, requested.id, ["identity.currentActor", "data.read"], "e2e-approve-again");
      assert.equal(repeated.revision, approved.revision);
      await durable.bind(actor, infra.id, "identity", "TrustID");
      const binding = authorityBinding(registered.id, infra.id, "identity.currentActor");
      const issued = await service.issueToken(ownerId, approved.authorityGrantRefs.find(item => item.capability === "identity.currentActor")!.grantId);
      assert.equal(issued.ok, true);
      if (!issued.ok) return;
      const completed = await durable.execute({ ...execution(infra.id, registered.id, ownerId, "identity.currentActor", "e2e-allow", binding.actor), action: binding.action, resource: binding.resource, audience: binding.audience, authority: { token: issued.token }, executionMode: "APP", payload: { assertion: "not-a-token" } });
      assert.equal(completed.status, "COMPLETED");
      assert.equal((completed.data as { ownerId: string }).ownerId, ownerId);
      const unapproved = await durable.execute(execution(infra.id, registered.id, ownerId, "communication.send", "unapproved", binding.actor));
      assert.equal(unapproved.reason, "CAPABILITY_NOT_APPROVED");
      const changed = await durable.requestCapabilityChange(registered.id, ["communication.send"], "change-1");
      assert.equal(changed.status, "REQUESTED_CHANGE");
      const stillAllowed = await durable.execute({ ...execution(infra.id, registered.id, ownerId, "identity.currentActor", "during-change", binding.actor), action: binding.action, resource: binding.resource, audience: binding.audience, authority: { token: issued.token }, executionMode: "SPACE" });
      assert.equal(stillAllowed.status, "COMPLETED");
      const narrowed = await durable.approveConnection(actor, requested.id, ["communication.send"], "change-approve");
      assert.equal(narrowed.status, "ACTIVE");
      assert.equal(narrowed.approvedCapabilities.includes("communication.send"), true);
      assert.equal(narrowed.approvedCapabilities.includes("identity.currentActor"), true);
      const removed = await durable.revokeCapabilities(actor, requested.id, ["data.read"], "remove-data");
      assert.equal(removed.status, "ACTIVE");
      assert.equal(removed.approvedCapabilities.includes("data.read"), false);
      const removedExecution = await durable.execute({ ...execution(infra.id, registered.id, ownerId, "data.read", "removed-cap", binding.actor), action: "data.read", resource: authorityBinding(registered.id, infra.id, "data.read").resource, audience: "ddi", authority: { token: "not-used" } });
      assert.equal(removedExecution.reason, "CAPABILITY_NOT_APPROVED");
      await assert.rejects(durable.revokeCapabilities(actor, requested.id, ["data.read"], "remove-again"), /CAPABILITY_NOT_REQUESTED/);
      const externalGrant = approved.authorityGrantRefs.find(item => item.capability === "identity.currentActor")!;
      await service.revoke(ownerId, externalGrant.grantId);
      const externallyRevoked = await durable.execute({ ...execution(infra.id, registered.id, ownerId, "identity.currentActor", "external-revoke", binding.actor), action: binding.action, resource: binding.resource, audience: binding.audience, authority: { token: issued.token } });
      assert.equal(externallyRevoked.status, "DENIED");
      assert.equal((await repository.getConnection(requested.id))?.status, "ACTIVE");
      const sendGrant = narrowed.authorityGrantRefs.find(item => item.capability === "communication.send")!;
      assert.equal(sendGrant.grantId.length > 0, true);
      const sendToken = await service.issueToken(ownerId, sendGrant.grantId);
      assert.equal(sendToken.ok, true);
      if (!sendToken.ok) return;
      const sendBinding = authorityBinding(registered.id, infra.id, "communication.send");
      assert.equal((await durable.execute({ ...execution(infra.id, registered.id, ownerId, "communication.send", "wrong-action", sendBinding.actor), action: "identity.write", resource: sendBinding.resource, audience: "ddi", authority: { token: sendToken.token } })).reason, "AUTHORITY_WRONG_ACTION");
      assert.equal((await durable.execute({ ...execution(infra.id, registered.id, ownerId, "communication.send", "wrong-resource", sendBinding.actor), action: sendBinding.action, resource: "ddi:pdi:other", audience: "ddi", authority: { token: sendToken.token } })).reason, "AUTHORITY_WRONG_RESOURCE");
      assert.equal((await durable.execute({ ...execution(infra.id, registered.id, ownerId, "communication.send", "wrong-audience", sendBinding.actor), action: sendBinding.action, resource: sendBinding.resource, audience: "other", authority: { token: sendToken.token } })).reason, "AUTHORITY_WRONG_AUDIENCE");
      assert.equal((await durable.execute({ ...execution(infra.id, registered.id, ownerId, "communication.send", "wrong-actor", "app:someone-else"), action: sendBinding.action, resource: sendBinding.resource, audience: "ddi", authority: { token: sendToken.token } })).status, "DENIED");
      const onceBinding = authorityBinding(registered.id, infra.id, "identity.currentActor");
      const once = await store.createGrant({ id: `auth_${randomUUID()}`, ownerId, actorType: "app", actorId: registered.id, audience: "ddi", actions: ["identity.currentActor"], resources: [onceBinding.resource], limits: {}, conditions: {}, approvalMode: "ALLOW", consequence: "LOW", oneTime: true, validFrom: new Date(), validUntil: new Date(Date.now() + 60 * 60 * 1000), status: "ACTIVE" });
      const onceToken = await service.issueToken(ownerId, once.id);
      assert.equal(onceToken.ok, true);
      if (!onceToken.ok) return;
      const replayed = { ...execution(infra.id, registered.id, ownerId, "identity.currentActor", "once", onceBinding.actor), action: onceBinding.action, resource: onceBinding.resource, audience: "ddi", authority: { token: onceToken.token } };
      assert.equal((await durable.execute({ ...replayed, correlationId: "once-1" })).status, "COMPLETED");
      assert.equal((await durable.execute({ ...replayed, correlationId: "once-2" })).status, "DENIED");
      assert.equal(await store.isJtiConsumed(onceToken.jti), true);
      const revoked = await durable.revokeConnection(actor, requested.id, "e2e-revoke");
      assert.equal(revoked.status, "REVOKED");
      assert.equal((await service.inspect(sendGrant.grantId))?.status, "REVOKED");
      const after = await durable.execute({ ...execution(infra.id, registered.id, ownerId, "communication.send", "after-revoke", sendBinding.actor), action: sendBinding.action, resource: sendBinding.resource, audience: "ddi", authority: { token: sendToken.token } });
      assert.equal(after.reason, "CONNECTION_NOT_ACTIVE");
      const reconnected = await durable.requestConnection(registered.id, ["identity.currentActor"], "reconnect", "reconnect-key");
      assert.equal(reconnected.id, requested.id);
      assert.equal(reconnected.status, "REQUESTED");
      assert.deepEqual(reconnected.authorityGrantRefs, []);
      assert.equal((await durable.execute(execution(infra.id, registered.id, ownerId, "identity.currentActor", "resurrect"))).reason, "CONNECTION_NOT_ACTIVE");
      const activeAgain = await durable.approveConnection(actor, reconnected.id, ["identity.currentActor"], "reconnect-approve");
      assert.equal(activeAgain.status, "ACTIVE");
      assert.notEqual(activeAgain.authorityGrantRefs[0]?.grantId, externalGrant.grantId);
      const restartedPool = new Pool({ connectionString: databaseUrl, max: 2, connectionTimeoutMillis: 5000, options: `-c search_path=${SCHEMA}` });
      const restarted = new PostgresDdiRepository(restartedPool);
      const durableState = await restarted.getConnection(requested.id);
      assert.equal(durableState?.status, "ACTIVE");
      assert.deepEqual(durableState?.approvedCapabilities, ["identity.currentActor"]);
      assert.equal(durableState?.authorityGrantRefs.length, 1);
      const history = await restarted.connectionAudits();
      for (const event of ["PDI_CREATED", "CONNECTION_REQUESTED", "CONNECTION_APPROVED", "CONNECTION_ACTIVATED", "CONNECTION_REVOKED", "CAPABILITY_REQUESTED", "CAPABILITY_APPROVED", "CAPABILITY_REVOKED", "CONNECTION_RECONNECTED"]) {
        assert.equal(history.some(item => item.eventType === event && item.ownerId === ownerId), true, event);
      }
      const snapshot = await restarted.snapshot();
      const text = JSON.stringify({ history, audits: snapshot.audits, connections: snapshot.connections });
      assert.equal(text.includes(exchanged.sessionToken), false);
      assert.equal(text.includes(issued.token), false);
      assert.equal(text.includes(registered.applicationCredential ?? "missing-secret"), false);
      assert.equal(text.includes("not-a-token"), false);
      assert.equal(snapshot.audits.some(item => item.correlationId === "e2e-allow" && item.decision === "ALLOW" && item.connectionId === requested.id && item.executionMode === "APP"), true);
      assert.equal(snapshot.audits.some(item => item.correlationId === "during-change" && item.executionMode === "SPACE" && item.decision === "ALLOW"), true);
      assert.equal(snapshot.audits.some(item => item.correlationId === "after-revoke" && item.decision === "DENY"), true);
      await restartedPool.end();
      const down = new URL(databaseUrl);
      down.port = "1";
      const dead = new Pool({ connectionString: down.toString(), max: 1, connectionTimeoutMillis: 400 });
      const unavailable = new DurableDdiService(new PostgresDdiRepository(dead), async () => ({ ok: true }), defaultAdapters(async () => ({ subject: "x" })));
      const storedDown = await unavailable.execute(execution(infra.id, registered.id, ownerId, "identity.currentActor", "postgres-down"));
      assert.equal(storedDown.reason, "STORAGE_UNAVAILABLE");
      await dead.end();
    } finally { await core.close(); }
  });

  test("approval, revocation, and reconnection races stay on one connection", async () => {
    const ownerId = "own_race" as Actor["ownerId"];
    const actor: Actor = { ownerId, kind: "HUMAN", verified: true };
    const infra = await repository.provision(ownerId, { type: "PERSONAL", idempotencyKey: "race-pdi" });
    const app = await repository.registerApplication(ownerId, infra.id, { type: "REFERENCE", displayName: "Race", capabilities: caps, idempotencyKey: "race-app" });
    const grants = { async ensureGrant(input: { action: string }) { return { grantId: `grant:${input.action}` }; }, async revokeGrant() { return undefined; } };
    const service = new DurableDdiService(repository, async () => ({ ok: true, grantId: "grant:race" }), defaultAdapters(async () => ({ subject: "x" })), undefined, grants);
    const requested = await service.requestConnection(app.id, ["identity.currentActor"], "race-request", "race-connection");
    const approvals = await Promise.all(Array.from({ length: 8 }, (_, index) => service.approveConnection(actor, requested.id, ["identity.currentActor"], `race-approve-${index}`)));
    assert.equal(approvals.every(item => item.status === "ACTIVE" && item.id === requested.id), true);
    const revokeRace = await service.requestConnection(app.id, ["data.read"], "race-change", "race-change-key").catch(async () => service.requestCapabilityChange(app.id, ["data.read"], "race-change"));
    assert.equal(revokeRace.status === "REQUESTED_CHANGE" || revokeRace.status === "ACTIVE", true);
    if (revokeRace.status === "REQUESTED_CHANGE") await service.approveConnection(actor, requested.id, ["data.read"], "race-data");
    const contested = await Promise.allSettled([
      service.approveConnection(actor, requested.id, ["identity.currentActor", "data.read"], "race-approve-late"),
      service.revokeConnection(actor, requested.id, "race-revoke"),
    ]);
    assert.equal(contested.some(item => item.status === "fulfilled"), true);
    const final = await service.revokeConnection(actor, requested.id, "race-revoke-final");
    assert.equal(final.status, "REVOKED");
    const reconnects = await Promise.all(Array.from({ length: 8 }, (_, index) => service.requestConnection(app.id, ["identity.currentActor"], `reconnect-${index}`, `reconnect-${index}`)));
    assert.equal(new Set(reconnects.map(item => item.id)).size, 1);
    assert.equal(reconnects.every(item => item.status === "REQUESTED" && item.authorityGrantRefs.length === 0), true);
    const rows = await pool.query<{ n: string }>(`SELECT count(*)::text AS n FROM ddi_connections WHERE application_id = $1`, [app.id]);
    assert.equal(Number(rows.rows[0]?.n), 1);
  });
});

function execution(infrastructureId: string, applicationId: string, ownerId: Actor["ownerId"], capability: Capability, correlationId: string, authorityActor = "app:pending") {
  return {
    infrastructureId: infrastructureId as never,
    applicationId: applicationId as never,
    capability,
    action: capability,
    resource: `ddi:pdi:${infrastructureId}:${capability}`,
    audience: "ddi",
    actor: { ownerId, kind: "SERVICE" as const, verified: true, authorityActor },
    correlationId,
  };
}

function grantPort(service: {
  check(input: Record<string, unknown>): Promise<{ decision: string; grantId?: string; requestId?: string }>;
  approveRequest(ownerId: string, requestId: string, opts?: { oneTime?: boolean }): Promise<{ ok: true; grant: { id: string } } | { ok: false; reason: string }>;
  listActive(ownerId: string): Promise<{ id: string; actorType: string; actorId: string; actions: string[]; resources: string[]; audience: string; status: string }[]>;
  revoke(ownerId: string, grantId: string): Promise<{ ok: boolean }>;
}) {
  return {
    async ensureGrant(input: { ownerId: string; actor: string; action: string; resource: string; audience: string }) {
      const split = input.actor.indexOf(":");
      const actor = { type: input.actor.slice(0, split), id: input.actor.slice(split + 1) };
      const active = await service.listActive(input.ownerId);
      const found = active.find(grant => grant.status === "ACTIVE" && grant.actorType === actor.type && grant.actorId === actor.id && grant.audience === input.audience && grant.actions.includes(input.action) && grant.resources.includes(input.resource));
      if (found) return { grantId: found.id };
      const checked = await service.check({ ownerId: input.ownerId, actor, action: input.action, resource: input.resource, audience: input.audience });
      if ((checked.decision === "ALLOW" || checked.decision === "ALLOW_WITH_LIMITS") && checked.grantId) return { grantId: checked.grantId };
      if (checked.decision === "ASK_OWNER" && checked.requestId) {
        const approved = await service.approveRequest(input.ownerId, checked.requestId, { oneTime: false });
        if (!approved.ok) throw new Error("AUTHORITY_GRANT_UNAVAILABLE");
        return { grantId: approved.grant.id };
      }
      throw new Error("AUTHORITY_GRANT_UNAVAILABLE");
    },
    async revokeGrant(input: { ownerId: string; grantId: string }) { await service.revoke(input.ownerId, input.grantId); },
  };
}

function clientFor(verifier: { verifyAuthority(input: Record<string, unknown>): Promise<{ ok: boolean; reason?: string }> }, service: { useToken(input: Record<string, string>): Promise<{ ok: boolean; reason?: string; grantId?: string }> }, key: { publicJwk?: unknown }) {
  return {
    async consume(input: { token: string; audience: string; actor: string; action: string; resource: string; ownerId: string }) {
      const { mapAuthorityReason } = await import("../packages/service/src/digi.ts");
      const verified = await verifier.verifyAuthority({ ...input, publicJwks: [key.publicJwk] });
      if (!verified.ok) return mapAuthorityReason(verified.reason ?? "INVALID");
      const used = await service.useToken({ token: input.token, expectedAudience: input.audience, expectedActor: input.actor, expectedAction: input.action, expectedResource: input.resource });
      return used.ok && used.grantId ? { ok: true as const, grantId: used.grantId } : mapAuthorityReason(used.reason ?? "INVALID");
    },
  };
}
