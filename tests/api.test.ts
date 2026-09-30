import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { Actor, CapabilityRequest, CapabilityResult } from "../packages/contracts/src/index.ts";
import { buildApi, resultStatus, routeInventory, type DdiApiService } from "../apps/api/src/app.ts";
import { readConfig } from "../packages/service/src/config.ts";
import { composeRuntime } from "../apps/api/src/compose.ts";
import { HttpDigiAuthorityClient } from "../packages/service/src/digi.ts";
import { HttpDigiSessionClient } from "../packages/service/src/digi.ts";

const owner: Actor = { ownerId: "own_api" as Actor["ownerId"], kind: "HUMAN", verified: true };
const config = readConfig({ DDI_ENV: "test", DDI_ALLOWED_ORIGINS: "https://app.example.test" });

function fake(execute: DdiApiService["execute"] = async () => ({ status: "COMPLETED", correlationId: "c1" })): DdiApiService & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async authenticate(token) { calls.push("authenticate"); return token === "session" ? owner : null; },
    async provision(actor, input) { calls.push("provision"); return { id: "infra:1" as never, ownerId: actor.ownerId, type: input.type, status: "ACTIVE", applicationIds: [], primitiveBindingIds: [], relationshipIds: [], createdAt: "", updatedAt: "", metadata: {} }; },
    async registerApp() { calls.push("registerApp"); return { id: "app:1", grantedCapabilities: [] }; },
    async grantCapabilities() { calls.push("grantCapabilities"); return { id: "app:1", grantedCapabilities: ["identity.currentActor"] }; },
    async getInfrastructure() { calls.push("getInfrastructure"); return { id: "infra:1" as never, ownerId: owner.ownerId, type: "PERSONAL", status: "ACTIVE", applicationIds: [], primitiveBindingIds: [], relationshipIds: [], createdAt: "", updatedAt: "", metadata: {} }; },
    async view() { calls.push("view"); return { apps: [], infrastructure: { id: "infra:1" } }; },
    execute: async (request) => { calls.push("execute"); return execute(request); },
  };
}

test("route inventory keeps authority on primitive execution only", async () => {
  const service = fake();
  const app = buildApi({ service, config, database: async () => "UP" });
  const printed = app.printRoutes({ commonPrefix: false });
  for (const fragment of ["/health (GET", "/infrastructures (POST)", "/:id (GET", "/apps (POST)", "/:appId/grants (POST)", "/infrastructure (GET", "/capabilities/execute (POST)"]) assert.match(printed, new RegExp(fragment.replace(/[()]/g, "\\$&")));
  assert.equal(routeInventory.filter(route => route.access === "AUTHORITY_ENFORCED").map(route => route.url).join(), "/capabilities/execute");
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
  assert.equal(granted.statusCode, 200);
  assert.equal(service.calls.includes("execute"), false);
  await app.close();
});

test("execute uses the canonical pipeline and truthful statuses", async () => {
  const seen: CapabilityRequest[] = [];
  const statuses: CapabilityResult["status"][] = ["COMPLETED", "AUTHENTICATION_REQUIRED", "DENIED", "FAILED", "CAPABILITY_UNAVAILABLE"];
  let index = 0;
  const service = fake(async request => { seen.push(request); return { status: statuses[index++] ?? "FAILED", correlationId: request.correlationId, reason: "SAMPLE" }; });
  const app = buildApi({ service, config });
  const headers = { authorization: "Bearer session" };
  const payload = { infrastructureId: "infra:1", applicationId: "app:1", capability: "identity.currentActor", action: "identity.currentActor", resource: "infrastructure:infra:1", audience: "ddi", authorityToken: "authority-token", authorityActor: "human:api", executionMode: "SPACE", payload: { assertion: "secret-assertion" } };
  for (const status of statuses) {
    const response = await app.inject({ method: "POST", url: "/capabilities/execute", headers, payload });
    assert.equal(response.statusCode, resultStatus(status));
    assert.equal(response.json().status, status);
  }
  assert.equal(seen[0]?.executionMode, "SPACE");
  assert.equal(seen[0]?.actor?.ownerId, owner.ownerId);
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
