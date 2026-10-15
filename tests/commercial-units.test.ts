import test from "node:test";
import assert from "node:assert/strict";
import { generateActivationCode, hashActivationSecret, parseActivationCode, sameDigest } from "../packages/service/src/activation-code.ts";
import { CommercialService, UnavailableCommercialProvisioner } from "../packages/service/src/commercial.ts";
import { loadCatalog, parseCatalog } from "../packages/service/src/commercial-catalog.ts";
import { readConfig } from "../packages/service/src/config.ts";
import { HttpPortalOwnershipVerifier } from "../packages/service/src/ownership.ts";
import { testServiceIdentity } from "./helpers/service-keys.ts";

const plan = { id: "plan", edition: "standard", licenseType: "PERPETUAL", renewable: false, requiresProperty: false, propertyTypes: [], downloads: ["artifact"] };
const catalog = (patch: Record<string, unknown> = {}) => ({ version: "v1", products: [{ id: "product", displayName: "Product", plans: [{ ...plan, ...patch }] }] });

test("activation codes are random, typeable, and normalized without weakening validation", () => {
  const codes = Array.from({ length: 2000 }, () => generateActivationCode());
  assert.equal(new Set(codes.map(item => item.code)).size, codes.length);
  assert.equal(new Set(codes.map(item => item.lookupId)).size, codes.length);
  for (const { code, lookupId, secret } of codes.slice(0, 50)) {
    assert.match(code, /^DDI(-[0-9A-HJKMNP-TV-Z]{4}){8}$/);
    assert.deepEqual(parseActivationCode(code), { lookupId, secret });
    assert.deepEqual(parseActivationCode(` ${code.toLowerCase().replace(/-/g, "  ")} `), { lookupId, secret });
  }
  const sample = codes[0]!;
  const lookalike = `DDI${sample.lookupId}${sample.secret}`.replace(/0/g, "O").replace(/1/g, "l");
  assert.deepEqual(parseActivationCode(lookalike), { lookupId: sample.lookupId, secret: sample.secret });
  for (const bad of [undefined, 42, "", "DDI", `XDI${sample.lookupId}${sample.secret}`, `DDI${sample.lookupId}${sample.secret}U`, `DDI${sample.lookupId}${sample.secret.slice(1)}U`, `DDI-${"A".repeat(200)}`]) assert.equal(parseActivationCode(bad), null, String(bad));
});

test("activation hashes are keyed by the server pepper", () => {
  const { lookupId, secret } = generateActivationCode();
  const one = hashActivationSecret("p".repeat(32), lookupId, secret);
  assert.equal(sameDigest(one, hashActivationSecret("p".repeat(32), lookupId, secret)), true);
  assert.equal(sameDigest(one, hashActivationSecret("q".repeat(32), lookupId, secret)), false);
  assert.equal(sameDigest(one, hashActivationSecret("p".repeat(32), lookupId, generateActivationCode().secret)), false);
  assert.equal(sameDigest("", ""), false);
  assert.throws(() => new CommercialService({ repository: {} as never, pdi: {} as never, provisioner: new UnavailableCommercialProvisioner(), catalog: parseCatalog(catalog()), pepper: "short" }), /COMMERCIAL_CONFIGURATION_INVALID/);
});

test("the catalog is configuration only and rejects inconsistent plan definitions", () => {
  assert.equal(parseCatalog(catalog()).products[0]!.plans[0]!.licenseType, "PERPETUAL");
  assert.equal(parseCatalog(catalog({ licenseType: "TERM", termDays: 365 })).products[0]!.plans[0]!.termDays, 365);
  for (const patch of [{ licenseType: "TERM" }, { termDays: 30 }, { licenseType: "LIFETIME" }, { requiresProperty: true }, { propertyTypes: ["BUSINESS"] }, { propertyTypes: ["OWNER"], requiresProperty: true }, { id: "Bad Id" }, { downloads: ["../x"] }, { edition: "" }, { renewable: "yes" }]) {
    assert.throws(() => parseCatalog(catalog(patch)), /COMMERCIAL_CATALOG_INVALID/, JSON.stringify(patch));
  }
  assert.throws(() => parseCatalog({ version: "v1", products: [] }), /COMMERCIAL_CATALOG_INVALID/);
  assert.throws(() => parseCatalog({ version: "v1", products: [{ id: "p", displayName: "P", plans: [plan, plan] }] }), /COMMERCIAL_CATALOG_INVALID/);
  assert.equal(loadCatalog({}), undefined);
  assert.throws(() => loadCatalog({ DDI_COMMERCIAL_CATALOG: "{not json" }), /COMMERCIAL_CATALOG_INVALID/);
});

test("production refuses a commercial catalog without a strong pepper or with a weak distributor secret", () => {
  const base = { DDI_ENV: "production", DATABASE_URL: "postgresql://ddi@127.0.0.1/ddi", TRUSTID_ISSUER: "i", TRUSTID_AUDIENCE: "a", TRUSTID_JWKS_URL: "https://j", TRUSTID_BRIDGE_MODULE_URL: "file:///b", DDI_ALLOWED_ORIGINS: "https://o", DIGI_CORE_URL: "https://c", DIGI_AUTHORITY_URL: "https://a", DIGI_AUTHORITY_JWKS_URL: "https://a/j", DIGI_AUTHORITY_VERIFIER_MODULE_URL: "file:///v", PORTAL_OWNERSHIP_URL: "https://p", PORTAL_OWNERSHIP_SHARED_SECRET: "s" };
  assert.doesNotThrow(() => readConfig(base));
  assert.throws(() => readConfig({ ...base, DDI_COMMERCIAL_CATALOG: JSON.stringify(catalog()) }), /DDI_PRODUCTION_CONFIGURATION_INVALID/);
  assert.throws(() => readConfig({ ...base, DDI_COMMERCIAL_CATALOG: JSON.stringify(catalog()), DDI_ACTIVATION_CODE_PEPPER: "too-short" }), /DDI_PRODUCTION_CONFIGURATION_INVALID/);
  assert.doesNotThrow(() => readConfig({ ...base, DDI_COMMERCIAL_CATALOG: JSON.stringify(catalog()), DDI_ACTIVATION_CODE_PEPPER: "x".repeat(32) }));
  // D3C-B: test-labelled service keys and the local-integration provisioning adapter are refused in production.
  const md = testServiceIdentity("master-distributor");
  const trusted = JSON.stringify({ "master-distributor": { permissions: ["downloads:redeem"], keys: { [md.keyId]: md.publicKeyPem } } });
  assert.doesNotThrow(() => readConfig({ DDI_ENV: "test", DDI_TRUSTED_SERVICES: trusted }));
  assert.throws(() => readConfig({ ...base, DDI_TRUSTED_SERVICES: trusted }), /DDI_PRODUCTION_CONFIGURATION_INVALID/);
  assert.throws(() => readConfig({ ...base, DDI_COMMERCIAL_PROVISIONING_MODE: "portal-local-integration", PORTAL_PROVISIONING_URL: "https://p/x" }), /DDI_PRODUCTION_CONFIGURATION_INVALID/);
  assert.throws(() => readConfig({ DDI_ENV: "test", DDI_COMMERCIAL_PROVISIONING_MODE: "portal-local-integration" }), /DDI_PRODUCTION_CONFIGURATION_INVALID/);
  assert.throws(() => readConfig({ DDI_ENV: "test", DDI_COMMERCIAL_PROVISIONING_MODE: "always-succeed" }), /DDI_PRODUCTION_CONFIGURATION_INVALID/);
});

test("Portal ownership: BOOTSTRAP accepts a verified owner of a pending install; ACTIVATE requires READY", async () => {
  const request = { trustIdSubject: "TD-D3B", externalSystem: "lifeos", externalReference: "portal-install:ins_d3b", type: "PERSONAL_BRAND" as const };
  const reply = (readiness: unknown) => async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    assert.equal(body.ownerSubject, "TD-D3B");
    return new Response(JSON.stringify({ verified: true, issuer: "lifeos-portal", evidenceId: "e", verifiedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString(), ownerSubject: body.ownerSubject, externalSystem: body.externalSystem, externalReference: body.externalReference, readiness, purpose: body.purpose }), { status: 200 });
  };
  const verifier = (readiness: unknown) => new HttpPortalOwnershipVerifier({ url: "https://portal.invalid", sharedSecret: "s", fetch: reply(readiness) as typeof fetch });
  assert.equal((await verifier("pending").verify({ ...request, purpose: "BOOTSTRAP" })).readiness, "PENDING");
  assert.equal((await verifier("ready").verify({ ...request, purpose: "BOOTSTRAP" })).readiness, "READY");
  assert.equal((await verifier(undefined).verify(request)).readiness, "READY");
  await assert.rejects(verifier("pending").verify(request), /OWNERSHIP_VERIFICATION_PENDING/);
  await assert.rejects(verifier("ready-ish").verify({ ...request, purpose: "BOOTSTRAP" }), /OWNERSHIP_NOT_VERIFIED/);
  const sentPurposes: string[] = [];
  const recorder = new HttpPortalOwnershipVerifier({ url: "https://portal.invalid", sharedSecret: "s", fetch: (async (url: unknown, init?: RequestInit) => { sentPurposes.push(JSON.parse(String(init?.body)).purpose); return reply("ready")(url, init); }) as typeof fetch });
  await recorder.verify(request);
  await recorder.verify({ ...request, purpose: "BOOTSTRAP" });
  assert.deepEqual(sentPurposes, ["activate", "bootstrap"]);
  const offline = new HttpPortalOwnershipVerifier({ url: "https://portal.invalid", sharedSecret: "s", fetch: (async () => { throw new TypeError("fetch failed"); }) as typeof fetch });
  await assert.rejects(offline.verify(request), /OWNERSHIP_VERIFICATION_UNAVAILABLE/);
});
