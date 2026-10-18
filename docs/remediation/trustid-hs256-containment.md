# TrustID — HS256 fallback-secret containment

For the TrustID workspace (`okoro0704-del/TRUSTID`). Prepared from DDI's D3D-A security closure; make
these changes in TrustID, not from DDI. Never print, log or commit a secret value.

## Finding (at `8bf7852`, the commit DDI CI pins)

- `apps/api/src/lib/config.ts` (`elfcom` block): `nodeSecret` and `capabilityJwtSecret` fall back to
  a committed literal when `ELFCOM_NODE_SECRET` / `ELFCOM_CAPABILITY_JWT_SECRET` /
  `LIFEOS_JWT_SECRET` are unset. No production refusal (unlike `COOKIE_SECRET` and `PII_PEPPER`).
  The literal equals ElfCom's own fallback (compared locally; not reproduced).
- `apps/api/src/modules/elfcom/capability.ts` mints HS256 ElfCom capability tokens with it
  (iss `lifeos`, aud `elfcom`, scopes `session:bind`, `notify:send`, 300 s).
- `packages/baas-sdk/src/{master-distribution,platform-job,datazone}.ts` mint HS256 service tokens
  with caller-supplied secrets and self-asserted `roles` / `tenantId`. Master Distributor
  (`e463666`) now rejects HS256, so the SDK's Master Distributor client cannot work against it.
- `services/gateway/src/routes/trustIdAuth.ts` signs with `fastify.jwt`, whose registration
  (algorithm, secret) is not in this repository; confirm whether the gateway is deployed.

## Step A — contain

1. Remove both literal fallbacks. When ElfCom mode is `http` (or any code path mints a capability
   token) in production, refuse to start unless the secret is set, at least 32 bytes and not the
   previously published value (compare SHA-256 digests; never keep the value in code).
2. Validate secrets passed to the BaaS SDK mint functions (≥ 32 bytes) and mark them deprecated.
3. Record which deployed services use each SDK minting function.

## Tests

Production config refuses unset, short and published secrets; capability minting fails closed
without a secret; existing ElfCom capability tests run with an explicit per-test secret.

## Compatibility and consumers (confirm before deploying)

ElfCom must receive the same explicitly set secret before either side drops its fallback; deploy
both together. SDK consumers found locally: TrustID API (`modules/baas`, `modules/bbs`, `modules/elfcom`),
LifeOS documentation for DataZone. Operators confirm deployed variable names only.

## Later — asymmetric credentials

- Issue capability and service tokens as EdDSA JWS from TrustID's existing key infrastructure
  (as `digi-assertion` and `digi-authority` already do): `kid` in TrustID's JWKS, exact `iss`,
  one `aud` per service, `typ` pinned, ≤ 300 s, `jti` for single-use, no permission claims the
  verifier would trust.
- Replace the SDK's HS256 Master Distributor client with the Ed25519 `digiconomy-service+jwt`
  identity Master Distributor already verifies; Platform Jobs and DataZone follow after Step B there.

## Acceptance

No committed fallback secret remains; production refuses weak or missing secrets; no deployed
HS256 caller is left unlisted; no secret value appears in code, logs or test output.
