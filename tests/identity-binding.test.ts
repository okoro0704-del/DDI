import test, { after, before, describe } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { Pool } from "pg";
import type { Actor, CapabilityRequest } from "../packages/contracts/src/index.ts";
import { UnavailableAdapter, type AuthorityVerifier } from "../packages/core/src/index.ts";
import { routeInventory } from "../apps/api/src/app.ts";
import { migrate } from "../packages/service/src/postgres.ts";
import { PostgresDdiRepository } from "../packages/service/src/postgres-repository.ts";
import { DurableDdiService, defaultAdapters } from "../packages/service/src/runtime.ts";

const databaseUrl = process.env.DDI_TEST_DATABASE_URL ?? "";
const SCHEMA = "ddi_identity_binding";

function assertLocal(url: string) {
  const host = new URL(url).hostname;
  if (!["127.0.0.1", "localhost", "::1"].includes(host)) throw new Error("DDI Postgres tests only run against a local disposable database");
}

describe("PDI identity primitive binding", { concurrency: 1 }, () => {
  let pool: Pool;
  let repository: PostgresDdiRepository;
  const grants = { async ensureGrant() { return { grantId: `auth_${randomUUID()}` }; }, async revokeGrant() { return undefined; } };
  const allow = async () => ({ ok: true as const, grantId: "auth_exec" });

  before(async () => {
    if (!databaseUrl) throw new Error("DDI_TEST_DATABASE_URL_REQUIRED");
    assertLocal(databaseUrl);
    const admin = new Pool({ connectionString: databaseUrl, max: 1, connectionTimeoutMillis: 5000 });
    await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await admin.query(`CREATE SCHEMA ${SCHEMA}`);
    await admin.end();
    pool = new Pool({ connectionString: databaseUrl, max: 8, connectionTimeoutMillis: 5000, options: `-c search_path=${SCHEMA}` });
    await migrate(pool, join("migrations", "001_ddi_foundation.sql"));
    await migrate(pool, join("migrations", "002_ddi_runtime.sql"));
    await migrate(pool, join("migrations", "003_pdi_connections.sql"));
    repository = new PostgresDdiRepository(pool);
  });
  after(async () => { await pool?.end(); });

  function service(authority: AuthorityVerifier = allow, adapters = defaultAdapters(async () => ({ subject: "unused-subject" }))) {
    return new DurableDdiService(repository, authority, adapters, undefined, grants);
  }
  function actor(ownerId: string): Actor {
    return { ownerId: ownerId as Actor["ownerId"], kind: "HUMAN", verified: true };
  }
  async function ready(ownerId: string, key: string) {
    const current = actor(ownerId);
    assert.equal(await repository.findPersonal(current.ownerId), null);
    const infra = await repository.provision(current.ownerId, { type: "PERSONAL", idempotencyKey: key });
    const app = await repository.registerApplication(current.ownerId, infra.id, { type: "REFERENCE", displayName: "HospitalityOS", capabilities: ["identity.currentActor", "data.read"], idempotencyKey: `${key}-app` });
    return { current, infra, app };
  }
  function request(item: { infra: { id: string; ownerId: Actor["ownerId"] }; app: { id: string } }, mode: "APP" | "SPACE", capability: CapabilityRequest["capability"] = "identity.currentActor"): CapabilityRequest {
    return { infrastructureId: item.infra.id as CapabilityRequest["infrastructureId"], applicationId: item.app.id as CapabilityRequest["applicationId"], capability, action: capability, resource: `ddi:pdi:${item.infra.id}:${capability}`, audience: "ddi", actor: { ownerId: item.infra.ownerId, kind: "SERVICE", verified: true, authorityActor: `app:${item.app.id}` }, authority: { token: "authority-token" }, correlationId: randomUUID(), executionMode: mode };
  }

  test("explicit personal creation provisions one system-managed TrustID binding and does not authorize an application", async () => {
    assert.equal(routeInventory.some(route => route.url.includes("bind")), false);
    const item = await ready("own_binding_new", "binding-new");
    const rows = await pool.query<{ n: string; provider: string; provider_reference: string }>(`SELECT count(*)::text AS n, max(provider) AS provider, max(provider_reference) AS provider_reference FROM ddi_primitive_bindings WHERE infrastructure_id = $1 AND namespace = 'identity'`, [item.infra.id]);
    assert.equal(Number(rows.rows[0]?.n), 1);
    assert.equal(rows.rows[0]?.provider, "TrustID");
    assert.equal(rows.rows[0]?.provider_reference, "SYSTEM_MANAGED");
    assert.equal((await repository.findBinding(item.infra.id, "identity"))?.management, "SYSTEM_MANAGED");
    assert.equal((await repository.listConnections(item.infra.id)).length, 0);
    const again = await repository.provision(item.current.ownerId, { type: "PERSONAL", idempotencyKey: "binding-new-repeat" });
    assert.equal(again.id, item.infra.id);
    const repeated = await pool.query<{ namespace: string; n: string }>(`SELECT namespace, count(*)::text AS n FROM ddi_primitive_bindings WHERE infrastructure_id = $1 GROUP BY namespace ORDER BY namespace`, [item.infra.id]);
    assert.deepEqual(repeated.rows.map(row => [row.namespace, Number(row.n)]), [["identity", 1]]);
    assert.equal(await repository.findBinding(item.infra.id, "communication"), null);
    await assert.rejects(repository.bind(item.current.ownerId, item.infra.id, "identity", "ElfCom"), /PROVIDER_LOCKED|PROVIDER_CONFLICT/);
    const creator = await repository.provision(item.current.ownerId, { type: "CREATOR", idempotencyKey: "creator-no-identity" });
    assert.equal(await repository.findBinding(creator.id, "identity"), null);
  });

  test("an existing personal PDI without a binding is repaired once", async () => {
    const id = `infra:${randomUUID()}`;
    const ownerId = "own_binding_repair";
    const at = new Date().toISOString();
    await pool.query(`INSERT INTO ddi_infrastructures (id, owner_subject, owner_id, type, status, metadata, created_at, updated_at) VALUES ($1, '', $2, 'PERSONAL', 'ACTIVE', '{}'::jsonb, $3, $3)`, [id, ownerId, at]);
    const found = await repository.findPersonal(ownerId as Actor["ownerId"]);
    assert.equal(found?.id, id);
    await repository.ensurePersonalIdentity(id);
    const rows = await pool.query<{ n: string; provider_reference: string }>(`SELECT count(*)::text AS n, max(provider_reference) AS provider_reference FROM ddi_primitive_bindings WHERE infrastructure_id = $1 AND namespace = 'identity'`, [id]);
    assert.equal(Number(rows.rows[0]?.n), 1);
    assert.equal(rows.rows[0]?.provider_reference, "SYSTEM_MANAGED");
  });

  test("currentActor returns the Digi owner only when the connection and Authority allow it", async () => {
    const item = await ready("own_binding_exec", "binding-exec");
    const runtime = service();
    const absent = await runtime.execute(request(item, "APP"));
    assert.equal(absent.reason, "CONNECTION_REQUIRED");
    const requested = await repository.requestConnection(item.app.id, ["identity.currentActor"], "req", "binding-exec-connection");
    const waiting = await runtime.execute(request(item, "APP"));
    assert.equal(waiting.reason, "CONNECTION_NOT_ACTIVE");
    await repository.approveConnection(item.current.ownerId, requested.id, ["identity.currentActor"], "approve", grants);
    const denied = await service(async () => ({ ok: false, reason: "REVOKED" })).execute(request(item, "APP"));
    assert.equal(denied.status, "DENIED");
    const completed = await runtime.execute(request(item, "APP"));
    assert.equal(completed.status, "COMPLETED");
    assert.equal((completed.data as { ownerId?: string; subject?: string }).ownerId, item.current.ownerId);
    assert.notEqual((completed.data as { subject?: string }).subject, item.current.ownerId);
    const space = await runtime.execute(request(item, "SPACE"));
    assert.equal(space.status, "COMPLETED");
    assert.equal((space.data as { ownerId?: string }).ownerId, item.current.ownerId);
    const unapproved = await runtime.execute(request(item, "APP", "data.read"));
    assert.equal(unapproved.reason, "CAPABILITY_NOT_APPROVED");
    const bindingId = (await repository.findBinding(item.infra.id, "identity"))?.id;
    await repository.revokeConnection(item.current.ownerId, requested.id, "revoke", grants);
    const revoked = await runtime.execute(request(item, "APP"));
    assert.equal(revoked.reason, "CONNECTION_NOT_ACTIVE");
    assert.equal((await repository.findBinding(item.infra.id, "identity"))?.id, bindingId);
    const reconnected = await repository.requestConnection(item.app.id, ["identity.currentActor"], "reconnect", "binding-exec-reconnect");
    await repository.approveConnection(item.current.ownerId, reconnected.id, ["identity.currentActor"], "reapprove", grants);
    const restored = await runtime.execute(request(item, "SPACE"));
    assert.equal(restored.status, "COMPLETED");
    assert.equal((restored.data as { ownerId?: string }).ownerId, item.current.ownerId);
    assert.equal((await repository.findBinding(item.infra.id, "identity"))?.id, bindingId);
    const bindings = await pool.query<{ n: string }>(`SELECT count(*)::text AS n FROM ddi_primitive_bindings WHERE infrastructure_id = $1 AND namespace = 'identity'`, [item.infra.id]);
    assert.equal(Number(bindings.rows[0]?.n), 1);
  });

  test("two owners keep separate bindings and a restarted repository still resolves the same owner", async () => {
    const left = await ready("own_binding_a", "binding-a");
    const right = await ready("own_binding_b", "binding-b");
    const runtime = service();
    for (const item of [left, right]) {
      const connection = await repository.requestConnection(item.app.id, ["identity.currentActor"], item.infra.id, `${item.infra.id}-connection`);
      await repository.approveConnection(item.current.ownerId, connection.id, ["identity.currentActor"], item.infra.id, grants);
    }
    const leftResult = await runtime.execute(request(left, "APP"));
    const rightResult = await runtime.execute(request(right, "APP"));
    assert.equal((leftResult.data as { ownerId?: string }).ownerId, "own_binding_a");
    assert.equal((rightResult.data as { ownerId?: string }).ownerId, "own_binding_b");
    const crossed = await runtime.execute({ ...request(left, "APP"), actor: { ownerId: right.current.ownerId, kind: "SERVICE", verified: true } });
    assert.equal(crossed.reason, "OWNER_MISMATCH");
    const restartedPool = new Pool({ connectionString: databaseUrl, max: 2, connectionTimeoutMillis: 5000, options: `-c search_path=${SCHEMA}` });
    const restarted = new PostgresDdiRepository(restartedPool);
    const binding = await restarted.findBinding(left.infra.id, "identity");
    assert.equal(binding?.provider, "TrustID");
    assert.equal(binding?.management, "SYSTEM_MANAGED");
    const restartedService = new DurableDdiService(restarted, allow, defaultAdapters(async () => null), undefined, grants);
    const afterRestart = await restartedService.execute(request(left, "SPACE"));
    assert.equal((afterRestart.data as { ownerId?: string }).ownerId, "own_binding_a");
    await restartedPool.end();
  });

  test("an unavailable identity provider does not invent an owner", async () => {
    const item = await ready("own_binding_down", "binding-down");
    const connection = await repository.requestConnection(item.app.id, ["identity.currentActor"], "down", "binding-down-connection");
    await repository.approveConnection(item.current.ownerId, connection.id, ["identity.currentActor"], "down", grants);
    const adapters = defaultAdapters(async () => ({ subject: "should-not-be-used" }));
    adapters.set("identity", new UnavailableAdapter("identity", "TrustID"));
    const result = await service(allow, adapters).execute(request(item, "APP"));
    assert.equal(result.status, "CAPABILITY_UNAVAILABLE");
    assert.equal(result.reason, "PROVIDER_UNAVAILABLE");
    assert.equal((result.data as { ownerId?: string } | undefined)?.ownerId, undefined);
  });
});
