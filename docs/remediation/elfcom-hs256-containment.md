# ElfCom — HS256 fallback-secret containment

For the ElfCom workspace (`okoro0704-del/elfCOM`). Prepared from DDI's D3D-A security closure; make
these changes in ElfCom, not from DDI. Never print, log or commit a secret value.

## Finding

- `apps/elfcom-node/src/config.ts:16` — `jwtSecret: required("LIFEOS_JWT_SECRET", <committed literal>)`.
  The fallback applies in every environment, including production. Present at `f0b7e72` (pinned by
  DDI CI) and on `origin/main` `7f51b5d`.
- The same literal is TrustID's fallback for minting ElfCom capability tokens (compared locally; not
  reproduced). A deployment without `LIFEOS_JWT_SECRET` accepts capability tokens anyone can mint,
  for any subject, and derives session keys from the same value (`middleware/trustid-auth.ts:73`).
- `src/auth/node-jwt.ts` `verifyCapabilityJwt` checks issuer and audience but does not pin algorithms.
- `src/middleware/trustid-auth.ts` treats `TRUSTID_ISSUER` as optional (`|| undefined`) and falls
  back to capability JWTs when the TrustID JWKS is unset.
- Same shared secret: `apps/elfcom-console/src/lib/session.ts`, `adapters/lifeos-http/src/http-elfcom-provider.ts`.

## Step A — contain (no compatibility loss for correctly configured deployments)

1. Remove the literal fallback. In production refuse to start when `LIFEOS_JWT_SECRET` is unset,
   shorter than 32 bytes, or equal to the previously published value (compare SHA-256 digests
   against a stored digest; never keep the value itself in code). In development and tests require
   an explicit value or generate a random one per process and say so in the log.
2. Pin `algorithms: ["HS256"]` in `verifyCapabilityJwt` and `algorithms: ["EdDSA"]` for the TrustID JWKS path.
3. In production require `TRUSTID_ISSUER`, `TRUSTID_AUDIENCE` and `TRUSTID_JWKS_URL`; do not fall back
   to capability tokens because the JWKS is missing.
4. Apply the same secret rules to the console session and the LifeOS HTTP adapter.

## Tests

- Production config refuses: unset, short, and the published value (by digest).
- A capability token signed with the published value is rejected when a real secret is set.
- HS512, `none` and EdDSA-signed capability tokens are rejected by `verifyCapabilityJwt`.
- The TrustID JWKS path rejects a token with the right key but a wrong or missing issuer.

## Compatibility and consumers (confirm before deploying)

Minters: TrustID API (`apps/api/src/modules/elfcom/capability.ts`), the LifeOS HTTP adapter, the ElfCom
console. Verifier: elfcom-node. DDI's communication-binding test already passes its own per-run
`LIFEOS_JWT_SECRET` (DDI D3D-A closure), so DDI keeps working; DDI will bump its ElfCom pin after
this lands. Every deployed minter and verifier must share an explicitly set secret before Step A
is deployed; an operator checks variable names only.

## Later

- Step B: accept TrustID-issued EdDSA capability tokens (`kid` from TrustID's JWKS, exact `iss`,
  `aud: elfcom`, `typ` pinned, ≤ 300 s) alongside HS256 and log each HS256 use by caller.
- Step C: once no HS256 caller remains, reject HS256 and retire `LIFEOS_JWT_SECRET`.
- The PDI inbox's static bearer (`ELFCOM_PDI_SERVICE_TOKEN`) should move to the Ed25519
  `digiconomy-service+jwt` service identity DDI already uses with Portal and Master Distributor.

## Acceptance

No committed fallback secret remains; production refuses weak or missing secrets; algorithms and
issuers are pinned; tests above pass; no secret value appears in code, logs or test output.
