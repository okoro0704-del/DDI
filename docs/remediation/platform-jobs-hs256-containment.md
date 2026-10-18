# Platform Jobs — HS256 fallback-secret containment

For the Platform Jobs workspace (`okoro0704-del/platformjob`). Prepared from DDI's D3D-A security
closure; make these changes there, not from DDI. Never print, log or commit a secret value.

## Finding (at `0dbe7d8`)

- `platform-jobs-engine/src/config/index.ts:25` (and the compiled copy `src/config/index.js:13`) and
  `apps/distribution-hub/src/config.ts:33` fall back to a committed development literal for
  `TRUST_ID_JWT_SECRET`; no production refusal.
- `platform-jobs-engine/src/auth/trust-id.ts` verifies with `jsonwebtoken` using that secret, checks
  issuer and audience, does not pin algorithms, and takes the tenant from the token's `tenantId`
  claim, which any holder of the secret can choose.

## Step A — contain

1. Remove the fallback in both services (and the compiled `.js` copy, or stop committing it). In
   production refuse to start when the secret is unset, shorter than 32 bytes or equal to the
   published value (SHA-256 digest comparison; never keep the value in code).
2. Pin `algorithms: ["HS256"]` and require issuer and audience.
3. Restrict tenants per authenticated caller (configuration maps caller → allowed tenants) instead
   of trusting `tenantId` alone.

## Tests

Production refuses missing, short and published secrets; tokens with another algorithm or without
issuer/audience are rejected; a caller cannot act for a tenant it is not mapped to.

## Compatibility and consumers (confirm before deploying)

Minters found locally: TrustID BaaS SDK (`mintPlatformJobServiceJwt`), LifeOS
`scripts/deploy-distribution.ts` (pushes to the Distribution Hub). Operators confirm which deployed
services set `TRUST_ID_JWT_SECRET` (names only) and deploy them with an explicit shared value first.

## Later

Accept TrustID-issued EdDSA service tokens (`kid` from TrustID's JWKS, exact `iss`, `aud` for this
service, ≤ 300 s, `jti`), log HS256 use, then reject HS256 when no caller remains.

## Acceptance

No committed fallback; production refuses weak or missing secrets; algorithm, issuer, audience and
tenant authorization enforced; tests pass; no secret value in code, logs or test output.
