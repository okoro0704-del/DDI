import test, { after, before, describe } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { Pool } from "pg";
import type { Actor, Capability, CapabilityRequest } from "../packages/contracts/src/index.ts";
import { buildApi } from "../apps/api/src/app.ts";
import { readConfig } from "../packages/service/src/config.ts";
import { migrate } from "../packages/service/src/postgres.ts";
import { PostgresDdiRepository } from "../packages/service/src/postgres-repository.ts";
import { HttpDigiAuthorityClient, HttpDigiAuthorityGrantClient, HttpDigiSessionClient } from "../packages/service/src/digi.ts";
import { DurableDdiService, authorityVerifier, defaultAdapters } from "../packages/service/src/runtime.ts";

const databaseUrl = process.env.DDI_TEST_DATABASE_URL ?? "";
const DDI_SCHEMA = "ddi_reusable_v1";
const DIGI_SCHEMA = "digi_reusable_v1";
const AUTHORITY_SCHEMA = "authority_reusable_v1";
const ISSUER = "https://trustedid.netlify.app/api";
const AUDIENCE = "digiconomy:digi";
const trustRoot = process.env.DDI_TRUSTID_ROOT ?? "C:/Users/Hp/Desktop/TRUST ID";

type GrantView = { id: string; status: string; oneTime: boolean; actorType: string; actorId: string; actions: string[]; resources: string[]; audience: string };
type Session = { ownerId: string; sessionToken: string; assertion: string };
type Product = { session: Session; infraId: string; appId: string; secret: string; actor: Actor };

function assertLocal(url: string) {
  const host = new URL(url).hostname;
  if (!["127.0.0.1", "localhost", "::1"].includes(host)) throw new Error("DDI Postgres tests only run against a local disposable database");
}

describe("DDI reusable authority grant alignment", { concurrency: 1 }, () => {
  let pool: Pool;
  let repository: PostgresDdiRepository;
  let service: DurableDdiService;
  let ddiBase = "";
  let authorityBase = "";
  let privateKey: CryptoKey;
  const closers: Array<() => Promise<void>> = [];
  const approveBodies: string[] = [];

  before(async () => {
    if (!databaseUrl) throw new Error("DDI_TEST_DATABASE_URL_REQUIRED");
    assertLocal(databaseUrl);
    const admin = new Pool({ connectionString: databaseUrl, max: 1, connectionTimeoutMillis: 5000 });
    await admin.query(`DROP SCHEMA IF EXISTS ${DDI_SCHEMA} CASCADE`);
    await admin.query(`DROP SCHEMA IF EXISTS ${AUTHORITY_SCHEMA} CASCADE`);
    await admin.query(`CREATE SCHEMA ${DDI_SCHEMA}`);
    await admin.query(`CREATE SCHEMA ${AUTHORITY_SCHEMA}`);
    await admin.end();
    pool = new Pool({ connectionString: databaseUrl, max: 12, connectionTimeoutMillis: 5000, options: `-c search_path=${DDI_SCHEMA}` });
    await migrate(pool, join("migrations", "001_ddi_foundation.sql"));
    await migrate(pool, join("migrations", "002_ddi_runtime.sql"));
    await migrate(pool, join("migrations", "003_pdi_connections.sql"));
    repository = new PostgresDdiRepository(pool);
    const bridge = await import(pathToFileURL(join(trustRoot, "packages/digi-bridge/dist/index.js")).href) as { openPostgresDigiCore(url: string, options: { schema: string }): Promise<{ owners: unknown; replay: unknown; sessions: unknown; runWrite: unknown; close(): Promise<void> }> };
    const authorityPackage = await import(pathToFileURL(join(trustRoot, "packages/digi-authority/dist/index.js")).href) as { PostgresAuthorityStore: new (url: string) => { close(): Promise<void> } };
    const digiApp = await import(pathToFileURL(join(trustRoot, "apps/digi-rp/dist/app.js")).href) as { buildDigiRp(options: Record<string, unknown>): Promise<{ app: { listen(options: { port: number; host: string }): Promise<string>; close(): Promise<void> } }> };
    const core = await bridge.openPostgresDigiCore(databaseUrl, { schema: DIGI_SCHEMA });
    closers.push(() => core.close());
    const authorityUrl = new URL(databaseUrl);
    authorityUrl.searchParams.set("options", `-c search_path=${AUTHORITY_SCHEMA}`);
    const authorityStore = new authorityPackage.PostgresAuthorityStore(authorityUrl.toString());
    closers.push(() => authorityStore.close());
    const keys = await generateKeyPair("EdDSA", { extractable: true });
    privateKey = keys.privateKey;
    const privateJwk = await exportJWK(keys.privateKey);
    privateJwk.kid = "reusable-grant";
    privateJwk.alg = "EdDSA";
    const publicJwk = await exportJWK(keys.publicKey);
    publicJwk.kid = "trustid-proof";
    publicJwk.alg = "EdDSA";
    const previousNodeEnv = process.env.NODE_ENV;
    const previousKey = process.env.DIGI_AUTHORITY_PRIVATE_JWK;
    process.env.NODE_ENV = "production";
    process.env.DIGI_AUTHORITY_PRIVATE_JWK = JSON.stringify(privateJwk);
    let digi: Awaited<ReturnType<typeof digiApp.buildDigiRp>>;
    try {
      digi = await digiApp.buildDigiRp({
        trustIdIssuer: ISSUER,
        jwksUrl: `${ISSUER}/jwks`,
        digiAudience: AUDIENCE,
        cookieSecret: "reusable-grant-cookie-secret-32chars",
        corsOrigins: [],
        owners: core.owners,
        replay: core.replay,
        sessions: core.sessions,
        runWrite: core.runWrite,
        authorityStore,
        authorityPersistence: "postgres",
        fetchImpl: (async () => new Response(JSON.stringify({ keys: [publicJwk] }), { status: 200, headers: { "content-type": "application/json" } })) as typeof fetch,
      });
    } finally {
      if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previousNodeEnv;
      if (previousKey === undefined) delete process.env.DIGI_AUTHORITY_PRIVATE_JWK;
      else process.env.DIGI_AUTHORITY_PRIVATE_JWK = previousKey;
    }
    authorityBase = await digi.app.listen({ port: 0, host: "127.0.0.1" });
    closers.push(() => digi.app.close());
    const grants = new HttpDigiAuthorityGrantClient(authorityBase);
    const consume = new HttpDigiAuthorityClient({ consumeUrl: `${authorityBase}/v1/authority/consume`, jwksUrl: `${authorityBase}/.well-known/authority-jwks.json`, verifierModuleUrl: pathToFileURL(join(trustRoot, "packages/authority-verifier/dist/index.js")).href });
    service = new DurableDdiService(repository, authorityVerifier(consume), defaultAdapters(async () => ({ subject: "subject-reusable" })), new HttpDigiSessionClient(authorityBase), grants);
    const api = buildApi({ service, config: readConfig({ DDI_ENV: "test", DDI_ALLOWED_ORIGINS: "https://app.example.test" }) });
    ddiBase = await api.listen({ port: 0, host: "127.0.0.1" });
    closers.push(() => api.close());
    const original = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.startsWith(authorityBase) && url.includes("/authority/requests/") && url.endsWith("/approve")) approveBodies.push(String(init?.body ?? ""));
      return original(input, init);
    }) as typeof fetch;
    closers.push(async () => { globalThis.fetch = original; });
  });

  after(async () => {
    for (const close of closers.reverse()) await close().catch(() => undefined);
    await pool?.end().catch(() => undefined);
  });

  async function exchange(subject: string): Promise<Session> {
    const assertion = await new SignJWT({}).setProtectedHeader({ alg: "EdDSA", kid: "trustid-proof" }).setIssuer(ISSUER).setAudience(AUDIENCE).setSubject(subject).setIssuedAt().setExpirationTime("5m").setJti(randomUUID()).sign(privateKey);
    const exchanged = await fetch(new URL("/auth/trustid/exchange", authorityBase), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ assertion }) });
    assert.equal(exchanged.status, 200);
    const session = await exchanged.json() as { ownerId: string; sessionToken: string };
    return { ...session, assertion };
  }

  async function product(subject: string, capabilities: Capability[]): Promise<Product> {
    const session = await exchange(subject);
    const headers = { authorization: `Bearer ${session.sessionToken}`, "content-type": "application/json", "idempotency-key": `${subject}-pdi` };
    const missing = await fetch(new URL("/me/pdi", ddiBase), { headers });
    assert.equal((await missing.json() as { state: string }).state, "NOT_PROVISIONED");
    const created = await fetch(new URL("/me/pdi", ddiBase), { method: "POST", headers, body: "{}" });
    assert.equal(created.status, 200);
    const infra = await created.json() as { id: string; ownerId: string; type: string };
    assert.equal(infra.type, "PERSONAL");
    assert.equal(infra.ownerId, session.ownerId);
    const actor = await service.authenticate(session.sessionToken);
    assert.ok(actor);
    await service.bind(actor, infra.id, "identity", "TrustID");
    const registered = await fetch(new URL(`/infrastructures/${infra.id}/apps`, ddiBase), { method: "POST", headers: { authorization: headers.authorization, "content-type": "application/json", "idempotency-key": `${subject}-app` }, body: JSON.stringify({ type: "REFERENCE", displayName: subject, capabilities }) });
    assert.equal(registered.status, 200);
    const app = await registered.json() as { id: string; applicationCredential: string };
    assert.equal(app.applicationCredential.startsWith("ddiapp_"), true);
    return { session, infraId: infra.id, appId: app.id, secret: app.applicationCredential, actor };
  }

  function ownerHeaders(session: Session) {
    return { authorization: `Bearer ${session.sessionToken}`, "content-type": "application/json" };
  }

  async function requestConnection(item: Product, capabilities: Capability[], key: string) {
    const response = await fetch(new URL(`/infrastructures/${item.infraId}/connections`, ddiBase), { method: "POST", headers: { authorization: `Application ${item.secret}`, "content-type": "application/json", "idempotency-key": key }, body: JSON.stringify({ capabilities }) });
    assert.equal(response.status, 200);
    return response.json() as Promise<{ id: string; status: string; authorityGrantRefs: { grantId: string; capability: string }[] }>;
  }

  async function approve(item: Product, connectionId: string, capabilities: Capability[]) {
    const beforeCount = approveBodies.length;
    const response = await fetch(new URL(`/connections/${connectionId}/approve`, ddiBase), { method: "POST", headers: ownerHeaders(item.session), body: JSON.stringify({ capabilities }) });
    const body = await response.json() as { status?: string; code?: string; authorityGrantRefs?: { grantId: string; capability: string; actor: string; action: string; resource: string; audience: string }[]; approvedCapabilities?: string[] };
    return { status: response.status, body, approvalBody: approveBodies[beforeCount] };
  }

  async function grants(session: Session, state: "active" | "revoked") {
    const response = await fetch(new URL(`/authority/grants/${state}`, authorityBase), { headers: ownerHeaders(session) });
    assert.equal(response.status, 200);
    return (await response.json() as { grants: GrantView[] }).grants;
  }

  async function inspect(session: Session, grantId: string) {
    const response = await fetch(new URL(`/authority/grants/${grantId}`, authorityBase), { headers: ownerHeaders(session) });
    assert.equal(response.status, 200);
    return (await response.json() as { grant: GrantView }).grant;
  }

  async function issue(session: Session, grantId: string) {
    const response = await fetch(new URL("/authority/token", authorityBase), { method: "POST", headers: ownerHeaders(session), body: JSON.stringify({ grantId }) });
    assert.equal(response.status, 200);
    return (await response.json() as { token: string }).token;
  }

  async function execute(item: Product, capability: Capability, token: string, correlationId: string, executionMode: "APP" | "SPACE" = "APP") {
    const response = await fetch(new URL("/capabilities/execute", ddiBase), { method: "POST", headers: { authorization: `Application ${item.secret}`, "content-type": "application/json", "x-correlation-id": correlationId }, body: JSON.stringify({ capability, authorityToken: token, executionMode }) });
    return { status: response.status, body: await response.json() as { status: string; reason?: string } };
  }

  test("DDI approval creates one reusable grant and three executions share it until connection revocation", async () => {
    const item = await product("subject-reusable-main", ["identity.currentActor", "data.read"]);
    const requested = await requestConnection(item, ["identity.currentActor"], "main-request");
    assert.equal(requested.status, "REQUESTED");
    assert.equal((await grants(item.session, "active")).length, 0);
    const self = await fetch(new URL(`/connections/${requested.id}/approve`, ddiBase), { method: "POST", headers: { authorization: `Application ${item.secret}`, "content-type": "application/json" }, body: JSON.stringify({ capabilities: ["identity.currentActor"] }) });
    assert.equal(self.status, 401);
    const unrequested = await approve(item, requested.id, ["data.read"]);
    assert.equal(unrequested.status, 400);
    assert.equal(unrequested.body.code, "CAPABILITY_NOT_REQUESTED");
    const stranger = await exchange("subject-reusable-stranger");
    const wrongOwner = await fetch(new URL(`/connections/${requested.id}/approve`, ddiBase), { method: "POST", headers: ownerHeaders(stranger), body: JSON.stringify({ capabilities: ["identity.currentActor"] }) });
    assert.equal(wrongOwner.status, 403);
    const otherPdi = await fetch(new URL(`/infrastructures/${item.infraId}`, ddiBase), { headers: ownerHeaders(stranger) });
    assert.equal(otherPdi.status, 403);
    assert.equal((await grants(item.session, "active")).length, 0);
    const approved = await approve(item, requested.id, ["identity.currentActor"]);
    assert.equal(approved.status, 200);
    assert.equal(approved.body.status, "ACTIVE");
    assert.equal(approved.approvalBody, JSON.stringify({ oneTime: false }));
    const grantId = approved.body.authorityGrantRefs?.[0]?.grantId ?? "";
    const grant = await inspect(item.session, grantId);
    assert.equal(grant.status, "ACTIVE");
    assert.equal(grant.oneTime, false);
    assert.equal(grant.actorType, "app");
    assert.equal(grant.actorId, item.appId);
    assert.deepEqual(grant.actions, ["identity.currentActor"]);
    assert.deepEqual(grant.resources, [`ddi:pdi:${item.infraId}:identity.currentActor`]);
    assert.equal(grant.audience, "ddi");
    assert.equal((await grants(item.session, "active")).filter(entry => entry.actorId === item.appId).length, 1);
    const modes = ["APP", "SPACE", "APP"] as const;
    const executions = [];
    for (const [index, mode] of modes.entries()) {
      const token = await issue(item.session, grantId);
      const result = await execute(item, "identity.currentActor", token, `main-exec-${index + 1}`, mode);
      executions.push({ status: result.status, body: result.body.status, mode });
      assert.equal(result.status, 200);
      assert.equal(result.body.status, "COMPLETED");
    }
    const unapproved = await execute(item, "data.read", "not-a-token", "main-unapproved");
    assert.equal(unapproved.body.reason, "CAPABILITY_NOT_APPROVED");
    const revoked = await fetch(new URL(`/connections/${requested.id}/revoke`, ddiBase), { method: "POST", headers: ownerHeaders(item.session), body: "{}" });
    assert.equal(revoked.status, 200);
    assert.equal((await revoked.json() as { status: string }).status, "REVOKED");
    assert.equal((await inspect(item.session, grantId)).status, "REVOKED");
    const blockedToken = await issue(item.session, grantId).catch(() => "");
    const blocked = await execute(item, "identity.currentActor", blockedToken || "still-not-a-usable-token-value", "main-after-revoke");
    assert.equal(blocked.body.status, "DENIED");
    assert.equal(blocked.body.reason, "CONNECTION_NOT_ACTIVE");
    const snapshot = JSON.stringify(await repository.snapshot());
    assert.equal(snapshot.includes(item.session.sessionToken), false);
    assert.equal(snapshot.includes(item.session.assertion), false);
    assert.equal(snapshot.includes(item.secret), false);
    const audits = (await repository.snapshot()).audits.filter(entry => entry.connectionId === requested.id && entry.result === "COMPLETED");
    assert.equal(audits.length, 3);
    assert.deepEqual(audits.map(entry => entry.executionMode), ["APP", "SPACE", "APP"]);
    assert.equal(audits.every(entry => entry.grantId === grantId && entry.ownerId === item.session.ownerId && entry.applicationId === item.appId && entry.infrastructureId === item.infraId && entry.capability === "identity.currentActor"), true);
    console.log(`REUSABLE_PROOF ${JSON.stringify({ connectionId: requested.id, capability: "identity.currentActor", grantId, oneTime: grant.oneTime, status: grant.status, executions })}`);
  });

  test("capability revocation removes only that reusable grant", async () => {
    const item = await product("subject-reusable-cap", ["identity.currentActor", "data.read"]);
    const requested = await requestConnection(item, ["identity.currentActor", "data.read"], "cap-request");
    const approved = await approve(item, requested.id, ["identity.currentActor", "data.read"]);
    assert.equal(approved.body.status, "ACTIVE");
    const identity = approved.body.authorityGrantRefs?.find(entry => entry.capability === "identity.currentActor");
    const data = approved.body.authorityGrantRefs?.find(entry => entry.capability === "data.read");
    assert.ok(identity && data);
    assert.notEqual(identity.grantId, data.grantId);
    assert.equal((await inspect(item.session, identity.grantId)).oneTime, false);
    assert.equal((await inspect(item.session, data.grantId)).oneTime, false);
    const revoked = await fetch(new URL(`/connections/${requested.id}/capabilities/revoke`, ddiBase), { method: "POST", headers: ownerHeaders(item.session), body: JSON.stringify({ capabilities: ["identity.currentActor"] }) });
    const connection = await revoked.json() as { status: string; approvedCapabilities: string[] };
    assert.equal(connection.status, "ACTIVE");
    assert.deepEqual(connection.approvedCapabilities, ["data.read"]);
    assert.equal((await inspect(item.session, identity.grantId)).status, "REVOKED");
    assert.equal((await inspect(item.session, data.grantId)).status, "ACTIVE");
    const denied = await execute(item, "identity.currentActor", "revoked-capability-token-value", "cap-denied");
    assert.equal(denied.body.reason, "CAPABILITY_NOT_APPROVED");
    const eligible = await execute(item, "data.read", await issue(item.session, data.grantId), "cap-data");
    assert.equal(eligible.body.status, "CAPABILITY_UNAVAILABLE");
    assert.equal(eligible.body.reason, "PROVIDER_NOT_CONFIGURED");
    console.log(`REUSABLE_CAP ${JSON.stringify({ revoked: identity.grantId, kept: data.grantId, connection: connection.status })}`);
  });

  test("capability expansion creates a new reusable grant and preserves the original", async () => {
    const item = await product("subject-reusable-expand", ["identity.currentActor", "data.read"]);
    const requested = await requestConnection(item, ["identity.currentActor"], "expand-request");
    const approved = await approve(item, requested.id, ["identity.currentActor"]);
    const originalId = approved.body.authorityGrantRefs?.[0]?.grantId ?? "";
    const change = await fetch(new URL(`/connections/${requested.id}/capabilities/request`, ddiBase), { method: "POST", headers: { authorization: `Application ${item.secret}`, "content-type": "application/json" }, body: JSON.stringify({ capabilities: ["data.read"] }) });
    assert.equal((await change.json() as { status: string }).status, "REQUESTED_CHANGE");
    const expanded = await approve(item, requested.id, ["data.read"]);
    assert.equal(expanded.approvalBody, JSON.stringify({ oneTime: false }));
    const created = expanded.body.authorityGrantRefs?.find(entry => entry.capability === "data.read");
    const preserved = expanded.body.authorityGrantRefs?.find(entry => entry.capability === "identity.currentActor");
    assert.ok(created && preserved);
    assert.equal(preserved.grantId, originalId);
    assert.notEqual(created.grantId, originalId);
    assert.equal((await inspect(item.session, created.grantId)).oneTime, false);
    assert.equal((await inspect(item.session, originalId)).status, "ACTIVE");
    assert.equal((await grants(item.session, "active")).filter(entry => entry.actorId === item.appId && entry.actions.includes("identity.currentActor")).length, 1);
    console.log(`REUSABLE_EXPAND ${JSON.stringify({ original: originalId, created: created.grantId })}`);
  });

  test("reconnection creates a new reusable grant and leaves the revoked grant revoked", async () => {
    const item = await product("subject-reusable-reconnect", ["identity.currentActor"]);
    const requested = await requestConnection(item, ["identity.currentActor"], "reconnect-request");
    const approved = await approve(item, requested.id, ["identity.currentActor"]);
    const oldId = approved.body.authorityGrantRefs?.[0]?.grantId ?? "";
    const revoked = await fetch(new URL(`/connections/${requested.id}/revoke`, ddiBase), { method: "POST", headers: ownerHeaders(item.session), body: "{}" });
    assert.equal((await revoked.json() as { status: string }).status, "REVOKED");
    const again = await requestConnection(item, ["identity.currentActor"], "reconnect-again");
    assert.equal(again.status, "REQUESTED");
    const reapproved = await approve(item, again.id, ["identity.currentActor"]);
    const newId = reapproved.body.authorityGrantRefs?.[0]?.grantId ?? "";
    assert.equal(reapproved.body.status, "ACTIVE");
    assert.notEqual(newId, oldId);
    assert.equal((await inspect(item.session, oldId)).status, "REVOKED");
    assert.equal((await inspect(item.session, newId)).oneTime, false);
    assert.equal((await inspect(item.session, newId)).status, "ACTIVE");
    const result = await execute(item, "identity.currentActor", await issue(item.session, newId), "reconnect-exec");
    assert.equal(result.body.status, "COMPLETED");
    console.log(`REUSABLE_RECONNECT ${JSON.stringify({ oldId, newId, execution: result.body.status })}`);
  });

  test("a persistence failure after grant creation reuses the same reusable grant", async () => {
    const item = await product("subject-reusable-retry", ["identity.currentActor"]);
    const requested = await requestConnection(item, ["identity.currentActor"], "retry-request");
    let failed = false;
    const grants = new HttpDigiAuthorityGrantClient(authorityBase);
    const flaky = {
      async ensureGrant(input: { ownerId: string; actor: string; action: string; resource: string; audience: string; sessionToken?: string }) {
        const grant = await grants.ensureGrant(input);
        if (!failed) { failed = true; throw new Error("DDI_PERSIST_FAILED"); }
        return grant;
      },
      revokeGrant: (input: { ownerId: string; grantId: string; sessionToken?: string }) => grants.revokeGrant(input),
    };
    const consume = new HttpDigiAuthorityClient({ consumeUrl: `${authorityBase}/v1/authority/consume`, jwksUrl: `${authorityBase}/.well-known/authority-jwks.json`, verifierModuleUrl: pathToFileURL(join(trustRoot, "packages/authority-verifier/dist/index.js")).href });
    const flakyService = new DurableDdiService(repository, authorityVerifier(consume), defaultAdapters(async () => ({ subject: "subject-reusable" })), new HttpDigiSessionClient(authorityBase), flaky);
    await assert.rejects(() => flakyService.approveConnection(item.actor, requested.id, ["identity.currentActor"], "retry-fail", item.session.sessionToken), /DDI_PERSIST_FAILED/);
    assert.equal((await repository.getConnection(requested.id))?.status, "REQUESTED");
    const active = (await grantsForActor(item)).filter(entry => entry.status === "ACTIVE" && entry.oneTime === false);
    assert.equal(active.length, 1);
    const retried = await flakyService.approveConnection(item.actor, requested.id, ["identity.currentActor"], "retry-ok", item.session.sessionToken);
    assert.equal(retried.status, "ACTIVE");
    assert.equal(retried.authorityGrantRefs[0]?.grantId, active[0]?.id);
    assert.equal((await grantsForActor(item)).filter(entry => entry.status === "ACTIVE").length, 1);
    console.log(`REUSABLE_RETRY ${JSON.stringify({ grantId: active[0]?.id, connection: retried.status })}`);
  });

  async function grantsForActor(item: Product) {
    return (await grants(item.session, "active")).filter(entry => entry.actorId === item.appId);
  }

  test("eight simultaneous approvals create one connection and one reusable grant", async () => {
    const item = await product("subject-reusable-race", ["identity.currentActor"]);
    const requested = await requestConnection(item, ["identity.currentActor"], "race-request");
    const results = await Promise.all(Array.from({ length: 8 }, () => fetch(new URL(`/connections/${requested.id}/approve`, ddiBase), { method: "POST", headers: ownerHeaders(item.session), body: JSON.stringify({ capabilities: ["identity.currentActor"] }) })));
    const bodies = await Promise.all(results.map(async response => ({ status: response.status, body: await response.json() as { status?: string; authorityGrantRefs?: { grantId: string }[]; code?: string } })));
    assert.equal(bodies.every(entry => entry.status === 200 && entry.body.status === "ACTIVE"), true);
    const ids = new Set(bodies.map(entry => entry.body.authorityGrantRefs?.[0]?.grantId));
    assert.equal(ids.size, 1);
    const grantId = [...ids][0] ?? "";
    assert.equal((await inspect(item.session, grantId)).oneTime, false);
    assert.equal((await grantsForActor(item)).length, 1);
    const rows = await pool.query<{ n: string }>(`SELECT count(*)::text AS n FROM ddi_connections WHERE id = $1 AND status = 'ACTIVE'`, [requested.id]);
    assert.equal(rows.rows[0]?.n, "1");
    console.log(`REUSABLE_RACE ${JSON.stringify({ grantId, connections: 1, grants: 1 })}`);
  });

  test("Authority still creates a one-time grant when oneTime is omitted", async () => {
    const session = await exchange("subject-reusable-onetime");
    const headers = ownerHeaders(session);
    const binding = { actor: "app:app:onetime-regression", action: "identity.currentActor", resource: "ddi:pdi:infra:onetime:identity.currentActor", audience: "ddi" };
    const checked = await fetch(new URL("/authority/check", authorityBase), { method: "POST", headers, body: JSON.stringify({ ...binding, ownerId: session.ownerId }) });
    const decision = await checked.json() as { decision: string; requestId?: string };
    assert.equal(decision.decision, "ASK_OWNER");
    const approved = await fetch(new URL(`/authority/requests/${decision.requestId}/approve`, authorityBase), { method: "POST", headers: { authorization: headers.authorization, "content-type": "application/json" } });
    const created = await approved.json() as { grantId: string; oneTime: boolean };
    assert.equal(created.oneTime, true);
    const grant = await inspect(session, created.grantId);
    assert.equal(grant.oneTime, true);
    const token = await issue(session, created.grantId);
    const first = await fetch(new URL("/authority/use", authorityBase), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token, ...binding }) });
    const second = await fetch(new URL("/authority/use", authorityBase), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token, ...binding }) });
    assert.equal(first.status, 200);
    assert.equal(second.status, 403);
    assert.equal((await second.json() as { reason: string }).reason, "replay");
    console.log(`REUSABLE_ONETIME ${JSON.stringify({ grantId: created.grantId, oneTime: created.oneTime, replay: second.status })}`);
  });

  test("DDI cannot obtain a reusable grant outside the approved connection binding", async () => {
    const item = await product("subject-reusable-negative", ["identity.currentActor"]);
    const requested = await requestConnection(item, ["identity.currentActor"], "negative-request");
    const before = (await grants(item.session, "active")).length;
    const client = new HttpDigiAuthorityGrantClient(authorityBase);
    const base = { ownerId: item.session.ownerId, actor: `app:${item.appId}`, action: "identity.currentActor", resource: `ddi:pdi:${item.infraId}:identity.currentActor`, audience: "ddi", sessionToken: item.session.sessionToken };
    await assert.rejects(() => client.ensureGrant({ ...base, ownerId: "own_wrong" }), /AUTHORITY_GRANT_UNAVAILABLE/);
    await assert.rejects(() => client.ensureGrant({ ...base, actor: "human:stranger" }), /AUTHORITY_GRANT_UNAVAILABLE/);
    await assert.rejects(() => client.ensureGrant({ ...base, resource: "owner:other-pdi" }), /AUTHORITY_GRANT_UNAVAILABLE/);
    await assert.rejects(() => client.ensureGrant({ ...base, audience: "not-ddi" }), /AUTHORITY_GRANT_UNAVAILABLE/);
    await assert.rejects(() => client.ensureGrant({ ...base, action: "payment.approve", resource: "payment:approve" }), /AUTHORITY_GRANT_UNAVAILABLE/);
    assert.equal((await grants(item.session, "active")).length, before);
    assert.equal((await repository.getConnection(requested.id))?.status, "REQUESTED");
  });

  test("failure cases stay closed and do not activate a one-time grant", async () => {
    const item = await product("subject-reusable-failure", ["identity.currentActor", "data.read"]);
    const requested = await requestConnection(item, ["identity.currentActor"], "failure-request");
    const closed = createServer();
    await new Promise<void>(resolve => closed.listen(0, "127.0.0.1", () => resolve()));
    const closedBase = `http://127.0.0.1:${(closed.address() as { port: number }).port}`;
    await new Promise<void>(resolve => closed.close(() => resolve()));
    const down = new DurableDdiService(repository, authorityVerifier(new HttpDigiAuthorityClient({ consumeUrl: `${authorityBase}/v1/authority/consume`, jwksUrl: `${authorityBase}/.well-known/authority-jwks.json`, verifierModuleUrl: pathToFileURL(join(trustRoot, "packages/authority-verifier/dist/index.js")).href })), defaultAdapters(async () => null), new HttpDigiSessionClient(authorityBase), new HttpDigiAuthorityGrantClient(closedBase));
    await assert.rejects(() => down.approveConnection(item.actor, requested.id, ["identity.currentActor"], "failure-down", item.session.sessionToken), /AUTHORITY_GRANT_UNAVAILABLE/);
    assert.equal((await repository.getConnection(requested.id))?.status, "REQUESTED");
    const stub = await stubAuthority();
    const stubClient = new HttpDigiAuthorityGrantClient(stub.base);
    const stubService = new DurableDdiService(repository, async () => ({ ok: false, reason: "MISSING" as const }), defaultAdapters(async () => null), new HttpDigiSessionClient(authorityBase), stubClient);
    stub.setMode("one-time");
    await assert.rejects(() => stubService.approveConnection(item.actor, requested.id, ["identity.currentActor"], "failure-onetime", item.session.sessionToken), /AUTHORITY_GRANT_NOT_REUSABLE/);
    stub.setMode("malformed");
    await assert.rejects(() => stubService.approveConnection(item.actor, requested.id, ["identity.currentActor"], "failure-malformed", item.session.sessionToken), /AUTHORITY_GRANT_UNAVAILABLE/);
    assert.equal((await repository.getConnection(requested.id))?.status, "REQUESTED");
    const approved = await approve(item, requested.id, ["identity.currentActor"]);
    assert.equal(approved.body.status, "ACTIVE");
    const grantId = approved.body.authorityGrantRefs?.[0]?.grantId ?? "";
    const failingRevoke = { async ensureGrant(input: { ownerId: string; actor: string; action: string; resource: string; audience: string; sessionToken?: string }) { return new HttpDigiAuthorityGrantClient(authorityBase).ensureGrant(input); }, async revokeGrant() { throw new Error("AUTHORITY_GRANT_UNAVAILABLE"); } };
    const revokeService = new DurableDdiService(repository, async () => ({ ok: false, reason: "MISSING" as const }), defaultAdapters(async () => null), new HttpDigiSessionClient(authorityBase), failingRevoke);
    await assert.rejects(() => revokeService.revokeConnection(item.actor, requested.id, "failure-revoke", item.session.sessionToken), /AUTHORITY_GRANT_UNAVAILABLE/);
    assert.equal((await repository.getConnection(requested.id))?.status, "ACTIVE");
    assert.equal((await inspect(item.session, grantId)).status, "ACTIVE");
    await stub.close();
    const broken = { getInfrastructure() { throw new Error("down"); }, getApplication() { throw new Error("down"); }, listConnections() { throw new Error("down"); }, findBinding() { throw new Error("down"); }, insertAudit() { throw new Error("down"); } };
    const isolated = new DurableDdiService(broken as never, async () => ({ ok: false, reason: "MISSING" }), new Map(), undefined, undefined);
    const stored = await isolated.execute({ infrastructureId: item.infraId as CapabilityRequest["infrastructureId"], applicationId: item.appId as CapabilityRequest["applicationId"], capability: "identity.currentActor", action: "identity.currentActor", resource: "ddi:pdi:x:identity.currentActor", audience: "ddi", correlationId: "storage-down" });
    assert.equal(stored.status, "FAILED");
    assert.equal(stored.reason, "STORAGE_UNAVAILABLE");
  });
});

function stubAuthority() {
  let mode: "one-time" | "malformed" = "one-time";
  const server = createServer((request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    const url = request.url ?? "";
    if (url === "/authority/grants/active") response.end(JSON.stringify({ grants: [] }));
    else if (url === "/authority/check") response.end(JSON.stringify({ decision: "ASK_OWNER", requestId: "req-stub" }));
    else if (mode === "malformed") response.end(JSON.stringify({ grantId: "auth_malformed" }));
    else response.end(JSON.stringify({ grantId: "auth_onetime", oneTime: true }));
  });
  return new Promise<{ base: string; close(): Promise<void>; setMode(value: "one-time" | "malformed"): void }>(resolve => {
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as { port: number }).port;
      resolve({ base: `http://127.0.0.1:${port}`, close: () => new Promise(done => server.close(() => done())), setMode(value) { mode = value; } });
    });
  });
}
