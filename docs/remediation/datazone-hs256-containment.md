# DataZone — HS256 fallback-secret containment

For the DataZone workspace (`okoro0704-del/DataZone`). Prepared from DDI's D3D-A security closure;
make these changes there, not from DDI. Never print, log or commit a secret value.

## Finding (at `5814c16`)

- `services/data-zone/src/config.ts:79` and `sovereign-drive-engine/src/config/index.ts:75` fall back
  to a committed literal for `TRUST_ID_JWT_SECRET`; no production refusal.
- Verification: `services/data-zone/src/middleware/auth.ts`, `middleware/baas-auth.ts` and
  `sovereign-drive-engine/src/middleware/auth.ts` (`jose.jwtVerify`, issuer and audience checked,
  algorithms not pinned).
- `services/data-zone/src/routes/baas-media.ts:389` mints HS256 media tokens with the same secret,
  so a media link and an API credential share one key.

## Step A — contain

1. Remove both fallbacks; in production refuse to start when the secret is unset, shorter than
   32 bytes or equal to the published value (SHA-256 digest comparison; never keep the value).
2. Pin `algorithms: ["HS256"]` in all three verifiers; keep issuer and audience mandatory.
3. Give media tokens their own key and audience so a media link can never authenticate an API call.

## Tests

Production refuses missing, short and published secrets; other algorithms are rejected; a media
token is refused by the API middleware and an API token by the media route.

## Compatibility and consumers (confirm before deploying)

Minters found locally: TrustID BaaS SDK (`mintDataZoneServiceJwt`), LifeOS DataZone documentation.
Operators confirm which deployed services set `TRUST_ID_JWT_SECRET` (names only). Issued media links
signed with the shared secret stop working when the media key changes; plan expiry accordingly.

## Later

Accept TrustID-issued EdDSA tokens (`kid` from TrustID's JWKS, exact `iss`, `aud` for DataZone,
≤ 300 s, `jti`), log HS256 use, then reject HS256 when no caller remains.

## Acceptance

No committed fallback; production refuses weak or missing secrets; algorithms pinned; media and API
keys separated; tests pass; no secret value in code, logs or test output.
