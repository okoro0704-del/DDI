import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { Actor, CapabilityRequest, CapabilityResult } from "../packages/contracts/src/index.ts";
import { buildApi, resultStatus, routeInventory, type DdiApiService } from "../apps/api/src/app.ts";
import { readConfig } from "../packages/service/src/config.ts";
import { composeRuntime } from "../apps/api/src/compose.ts";
import { HttpDigiAuthorityClient, HttpDigiAuthorityGrantClient } from "../packages/service/src/digi.ts";
import { HttpDigiSessionClient } from "../packages/service/src/digi.ts";

const owner: Actor = { ownerId: "own_api" as Actor["ownerId"], kind: "HUMAN", verified: true };
const config = readConfig({ DDI_ENV: "test", DDI_ALLOWED_ORIGINS: "https://app.example.test" });

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

test("production composition fails closed without postgres or digi configuration", async () => {
  assert.throws(() => readConfig({ DDI_ENV: "production" }), /DDI_PRODUCTION_CONFIGURATION_INVALID/);
  assert.throws(() => readConfig({ DDI_ENV: "production", DATABASE_URL: "postgres://127.0.0.1/ddi", TRUSTID_ISSUER: "https://issuer.test", TRUSTID_AUDIENCE: "aud", TRUSTID_JWKS_URL: "https://issuer.test/jwks", DDI_ALLOWED_ORIGINS: "https://app.example.test" }), /DDI_PRODUCTION_CONFIGURATION_INVALID/);
  await assert.rejects(composeRuntime({ DDI_ENV: "production", DATABASE_URL: "postgres://127.0.0.1:1/ddi", TRUSTID_ISSUER: "https://issuer.test", TRUSTID_AUDIENCE: "aud", TRUSTID_JWKS_URL: "https://issuer.test/jwks", DDI_ALLOWED_ORIGINS: "https://app.example.test", DIGI_CORE_URL: "http://127.0.0.1:9", DIGI_AUTHORITY_URL: "http://127.0.0.1:9", DIGI_AUTHORITY_JWKS_URL: "http://127.0.0.1:9/jwks" }), /DDI_POSTGRES_UNAVAILABLE/);
});

test("session and authority clients fail closed and do not consume a rejected token", async () => {
  const sessionServer = createServer((request, response) => {
    if (request.headers.authorization === "Bearer good") { response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify({ ownerId: "own_from_digi", sessionId: "ses_1" })); return; }
    response.writeHead(401).end();
  });
  await new Promise<void>(resolve => sessionServer.listen(0, "127.0.0.1", resolve));
  const sessionPort = (sessionServer.address() as { port: number }).port;
  const sessions = new HttpDigiSessionClient(`http://127.0.0.1:${sessionPort}`);
  assert.equal((await sessions.resolve("good"))?.ownerId, "own_from_digi");
  assert.equal(await sessions.resolve("bad"), null);
  await new Promise(resolve => sessionServer.close(resolve));

  let consumeHits = 0;
  const authorityServer = createServer((_request, response) => { consumeHits += 1; response.writeHead(200).end(JSON.stringify({ decision: "ALLOW", grantId: "grant:http" })); });
  await new Promise<void>(resolve => authorityServer.listen(0, "127.0.0.1", resolve));
  const authorityPort = (authorityServer.address() as { port: number }).port;
  const client = new HttpDigiAuthorityClient({ consumeUrl: `http://127.0.0.1:${authorityPort}/v1/authority/consume`, jwksUrl: "http://127.0.0.1/jwks", verifierModuleUrl: new URL("./fixtures/verifier-stub.mjs", import.meta.url).href });
  const rejected = await client.consume({ token: "mismatch", audience: "ddi", actor: "human:api", action: "identity.currentActor", resource: "infrastructure:1", ownerId: "own_other" });
  assert.equal(rejected.ok, false);
  if (!rejected.ok) assert.equal(rejected.reason, "WRONG_RESOURCE");
  assert.equal(consumeHits, 0);
  const allowed = await client.consume({ token: "allow", audience: "ddi", actor: "human:api", action: "identity.currentActor", resource: "infrastructure:1", ownerId: "own_from_digi" });
  assert.equal(allowed.ok, true);
  assert.equal(consumeHits, 1);
  await new Promise(resolve => authorityServer.close(resolve));
});

test("authority grant client reuses an active grant and does not mint a second one", async () => {
  const hits: string[] = [];
  const server = createServer((request, response) => {
    hits.push(`${request.method} ${request.url}`);
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ grants: [{ id: "auth_existing", actorType: "app", actorId: "app:1", actions: ["identity.currentActor"], resources: ["ddi:pdi:infra:1:identity.currentActor"], audience: "ddi", status: "ACTIVE", oneTime: false }] }));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  const client = new HttpDigiAuthorityGrantClient(`http://127.0.0.1:${port}`);
  const grant = await client.ensureGrant({ ownerId: "own_api", actor: "app:app:1", action: "identity.currentActor", resource: "ddi:pdi:infra:1:identity.currentActor", audience: "ddi", sessionToken: "session-token" });
  assert.equal(grant.grantId, "auth_existing");
  assert.deepEqual(hits, ["GET /authority/grants/active"]);
  await new Promise(resolve => server.close(resolve));
});

test("PDI approval asks Authority for a reusable grant and rejects a one-time result", async () => {
  const bodies: string[] = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", chunk => chunks.push(chunk));
    request.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      response.writeHead(200, { "content-type": "application/json" });
      if (request.url === "/authority/grants/active") response.end(JSON.stringify({ grants: [] }));
      else if (request.url === "/authority/check") response.end(JSON.stringify({ decision: "ASK_OWNER", requestId: "req-reusable" }));
      else if (request.url === "/authority/requests/req-reusable/approve") { bodies.push(raw); response.end(JSON.stringify({ grantId: "auth_reusable", oneTime: false })); }
      else response.end("{}");
    });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  const client = new HttpDigiAuthorityGrantClient(`http://127.0.0.1:${port}`);
  const grant = await client.ensureGrant({ ownerId: "own_api", actor: "app:app:1", action: "identity.currentActor", resource: "ddi:pdi:infra:1:identity.currentActor", audience: "ddi", sessionToken: "session-token" });
  assert.equal(grant.grantId, "auth_reusable");
  assert.deepEqual(bodies, [JSON.stringify({ oneTime: false })]);
  await new Promise(resolve => server.close(resolve));
});

test("a one-time or malformed Authority approval does not become a PDI grant", async () => {
  const mode = { value: "one-time" as "one-time" | "malformed" | "once-listed" };
  const hits: string[] = [];
  const server = createServer((request, response) => {
    hits.push(`${request.method} ${request.url}`);
    response.writeHead(200, { "content-type": "application/json" });
    if (request.url === "/authority/grants/active") response.end(JSON.stringify({ grants: mode.value === "once-listed" ? [{ id: "auth_once", actorType: "app", actorId: "app:1", actions: ["identity.currentActor"], resources: ["ddi:pdi:infra:1:identity.currentActor"], audience: "ddi", status: "ACTIVE", oneTime: true }] : [] }));
    else if (request.url === "/authority/check") response.end(JSON.stringify(mode.value === "once-listed" ? { decision: "DENY" } : { decision: "ASK_OWNER", requestId: "req-bad" }));
    else if (mode.value === "malformed") response.end(JSON.stringify({ grantId: "auth_bad" }));
    else response.end(JSON.stringify({ grantId: "auth_bad", oneTime: true }));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  const client = new HttpDigiAuthorityGrantClient(`http://127.0.0.1:${port}`);
  const input = { ownerId: "own_api", actor: "app:app:1", action: "identity.currentActor", resource: "ddi:pdi:infra:1:identity.currentActor", audience: "ddi", sessionToken: "session-token" };
  await assert.rejects(() => client.ensureGrant(input), /AUTHORITY_GRANT_NOT_REUSABLE/);
  mode.value = "malformed";
  await assert.rejects(() => client.ensureGrant(input), /AUTHORITY_GRANT_UNAVAILABLE/);
  mode.value = "once-listed";
  hits.length = 0;
  await assert.rejects(() => client.ensureGrant(input), /AUTHORITY_GRANT_UNAVAILABLE/);
  assert.equal(hits.includes("GET /authority/grants/active"), true);
  assert.equal(hits.includes("POST /authority/check"), true);
  await new Promise(resolve => server.close(resolve));
  const closed = createServer();
  await new Promise<void>(resolve => closed.listen(0, "127.0.0.1", () => resolve()));
  const closedBase = `http://127.0.0.1:${(closed.address() as { port: number }).port}`;
  await new Promise<void>(resolve => closed.close(() => resolve()));
  await assert.rejects(() => new HttpDigiAuthorityGrantClient(closedBase).ensureGrant(input), /AUTHORITY_GRANT_UNAVAILABLE/);
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
