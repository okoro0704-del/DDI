import test, { after, before, describe } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { Pool } from "pg";
import type { Actor, CapabilityRequest } from "../packages/contracts/src/index.ts";
import { migrate } from "../packages/service/src/postgres.ts";
import { PostgresDdiRepository } from "../packages/service/src/postgres-repository.ts";
import { DurableDdiService, defaultAdapters } from "../packages/service/src/runtime.ts";

const databaseUrl = process.env.DDI_TEST_DATABASE_URL ?? "";
const schema = "ddi_connected_properties";
const local = (url: string) => ["127.0.0.1", "localhost", "::1"].includes(new URL(url).hostname);

describe("D1 connected digital properties", { concurrency: 1 }, () => {
  let pool: Pool;
  let repository: PostgresDdiRepository;
  const grants = { async ensureGrant(input: { resource: string }) { return { grantId: `grant:${input.resource}` }; }, async revokeGrant() { return undefined; } };
  const actor = (ownerId: string): Actor => ({ ownerId: ownerId as Actor["ownerId"], kind: "HUMAN", verified: true });

  before(async () => {
    if (!databaseUrl) throw new Error("DDI_TEST_DATABASE_URL_REQUIRED");
    if (!local(databaseUrl)) throw new Error("DDI Postgres tests only run against a local disposable database");
    const admin = new Pool({ connectionString: databaseUrl, max: 1 });
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.query(`CREATE SCHEMA ${schema}`);
    await admin.end();
    pool = new Pool({ connectionString: databaseUrl, max: 8, options: `-c search_path=${schema}` });
    for (const migration of ["001_ddi_foundation.sql", "002_ddi_runtime.sql", "003_pdi_connections.sql", "004_connected_properties.sql", "005_commercial_activation.sql", "006_commercial_recovery.sql", "007_portal_install_state.sql", "008_download_grant_version.sql", "009_service_token_replay.sql"]) await migrate(pool, join("migrations", migration));
    repository = new PostgresDdiRepository(pool);
  });
  after(async () => { await pool?.end(); });

  test("one owner keeps one PDI across a brand and ten businesses, with idempotency and race safety", async () => {
    const owner = actor("own_d1_many");
    const first = await repository.provisionProperty(owner.ownerId, { type: "PERSONAL_BRAND", externalSystem: "lifeos", externalReference: "brand:d1-owner", displayName: "Personal Brand", ownershipEvidence: "digi-session", idempotencyKey: "brand-1" });
    const businesses = await Promise.all(Array.from({ length: 10 }, (_, index) => repository.provisionProperty(owner.ownerId, { type: "BUSINESS", externalSystem: "lifeos", externalReference: `business:d1-${index}`, displayName: `Business ${index}`, ownershipEvidence: "digi-session", idempotencyKey: `business-${index}` })));
    assert.equal(new Set([first, ...businesses].map(item => item.infrastructure.id)).size, 1);
    assert.equal((await repository.listProperties(first.infrastructure.id)).length, 11);
    const retried = await repository.provisionProperty(owner.ownerId, { type: "BUSINESS", externalSystem: "lifeos", externalReference: "business:d1-0", displayName: "Business 0", ownershipEvidence: "digi-session", idempotencyKey: "business-0" });
    assert.equal(retried.created, false);
    assert.equal(retried.property.id, businesses[0]!.property.id);
    const raced = await Promise.all(Array.from({ length: 8 }, () => repository.provisionProperty(owner.ownerId, { type: "SPACE", externalSystem: "spaces", externalReference: "space:d1-race", displayName: "Race Space", ownershipEvidence: "digi-session", idempotencyKey: "space-race" })));
    assert.equal(new Set(raced.map(item => item.property.id)).size, 1);
    const other = await repository.provisionProperty(actor("own_d1_other").ownerId, { type: "BUSINESS", externalSystem: "lifeos", externalReference: "business:d1-other", displayName: "Other", ownershipEvidence: "digi-session", idempotencyKey: "other-1" });
    assert.notEqual(other.infrastructure.id, first.infrastructure.id);
    await assert.rejects(repository.provisionProperty(other.infrastructure.ownerId, { type: "BUSINESS", externalSystem: "lifeos", externalReference: "business:d1-0", displayName: "Spoof", ownershipEvidence: "digi-session", idempotencyKey: "spoof" }), /PROPERTY_REFERENCE_CONFLICT/);
  });

  test("property-scoped grants, binding replay resistance, and revocation cannot cross property boundaries", async () => {
    const owner = actor("own_d1_scope");
    const left = await repository.provisionProperty(owner.ownerId, { type: "BUSINESS", externalSystem: "lifeos", externalReference: "business:scope-left", displayName: "Left", ownershipEvidence: "digi-session", idempotencyKey: "scope-left" });
    const right = await repository.provisionProperty(owner.ownerId, { type: "BUSINESS", externalSystem: "lifeos", externalReference: "business:scope-right", displayName: "Right", ownershipEvidence: "digi-session", idempotencyKey: "scope-right" });
    const app = await repository.registerApplication(owner.ownerId, left.infrastructure.id, { type: "REFERENCE", displayName: "Left app", propertyId: left.property.id, capabilities: ["identity.currentActor"], idempotencyKey: "left-app" });
    const connection = await repository.requestConnection(app.id, ["identity.currentActor"], "left-request", "left-connection");
    const approved = await repository.approveConnection(owner.ownerId, connection.id, ["identity.currentActor"], "left-approve", grants);
    assert.match(approved.authorityGrantRefs[0]!.resource, new RegExp(`property:${left.property.id}:identity\\.currentActor$`));
    assert.equal((await repository.getProperty(right.property.id))?.status, "ACTIVE");
    const request = { infrastructureId: left.infrastructure.id, applicationId: app.id, capability: "identity.currentActor", action: "identity.currentActor", resource: approved.authorityGrantRefs[0]!.resource, audience: "ddi", actor: { ...owner, kind: "SERVICE", authorityActor: approved.authorityGrantRefs[0]!.actor }, authority: { token: "unused" }, correlationId: "after-property-revoke" } as CapabilityRequest;
    const service = new DurableDdiService(repository, async () => ({ ok: true }), defaultAdapters(async () => ({ subject: "subject" })), undefined, grants);
    const replay = await service.execute({ ...request, resource: `ddi:pdi:${left.infrastructure.id}:identity.currentActor`, correlationId: "legacy-resource-replay" });
    assert.equal(replay.reason, "AUTHORITY_BINDING_MISMATCH");
    await service.revokeProperty(owner, left.property.id, "left-revoke");
    assert.equal((await repository.getInfrastructure(left.infrastructure.id))?.id, left.infrastructure.id);
    assert.equal((await repository.getConnection(connection.id))?.status, "REVOKED");
    const result = await service.execute(request);
    assert.equal(result.reason, "PROPERTY_NOT_ACTIVE");
    assert.equal((await repository.getProperty(right.property.id))?.status, "ACTIVE");
  });

  test("a concurrent execution cannot complete after its property is revoked", async () => {
    const owner = actor("own_d2_concurrent");
    const property = await repository.provisionProperty(owner.ownerId, { type: "BUSINESS", externalSystem: "lifeos", externalReference: "business:concurrent", displayName: "Concurrent", ownershipEvidence: "digi-session", idempotencyKey: "concurrent-property" });
    await repository.bind(owner.ownerId, property.infrastructure.id, "data", "DataZone");
    const app = await repository.registerApplication(owner.ownerId, property.infrastructure.id, { type: "REFERENCE", displayName: "Concurrent app", propertyId: property.property.id, capabilities: ["data.read"], idempotencyKey: "concurrent-app" });
    const connection = await repository.requestConnection(app.id, ["data.read"], "concurrent-request", "concurrent-connection");
    const approved = await repository.approveConnection(owner.ownerId, connection.id, ["data.read"], "concurrent-approve", grants);
    let entered!: () => void;
    let release!: () => void;
    const enteredAuthority = new Promise<void>(resolve => { entered = resolve; });
    const releaseAuthority = new Promise<void>(resolve => { release = resolve; });
    const adapters = new Map([["data", { namespace: "data" as const, provider: "DataZone" as const, async resolve() { return { ok: true }; }, async execute(request: CapabilityRequest) { return { status: "COMPLETED" as const, correlationId: request.correlationId }; }, async health() { return "CONNECTED" as const; } }]]);
    const service = new DurableDdiService(repository, async () => { entered(); await releaseAuthority; return { ok: true }; }, adapters, undefined, grants);
    const ref = approved.authorityGrantRefs[0]!;
    const execution = service.execute({ infrastructureId: property.infrastructure.id, applicationId: app.id, capability: "data.read", action: ref.action, resource: ref.resource, audience: ref.audience, actor: { ...owner, kind: "SERVICE", authorityActor: ref.actor }, authority: { token: "unused" }, correlationId: "concurrent-execution" });
    await enteredAuthority;
    await service.revokeProperty(owner, property.property.id, "concurrent-revoke");
    release();
    const result = await execution;
    assert.equal(result.status, "DENIED");
    assert.equal(result.reason, "PROPERTY_NOT_ACTIVE");
    assert.equal((await repository.getConnection(connection.id))?.status, "REVOKED");
  });
});
