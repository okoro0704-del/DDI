import test from "node:test";
import { generateKeyPairSync } from "node:crypto";
import assert from "node:assert/strict";
import type { Actor, CapabilityRequest, CapabilityResult } from "../packages/contracts/src/index.ts";
import { buildApi, resultStatus, routeInventory, type DdiApiService } from "../apps/api/src/app.ts";
import { readConfig } from "../packages/service/src/config.ts";
import { composeRuntime } from "../apps/api/src/compose.ts";
import { HttpDigiAuthorityClient, HttpDigiAuthorityGrantClient } from "../packages/service/src/digi.ts";
import { HttpDigiSessionClient } from "../packages/service/src/digi.ts";

const owner: Actor = { ownerId: "own_api" as Actor["ownerId"], kind: "HUMAN", verified: true };
const config = readConfig({ DDI_ENV: "test", DDI_ALLOWED_ORIGINS: "https://app.example.test" });
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
const urlOf = (input: URL | string) => new URL(String(input));

function fake(execute: DdiApiService["execute"] = async () => ({ status: "COMPLETED", correlationId: "c1" })): DdiApiService & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async authenticate(token) { calls.push("authenticate"); return token === "session" ? owner : null; },
    async provision(actor, input) { calls.push("provision"); return { id: "infra:1" as never, ownerId: actor.ownerId, type: input.type, status: "ACTIVE", applicationIds: [], primitiveBindingIds: [], relationshipIds: [], createdAt: "", updatedAt: "", metadata: {} }; },
    async authenticateApplication(secret) { calls.push("authenticateApplication"); return secret === "app-secret" ? { id: "app:1" as never, infrastructureId: "infra:1" as never, displayName: "App", type: "WEB", status: "ACTIVE", requestedCapabilities: ["identity.currentActor"], grantedCapabilities: [], createdAt: "", updatedAt: "" } : null; },
    async findPersonal() { calls.push("findPersonal"); return null; },
    async registerApp() { calls.push("registerApp"); return { id: "app:1", grantedCapabilities: [], applicationCredential: "app-secret" }; },
    async requestConnection() { calls.push("requestConnection"); return { id: "connection:1" as never, infrastructureId: "infra:1" as never, applicationId: "app:1" as never, ownerId: owner.ownerId, status: "REQUESTED" as const, requestedCapabilities: ["identity.currentActor" as const], approvedCapabilities: [], pendingCapabilities: [], authorityGrantRefs: [], revision: 1, createdAt: "", updatedAt: "" }; },
    async requestCapabilityChange() { calls.push("requestCapabilityChange"); return { id: "connection:1" as never, infrastructureId: "infra:1" as never, applicationId: "app:1" as never, ownerId: owner.ownerId, status: "REQUESTED_CHANGE" as const, requestedCapabilities: [], approvedCapabilities: [], pendingCapabilities: ["data.read" as const], authorityGrantRefs: [], revision: 2, createdAt: "", updatedAt: "" }; },
    async approveConnection() { calls.push("approveConnection"); return { id: "connection:1" as never, infrastructureId: "infra:1" as never, applicationId: "app:1" as never, ownerId: owner.ownerId, status: "ACTIVE" as const, requestedCapabilities: [], approvedCapabilities: ["identity.currentActor" as const], pendingCapabilities: [], authorityGrantRefs: [], revision: 2, createdAt: "", updatedAt: "" }; },
    async revokeConnection() { calls.push("revokeConnection"); return { id: "connection:1" as never, infrastructureId: "infra:1" as never, applicationId: "app:1" as never, ownerId: owner.ownerId, status: "REVOKED" as const, requestedCapabilities: [], approvedCapabilities: [], pendingCapabilities: [], authorityGrantRefs: [], revision: 3, createdAt: "", updatedAt: "" }; },
    async revokeCapabilities() { calls.push("revokeCapabilities"); return { id: "connection:1" as never, infrastructureId: "infra:1" as never, applicationId: "app:1" as never, ownerId: owner.ownerId, status: "ACTIVE" as const, requestedCapabilities: [], approvedCapabilities: [], pendingCapabilities: [], authorityGrantRefs: [], revision: 4, createdAt: "", updatedAt: "" }; },
    async getConnection() { calls.push("getConnection"); return { id: "connection:1" as never, infrastructureId: "infra:1" as never, applicationId: "app:1" as never, ownerId: owner.ownerId, status: "REQUESTED" as const, requestedCapabilities: ["identity.currentActor" as const], approvedCapabilities: [], pendingCapabilities: [], authorityGrantRefs: [], revision: 1, createdAt: "", updatedAt: "" }; },
    async listConnections() { calls.push("listConnections"); return []; },
    async getInfrastructure() { calls.push("getInfrastructure"); return { id: "infra:1" as never, ownerId: owner.ownerId, type: "PERSONAL", status: "ACTIVE", applicationIds: [], primitiveBindingIds: [], relationshipIds: [], createdAt: "", updatedAt: "", metadata: {} }; },
    async view() { calls.push("view"); return { apps: [], infrastructure: { id: "infra:1" } }; },
    execute: async (request) => { calls.push("execute"); return execute(request); },
  };
}

test("route inventory keeps authority on primitive execution only", async () => {
  const service = fake();
  const app = buildApi({ service, config, database: async () => "UP" });
  const printed = app.printRoutes({ commonPrefix: false });
  for (const fragment of ["/health (GET", "/infrastructures (POST)", "/me/pdi (GET", "/connections (POST,", "/approve (POST)", "/capabilities/execute (POST)", "/:appId/grants (POST)"]) assert.match(printed, new RegExp(fragment.replace(/[()]/g, "\\$&")));
  assert.equal(routeInventory.filter(route => route.access === "AUTHORITY_ENFORCED").map(route => route.url).join(), "/capabilities/execute");
  assert.equal(routeInventory.find(route => route.url.endsWith("/grants"))?.access, "RETIRED_CONSENT_BYPASS");
  const health = await app.inject({ method: "GET", url: "/health" });
  assert.equal(health.statusCode, 200);
  assert.equal(health.json().status, "HEALTHY");
  assert.equal(health.json().database.status, "UP");
  const options = await app.inject({ method: "OPTIONS", url: "/capabilities/execute", headers: { origin: "https://app.example.test" } });
  assert.equal(options.statusCode, 204);
  const provision = await app.inject({ method: "POST", url: "/infrastructures", headers: { authorization: "Bearer session", "idempotency-key": "k1" }, payload: { type: "PERSONAL" } });
  assert.equal(provision.statusCode, 200);
  assert.equal(service.calls.includes("execute"), false);
  const granted = await app.inject({ method: "POST", url: "/infrastructures/infra:1/apps/app:1/grants", headers: { authorization: "Bearer session" }, payload: { capabilities: ["identity.currentActor"] } });
  assert.equal(granted.statusCode, 403);
  assert.equal(granted.json().code, "CONSENT_ROUTE_RETIRED");
  const lookup = await app.inject({ method: "GET", url: "/me/pdi", headers: { authorization: "Bearer session" } });
  assert.equal(lookup.json().state, "NOT_PROVISIONED");
  const requested = await app.inject({ method: "POST", url: "/infrastructures/infra:1/connections", headers: { authorization: "Application app-secret", "idempotency-key": "conn-1" }, payload: { capabilities: ["identity.currentActor"] } });
  assert.equal(requested.statusCode, 200);
  assert.equal(requested.json().status, "REQUESTED");
  assert.match(requested.json().requested[0].description, /Digi owner/);
  const selfApproval = await app.inject({ method: "POST", url: "/connections/connection:1/approve", headers: { authorization: "Application app-secret" }, payload: { capabilities: ["identity.currentActor"] } });
  assert.equal(selfApproval.statusCode, 401);
  assert.equal(service.calls.includes("approveConnection"), false);
  assert.equal(service.calls.includes("execute"), false);
  await app.close();
});

test("execute uses the canonical pipeline and truthful statuses", async () => {
  const seen: CapabilityRequest[] = [];
  const statuses: CapabilityResult["status"][] = ["COMPLETED", "AUTHENTICATION_REQUIRED", "DENIED", "FAILED", "CAPABILITY_UNAVAILABLE"];
  let index = 0;
  const service = fake(async request => { seen.push(request); return { status: statuses[index++] ?? "FAILED", correlationId: request.correlationId, reason: "SAMPLE" }; });
  const app = buildApi({ service, config });
  const headers = { authorization: "Application app-secret" };
  const payload = { capability: "identity.currentActor", authorityToken: "authority-token", executionMode: "SPACE", payload: { assertion: "secret-assertion" } };
  for (const status of statuses) {
    const response = await app.inject({ method: "POST", url: "/capabilities/execute", headers, payload });
    assert.equal(response.statusCode, resultStatus(status));
    assert.equal(response.json().status, status);
  }
  assert.equal(seen[0]?.executionMode, "SPACE");
  assert.equal(seen[0]?.actor?.ownerId, owner.ownerId);
  assert.equal(seen[0]?.actor?.authorityActor, "app:app:1");
  assert.equal(seen[0]?.applicationId, "app:1");
  assert.equal(seen[0]?.authority?.token, "authority-token");
  assert.equal(JSON.stringify(seen[0]?.payload).includes("secret-assertion"), true);
  assert.equal(app.printRoutes().includes("identityCurrentActor"), false);
  const anonymous = await app.inject({ method: "POST", url: "/capabilities/execute", payload });
  assert.equal(anonymous.statusCode, 401);
  await app.close();
});

/** D3C-C: production requires DDI's own service identity. An ephemeral in-memory key, never persisted, only completes the config. */
const ephemeralDdiIdentity = () => ({ DDI_SERVICE_ID: "ddi", DDI_SERVICE_KEY_ID: "ci-ephemeral-ddi", DDI_SERVICE_PRIVATE_KEY: generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" }).toString() });

test("production composition fails closed without postgres or digi configuration", async () => {
  assert.throws(() => readConfig({ DDI_ENV: "production" }), /DDI_PRODUCTION_CONFIGURATION_INVALID/);
  assert.throws(() => readConfig({ DDI_ENV: "production", DATABASE_URL: "postgres://127.0.0.1/ddi", TRUSTID_ISSUER: "https://issuer.test", TRUSTID_AUDIENCE: "aud", TRUSTID_JWKS_URL: "https://issuer.test/jwks", DDI_ALLOWED_ORIGINS: "https://app.example.test" }), /DDI_PRODUCTION_CONFIGURATION_INVALID/);
  await assert.rejects(composeRuntime({ DDI_ENV: "production", DATABASE_URL: "postgres://127.0.0.1:1/ddi", TRUSTID_ISSUER: "https://issuer.test", TRUSTID_AUDIENCE: "aud", TRUSTID_JWKS_URL: "https://issuer.test/jwks", TRUSTID_BRIDGE_MODULE_URL: new URL("./fixtures/verifier-stub.mjs", import.meta.url).href, DDI_ALLOWED_ORIGINS: "https://app.example.test", DIGI_CORE_URL: "http://127.0.0.1:9", DIGI_AUTHORITY_URL: "http://127.0.0.1:9", DIGI_AUTHORITY_JWKS_URL: "http://127.0.0.1:9/jwks", DIGI_AUTHORITY_VERIFIER_MODULE_URL: new URL("./fixtures/verifier-stub.mjs", import.meta.url).href, PORTAL_OWNERSHIP_URL: "https://portal.example.test/internal/ddi/ownership/verify", PORTAL_OWNERSHIP_SHARED_SECRET: "test-only-shared-secret", ...ephemeralDdiIdentity() }), /DDI_POSTGRES_UNAVAILABLE/);
});

test("session and authority clients fail closed and do not consume a rejected token", async () => {
  const sessions = new HttpDigiSessionClient("http://digi.test", async (_input, init) => new Headers(init?.headers).get("authorization") === "Bearer good" ? json({ ownerId: "own_from_digi", sessionId: "ses_1" }) : new Response(null, { status: 401 }));
  assert.equal((await sessions.resolve("good"))?.ownerId, "own_from_digi");
  assert.equal(await sessions.resolve("bad"), null);

  let consumeHits = 0;
  const client = new HttpDigiAuthorityClient({ consumeUrl: "http://authority.test/v1/authority/consume", jwksUrl: "http://authority.test/jwks", verifierModuleUrl: new URL("./fixtures/verifier-stub.mjs", import.meta.url).href }, async (input, init) => { assert.equal(urlOf(input).pathname, "/v1/authority/consume"); assert.equal(init?.method, "POST"); consumeHits += 1; return json({ decision: "ALLOW", grantId: "grant:http" }); });
  const rejected = await client.consume({ token: "mismatch", audience: "ddi", actor: "human:api", action: "identity.currentActor", resource: "infrastructure:1", ownerId: "own_other" });
  assert.equal(rejected.ok, false);
  if (!rejected.ok) assert.equal(rejected.reason, "WRONG_RESOURCE");
  assert.equal(consumeHits, 0);
  const allowed = await client.consume({ token: "allow", audience: "ddi", actor: "human:api", action: "identity.currentActor", resource: "infrastructure:1", ownerId: "own_from_digi" });
  assert.equal(allowed.ok, true);
  assert.equal(consumeHits, 1);
});

test("authority grant client reuses an active grant and does not mint a second one", async () => {
  const hits: string[] = [];
  const client = new HttpDigiAuthorityGrantClient("http://authority.test", async (input, init) => { hits.push(`${init?.method ?? "GET"} ${urlOf(input).pathname}`); return json({ grants: [{ id: "auth_existing", actorType: "app", actorId: "app:1", actions: ["identity.currentActor"], resources: ["ddi:pdi:infra:1:identity.currentActor"], audience: "ddi", status: "ACTIVE", oneTime: false }] }); });
  const grant = await client.ensureGrant({ ownerId: "own_api", actor: "app:app:1", action: "identity.currentActor", resource: "ddi:pdi:infra:1:identity.currentActor", audience: "ddi", sessionToken: "session-token" });
  assert.equal(grant.grantId, "auth_existing");
  assert.deepEqual(hits, ["GET /authority/grants/active"]);
});

test("PDI approval asks Authority for a reusable grant and rejects a one-time result", async () => {
  const bodies: string[] = [];
  const client = new HttpDigiAuthorityGrantClient("http://authority.test", async (input, init) => {
    const path = urlOf(input).pathname;
    if (path === "/authority/grants/active") return json({ grants: [] });
    if (path === "/authority/check") return json({ decision: "ASK_OWNER", requestId: "req-reusable" });
    if (path === "/authority/requests/req-reusable/approve") { bodies.push(String(init?.body)); return json({ grantId: "auth_reusable", oneTime: false }); }
    return json({});
  });
  const grant = await client.ensureGrant({ ownerId: "own_api", actor: "app:app:1", action: "identity.currentActor", resource: "ddi:pdi:infra:1:identity.currentActor", audience: "ddi", sessionToken: "session-token" });
  assert.equal(grant.grantId, "auth_reusable");
  assert.deepEqual(bodies, [JSON.stringify({ oneTime: false })]);
});

test("a one-time or malformed Authority approval does not become a PDI grant", async () => {
  const mode = { value: "one-time" as "one-time" | "malformed" | "once-listed" };
  const hits: string[] = [];
  const responder = async (input: URL | string, init?: RequestInit) => {
    const path = urlOf(input).pathname;
    hits.push(`${init?.method ?? "GET"} ${path}`);
    if (path === "/authority/grants/active") return json({ grants: mode.value === "once-listed" ? [{ id: "auth_once", actorType: "app", actorId: "app:1", actions: ["identity.currentActor"], resources: ["ddi:pdi:infra:1:identity.currentActor"], audience: "ddi", status: "ACTIVE", oneTime: true }] : [] });
    if (path === "/authority/check") return json(mode.value === "once-listed" ? { decision: "DENY" } : { decision: "ASK_OWNER", requestId: "req-bad" });
    return json(mode.value === "malformed" ? { grantId: "auth_bad" } : { grantId: "auth_bad", oneTime: true });
  };
  const client = new HttpDigiAuthorityGrantClient("http://authority.test", responder);
  const input = { ownerId: "own_api", actor: "app:app:1", action: "identity.currentActor", resource: "ddi:pdi:infra:1:identity.currentActor", audience: "ddi", sessionToken: "session-token" };
  await assert.rejects(() => client.ensureGrant(input), /AUTHORITY_GRANT_NOT_REUSABLE/);
  mode.value = "malformed";
  await assert.rejects(() => client.ensureGrant(input), /AUTHORITY_GRANT_UNAVAILABLE/);
  mode.value = "once-listed";
  hits.length = 0;
  await assert.rejects(() => client.ensureGrant(input), /AUTHORITY_GRANT_UNAVAILABLE/);
  assert.equal(hits.includes("GET /authority/grants/active"), true);
  assert.equal(hits.includes("POST /authority/check"), true);
  await assert.rejects(() => new HttpDigiAuthorityGrantClient("http://authority.test", async () => { throw new Error("network unavailable"); }).ensureGrant(input), /AUTHORITY_GRANT_UNAVAILABLE/);
});

test("an unexpected one-time grant is an integration failure at the HTTP boundary", async () => {
  const service = fake();
  service.approveConnection = async () => { throw new Error("AUTHORITY_GRANT_NOT_REUSABLE"); };
  const failing = buildApi({ service, config });
  const response = await failing.inject({ method: "POST", url: "/connections/connection:1/approve", headers: { authorization: "Bearer session", "content-type": "application/json" }, payload: { capabilities: ["identity.currentActor"] } });
  assert.equal(response.statusCode, 503);
  assert.equal(response.json().code, "AUTHORITY_GRANT_NOT_REUSABLE");
  await failing.close();
});
