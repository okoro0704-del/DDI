import test from "node:test";
import assert from "node:assert/strict";
import { sign } from "node:crypto";
import { ServiceTokenVerifier, signServiceToken } from "../packages/service/src/service-token.ts";
import { testServiceIdentity } from "./helpers/service-keys.ts";

const md = testServiceIdentity("master-distributor");
const verifier = (now = Date.now(), production = false) => new ServiceTokenVerifier({ audience: "ddi", services: { "master-distributor": md.trusted(["downloads:redeem"]) }, now: () => now, production });
const request = { method: "POST", path: "/internal/downloads/redeem" };
const forge = (header: object, claims: object) => {
  const h = Buffer.from(JSON.stringify(header)).toString("base64url");
  const p = Buffer.from(JSON.stringify(claims)).toString("base64url");
  return `${h}.${p}.${sign(null, Buffer.from(`${h}.${p}`), md.signer.privateKey).toString("base64url")}`;
};

test("a pinned, unexpired, audience- and request-bound token verifies once with configured permissions", () => {
  const v = verifier();
  const token = md.token("ddi", "POST", "/internal/downloads/redeem");
  assert.deepEqual(v.verify(token, request)?.permissions, ["downloads:redeem"]);
  assert.equal(v.verify(token, request), null, "replayed jti");
});

test("invalid service tokens fail closed", () => {
  const v = verifier();
  const now = Math.floor(Date.now() / 1000);
  const base = { iss: "master-distributor", sub: "master-distributor", aud: "ddi", iat: now, exp: now + 60, jti: "j", htm: "POST", htu: "/internal/downloads/redeem" };
  const header = { alg: "EdDSA", typ: "digiconomy-service+jwt", kid: md.keyId };
  const cases: Array<[string, string | undefined]> = [
    ["missing", undefined],
    ["garbage", "a.b.c"],
    ["wrong audience", md.token("lifeos-portal", "POST", "/internal/downloads/redeem")],
    ["wrong path", md.token("ddi", "POST", "/admin/commercial/outbox/run")],
    ["wrong method", md.token("ddi", "GET", "/internal/downloads/redeem")],
    ["unknown key", testServiceIdentity("master-distributor").token("ddi", "POST", "/internal/downloads/redeem")],
    ["unknown service", testServiceIdentity("rogue").token("ddi", "POST", "/internal/downloads/redeem")],
    ["expired", forge(header, { ...base, jti: "e", iat: now - 400, exp: now - 100 })],
    ["over-long lifetime", forge(header, { ...base, jti: "l", exp: now + 3600 })],
    ["issued in future", forge(header, { ...base, jti: "f", iat: now + 600, exp: now + 650 })],
    ["iss != sub", forge(header, { ...base, jti: "s", sub: "ddi" })],
    ["alg none", `${Buffer.from(JSON.stringify({ ...header, alg: "none" })).toString("base64url")}.${Buffer.from(JSON.stringify({ ...base, jti: "n" })).toString("base64url")}.`],
    ["tampered payload", (() => { const t = md.token("ddi", "POST", "/internal/downloads/redeem").split("."); t[1] = Buffer.from(JSON.stringify({ ...base, jti: "t", aud: "ddi" })).toString("base64url"); return t.join("."); })()],
  ];
  for (const [name, token] of cases) assert.equal(v.verify(token, request), null, name);
});

test("forged role or permission claims grant nothing beyond DDI's configuration", () => {
  const now = Math.floor(Date.now() / 1000);
  const token = forge({ alg: "EdDSA", typ: "digiconomy-service+jwt", kid: md.keyId }, { iss: "master-distributor", sub: "master-distributor", aud: "ddi", iat: now, exp: now + 60, jti: "r", htm: "POST", htu: "/internal/downloads/redeem", roles: ["admin"], permissions: ["*", "operator"], scope: "admin" });
  assert.deepEqual(verifier().verify(token, request)?.permissions, ["downloads:redeem"]);
});

test("test-labelled keys are never a production trust anchor", () => {
  assert.equal(verifier(Date.now(), true).verify(md.token("ddi", "POST", "/internal/downloads/redeem"), request), null);
  assert.ok(signServiceToken(md.signer, { audience: "ddi", method: "POST", path: "/x" }));
});
