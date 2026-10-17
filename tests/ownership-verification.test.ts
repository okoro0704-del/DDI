import assert from "node:assert/strict";
import test from "node:test";
import { HttpPortalOwnershipVerifier } from "../packages/service/src/ownership.ts";

const request = { trustIdSubject: "TD-D3-OWNER", externalSystem: "lifeos", externalReference: "portal-install:ins_d3", type: "PERSONAL_BRAND" as const };
const wire = { ownerSubject: request.trustIdSubject, externalSystem: request.externalSystem, externalReference: request.externalReference };
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

test("Portal ownership verifier accepts only a current response bound to the submitted owner and property", async () => {
  const verifier = new HttpPortalOwnershipVerifier({ url: "https://portal.invalid/internal/ddi/ownership/verify", sharedSecret: "test-secret", fetch: async (_url, init) => {
    assert.equal(init?.headers && new Headers(init.headers).get("x-ddi-ownership-secret"), "test-secret");
    return response({ verified: true, issuer: "lifeos-portal", evidenceId: "receipt-1", verifiedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString(), ...wire });
  } });
  assert.equal((await verifier.verify(request)).evidenceId, "receipt-1");
});

test("Portal ownership verifier fails closed for forged, replayed-expired, and unavailable evidence", async () => {
  const cases: Array<[string, Response]> = [
    ["forged", response({ verified: true, issuer: "lifeos-portal", evidenceId: "x", verifiedAt: new Date().toISOString(), ...wire, ownerSubject: "TD-OTHER" })],
    ["expired", response({ verified: true, issuer: "lifeos-portal", evidenceId: "x", verifiedAt: new Date().toISOString(), expiresAt: "2000-01-01T00:00:00.000Z", ...wire })],
    ["unavailable", response({ error: "down" }, 503)],
  ];
  for (const [name, reply] of cases) {
    const verifier = new HttpPortalOwnershipVerifier({ url: "https://portal.invalid", sharedSecret: "test-secret", fetch: async () => reply });
    await assert.rejects(verifier.verify(request), name === "unavailable" ? /OWNERSHIP_VERIFICATION_UNAVAILABLE/ : /OWNERSHIP_NOT_VERIFIED/);
  }
});
