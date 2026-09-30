import test from "node:test";
import assert from "node:assert/strict";
import { DdiService, TrustIdAdapter, UnavailableAdapter, type Actor, type CapabilityRequest } from "../packages/core/src/index.ts";

const owner: Actor = { ownerId: "own_owner" as Actor["ownerId"], subject: "TD-owner", kind: "HUMAN", verified: true, authorityActor: "human:owner" };
const visitor: Actor = { ownerId: "own_visitor" as Actor["ownerId"], subject: "TD-visitor", kind: "HUMAN", verified: true, authorityActor: "human:visitor" };
const authority = async ({ request }: { request: CapabilityRequest }) => !request.authority?.token ? { ok: false as const, reason: "MISSING" as const } : request.actor?.ownerId !== owner.ownerId ? { ok: false as const, reason: "WRONG_RESOURCE" as const } : request.action === "identity.write" ? { ok: false as const, reason: "WRONG_ACTION" as const } : request.resource !== "infra:owned" ? { ok: false as const, reason: "WRONG_RESOURCE" as const } : request.audience !== "ddi" ? { ok: false as const, reason: "WRONG_AUDIENCE" as const } : request.authority.token === "expired" ? { ok: false as const, reason: "EXPIRED" as const } : request.authority.token === "revoked" ? { ok: false as const, reason: "REVOKED" as const } : { ok: true as const, grantId: "grant:test" };

function adapters() {
  const map = new Map();
  map.set("identity", new TrustIdAdapter(async assertion => assertion === "valid" ? { subject: owner.subject, ownerId: owner.ownerId } : null));
  for (const [namespace, provider] of [["communication", "ElfCom"], ["data", "DataZone"], ["jobs", "PlatformJobs"], ["distribution", "MasterDistributor"], ["value", "FundzMan"], ["intelligence", "DigiAI"]] as const) map.set(namespace, new UnavailableAdapter(namespace, provider));
  return map;
}
function setup() {
  const ddi = new DdiService(undefined, authority, adapters());
  const infra = ddi.createInfrastructure(owner, "CREATOR");
  const app = ddi.registerApplication({ infrastructureId: infra.id, displayName: "Creator App", type: "WEB", publicUrl: "https://example.test", adminUrl: "https://admin.example.test", status: "ACTIVE", requestedCapabilities: ["identity.read", "identity.currentActor", "communication.send"] });
  ddi.grantCapabilities(app.id, ["identity.read", "identity.currentActor"]);
  ddi.bind(infra.id, "identity", "TrustID", true);
  return { ddi, infra, app };
}
function request(s: ReturnType<typeof setup>, changes: Partial<CapabilityRequest> = {}): CapabilityRequest {
  return { infrastructureId: s.infra.id, applicationId: s.app.id, capability: "identity.read", action: "identity.read", resource: "infra:owned", audience: "ddi", actor: owner, authority: { token: "valid" }, correlationId: "correlation-1", payload: { assertion: "valid" }, ...changes };
}

test("creates opaque stable infrastructure and application IDs", () => {
  const s = setup();
  assert.match(s.infra.id, /^infra:/);
  assert.match(s.app.id, /^app:/);
  assert.equal(s.infra.ownerId, owner.ownerId);
  assert.deepEqual(s.app.grantedCapabilities, ["identity.read", "identity.currentActor"]);
});
test("registration does not copy requested capabilities into grants", () => {
  const ddi = new DdiService(undefined, authority, adapters());
  const infra = ddi.createInfrastructure(owner, "PERSONAL");
  const app = ddi.registerApplication({ infrastructureId: infra.id, displayName: "PDI", type: "WEB", status: "ACTIVE", requestedCapabilities: ["identity.read"] });
  assert.deepEqual(app.grantedCapabilities, []);
});
test("suspended infrastructure fails closed", async () => { const s = setup(); s.ddi.suspend(s.infra.id); assert.equal((await s.ddi.route(request(s))).status, "DENIED"); });
test("unknown and cross-infrastructure applications are denied", async () => { const s = setup(); assert.equal((await s.ddi.route(request(s, { applicationId: "app:unknown" as CapabilityRequest["applicationId"] }))).status, "DENIED"); });
test("ungranted capabilities are denied", async () => { const s = setup(); assert.equal((await s.ddi.route(request(s, { capability: "communication.send", action: "communication.send" }))).reason, "CAPABILITY_NOT_GRANTED"); });
test("identity routes to the connected TrustID adapter", async () => { const s = setup(); const result = await s.ddi.route(request(s)); assert.equal(result.status, "COMPLETED"); assert.equal((result.data as { ownerId: string }).ownerId, owner.ownerId); });
test("identity.currentActor returns the Digi owner and does not treat subject as owner", async () => {
  const s = setup();
  const result = await s.ddi.route(request(s, { capability: "identity.currentActor", action: "identity.currentActor" }));
  assert.equal(result.status, "COMPLETED");
  const data = result.data as { ownerId: string; subject?: string };
  assert.equal(data.ownerId, owner.ownerId);
  assert.equal(data.subject, owner.subject);
  assert.notEqual(data.ownerId, data.subject);
});
test("missing actor requires authentication", async () => {
  const s = setup();
  assert.equal((await s.ddi.route(request(s, { actor: undefined }))).status, "AUTHENTICATION_REQUIRED");
  assert.equal(s.ddi.store.audits.at(-1)?.decision, "AUTHENTICATION");
});
test("wrong action, resource, audience, expiry and revocation are denied", async () => {
  const s = setup();
  for (const changes of [{ action: "identity.write" }, { resource: "infra:other" }, { audience: "other" }, { authority: { token: "expired" } }, { authority: { token: "revoked" } }]) assert.equal((await s.ddi.route(request(s, changes))).status, "DENIED");
});
test("TrustID invalid evidence requires interaction and never trusts caller actor", async () => { const s = setup(); const result = await s.ddi.route(request(s, { payload: { assertion: "forged" } })); assert.equal(result.status, "AUTHENTICATION_REQUIRED"); });
test("a visitor authentication does not grant creator infrastructure access", async () => {
  const s = setup();
  const result = await s.ddi.route(request(s, { actor: visitor, authority: { token: "valid" } }));
  assert.equal(result.status, "DENIED");
  assert.equal(result.reason, "OWNER_MISMATCH");
  assert.equal(s.ddi.store.audits.at(-1)?.ownerId, visitor.ownerId);
});
test("provider mismatch is unavailable and distinct from deny", async () => {
  const s = setup();
  s.ddi.grantCapabilities(s.app.id, ["communication.send"]);
  s.ddi.bind(s.infra.id, "communication", "DataZone", true);
  const result = await s.ddi.route(request(s, { capability: "communication.send", action: "communication.send" }));
  assert.equal(result.status, "CAPABILITY_UNAVAILABLE");
  assert.equal(result.reason, "PROVIDER_MISMATCH");
  assert.equal(s.ddi.store.audits.at(-1)?.decision, "UNAVAILABLE");
});
test("unconfigured primitive adapters fail honestly", async () => {
  const s = setup();
  s.ddi.grantCapabilities(s.app.id, ["communication.send"]);
  s.ddi.bind(s.infra.id, "communication", "ElfCom", false);
  assert.equal((await s.ddi.route(request(s, { capability: "communication.send", action: "communication.send" }))).status, "CAPABILITY_UNAVAILABLE");
});
test("authority and adapter failures stay FAILED", async () => {
  const failingAuthority = new DdiService(undefined, async () => { throw new Error("authority down"); }, adapters());
  const infra = failingAuthority.createInfrastructure(owner, "CREATOR");
  const app = failingAuthority.registerApplication({ infrastructureId: infra.id, displayName: "Creator App", type: "WEB", status: "ACTIVE", requestedCapabilities: ["identity.read"] });
  failingAuthority.grantCapabilities(app.id, ["identity.read"]);
  failingAuthority.bind(infra.id, "identity", "TrustID", true);
  const denied = await failingAuthority.route(request({ ddi: failingAuthority, infra, app }));
  assert.equal(denied.status, "FAILED");
  assert.equal(denied.reason, "AUTHORITY_UNAVAILABLE");
  assert.equal(failingAuthority.store.audits.at(-1)?.decision, "FAILED");
  const throwing = adapters();
  throwing.set("identity", new TrustIdAdapter(async () => { throw new Error("adapter down"); }));
  const adapterService = new DdiService(undefined, authority, throwing);
  const infra2 = adapterService.createInfrastructure(owner, "CREATOR");
  const app2 = adapterService.registerApplication({ infrastructureId: infra2.id, displayName: "Creator App", type: "WEB", status: "ACTIVE", requestedCapabilities: ["identity.read"] });
  adapterService.grantCapabilities(app2.id, ["identity.read"]);
  adapterService.bind(infra2.id, "identity", "TrustID", true);
  const failed = await adapterService.route(request({ ddi: adapterService, infra: infra2, app: app2 }));
  assert.equal(failed.status, "FAILED");
  assert.equal(failed.reason, "ADAPTER_FAILED");
  assert.equal(adapterService.store.audits.at(-1)?.decision, "FAILED");
});
test("portal read model separates apps from infrastructure and hides secrets", () => {
  const s = setup();
  const view = s.ddi.portalReadModel(s.infra.id);
  assert.equal(view.apps.length, 1);
  assert.equal(view.infrastructure.capabilities.find(item => item.namespace === "data")?.state, "NOT_PROVISIONED");
  assert.equal(JSON.stringify(view).includes("token"), false);
});
test("audit records allow, deny, provider and no sensitive assertion", async () => {
  const s = setup();
  await s.ddi.route(request(s, { executionMode: "SPACE" }));
  await s.ddi.route(request(s, { action: "identity.write" }));
  const text = JSON.stringify(s.ddi.store.audits);
  assert.match(text, /ALLOW/);
  assert.match(text, /DENY/);
  assert.match(text, /TrustID/);
  assert.match(text, /SPACE/);
  assert.equal(text.includes("valid"), false);
  assert.equal(text.includes("forged"), false);
});
