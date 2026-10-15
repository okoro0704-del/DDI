# Phase D3C-A — Portal × Master Distributor integration contracts

Status: **readiness only.** Contracts marked *proposed* have no implementation on
the other side. DDI production composition keeps `UnavailableCommercialProvisioner`,
so nothing reports provisioning success until a real Portal endpoint exists.

## Responsibilities

| Concern | Owner |
| --- | --- |
| Identity (canonical subject, Digi session) | TrustID / Digi Core |
| Install record, install owner, READY state | Portal (`PortalInstall`) |
| Commercial authorization, entitlement, license, property connection, download grant | DDI |
| Artifact registry, versions, integrity metadata, byte delivery | Master Distributor |

Master Distributor never evaluates licenses. It asks DDI to consume a grant.

## End-to-end flow

| # | Transition | Durable record | Idempotency |
|---|---|---|---|
| 1 | Operator confirms payment, issues code | `ddi_activation_codes` + audit | operator + `Idempotency-Key` |
| 2 | Owner redeems (Digi session) | — | owner + `Idempotency-Key` |
| 3 | Portal ownership, purpose `bootstrap` | receipt on property | read-only |
| 4 | Existing PDI resolved | `ddi_infrastructures` (unique per owner) | unique index |
| 5 | Entitlement, license, redemption, outbox, code consumed | one PostgreSQL transaction | code row lock |
| 6 | Portal provisioning *(proposed)* | `provisioned_at`, reference | `ddi-provision:<redemptionId>` |
| 7 | Portal READY, ownership purpose `activate` | property `ACTIVE`, fresh receipt | conditional update |
| 8 | Owner requests a download | `ddi_download_grants` (hash) | — (new grant each time) |
| 9 | Master Distributor redeems the grant | grant `CONSUMED` | single-use row lock |
| 10 | Artifact delivered *(proposed MD side)* | MD access log | — |

Steps 6 and 7 run independently inside one outbox job, so a Portal install
whose READY depends on step 6 does not deadlock. Privilege appears only at 7.

## Contract A — Portal ownership verification (implemented, D3A + D3B/D3C)

`POST {PORTAL}/internal/ddi/ownership/verify`, header `x-ddi-ownership-secret`.

```json
{ "ownerSubject": "<canonical TrustID subject>", "externalSystem": "lifeos",
  "externalReference": "portal-install:<installId>", "type": "PERSONAL_BRAND",
  "purpose": "activate | bootstrap" }
```

| Response | Meaning in DDI |
| --- | --- |
| 200 `{verified, issuer, evidenceId, verifiedAt, expiresAt, ownerSubject, externalSystem, externalReference, readiness: "ready"\|"pending"}` | verified (pending only accepted for `bootstrap`) |
| 404 / 403 | `OWNERSHIP_NOT_VERIFIED` (terminal) |
| 409 | `OWNERSHIP_VERIFICATION_PENDING` (retry) |
| 5xx / network | `OWNERSHIP_VERIFICATION_UNAVAILABLE` (retry) |

Rejected by the Portal: `local:` subjects, non-matching owner, suspended or
missing owner account, suspended install, failed install, non-ready install
outside `bootstrap`.

## Contract B — Portal provisioning (**proposed**, `ddi.portal.provisioning.v1`)

No Portal endpoint exists. Portal installs are created only by an owner session
(`POST /installs`, `POST /installs/personal`), gated by Finprove `PortalBilling`.

`POST {PORTAL}/internal/ddi/provisioning`

Headers: `x-ddi-provisioning-secret` (dedicated, ≥ 32 chars; later mTLS or a
signed service token), `Idempotency-Key: ddi-provision:<redemptionId>`,
`X-Correlation-Id`, `X-DDI-Contract: ddi.portal.provisioning.v1`.

```json
{ "contractVersion": "ddi.portal.provisioning.v1",
  "redemptionId": "redemption:…", "licenseId": "license:…", "entitlementId": "entitlement:…",
  "productId": "personal-brandos", "planId": "creator",
  "ownerSubject": "<canonical TrustID subject>",
  "externalReference": "portal-install:<installId>" }
```

| Response | DDI classification |
| --- | --- |
| 200/201 `{ "status": "ACCEPTED" \| "PROVISIONED", "reference": "<portal id>", "installStatus": "…" }` | success; reference stored |
| same key, same body, again | same 200 and same `reference` (no second effect) |
| same key, different body | 409 → `PROVISIONING_REJECTED` (terminal, operator) |
| 404 owner/install mismatch | `PROVISIONING_REJECTED` |
| 422 unsupported product/plan or contract version | `PROVISIONING_REJECTED` |
| 429 / 503 / timeout / network | `PROVISIONING_UNAVAILABLE` (retry with backoff) |

The Portal must re-check `ownerSubject` against `PortalInstall.ownerTrustId`
itself; DDI's word is not ownership proof. Client timeout: 10 s. DDI never sends
activation codes, Digi sessions, or download tokens.

## Contract C — DDI download-grant redemption (implemented)

Owner: `POST {DDI}/me/licenses/:licenseId/downloads` `{ "artifactId": "<appId>.<platform>" }`
→ `{ grantId, token, artifactId, productId, licenseId, expiresAt }` (TTL 30–900 s).

Distributor: `POST {DDI}/internal/downloads/redeem`, header `x-ddi-distributor-secret`.

```json
{ "token": "ddidl_…", "artifactId": "personal-brandos.apk",
  "productId": "personal-brandos", "propertyId": "property:… (when fulfilling for a property)" }
```

200 `{ ownerId, licenseId, productId, artifactId, propertyId }`, consumed exactly
once. 403 codes: `DOWNLOAD_GRANT_INVALID | _CONSUMED | _EXPIRED`,
`DOWNLOAD_SCOPE_MISMATCH` (artifact, product, or property; not consumed),
`LICENSE_REVOKED | _SUSPENDED | _EXPIRED`, `PROPERTY_NOT_ACTIVE`. 503 when DDI has
no distributor credential configured.

## Contract D — Master Distributor fulfilment (**proposed**)

`POST {MD}/v1/fulfillment/ddi-grants` `{ token, artifactId, version? }`

1. MD calls Contract C with its own service credential and `X-Correlation-Id`.
2. On 200, MD maps `artifactId` = `<EcosystemAppId>.<ArtifactPlatform>` to its
   immutable release (latest `stable` unless `version` is given and published).
3. MD returns `{ url, expiresAt, appId, version, platform, checksumSha256, sizeBytes }`
   with a URL TTL ≤ DDI's grant TTL.
4. Any DDI 4xx is returned as-is; DDI 5xx/timeout (10 s) → 503, grant untouched.

DDI artifact ids must match MD's registry; a catalog entry whose artifact MD has
not published must be rejected at configuration review.

## Cross-cutting rules

- **Identifiers:** DDI `ownerId` (Digi Core) internally; the canonical TrustID
  subject is the only identifier sent to the Portal. `local:` subjects never match.
- **Correlation:** `X-Correlation-Id` is propagated on every hop and stored in audit.
- **Retries:** outbox exponential backoff (5 s → 15 min cap), `max_attempts` 25,
  then `ATTENTION_REQUIRED`; operator requeue ≤ 3 per job, reason required, audited.
- **Revocation:** DDI → MD is enforced at redemption time (no cache).
  Portal → DDI is **missing**: a later install suspension, deletion, or owner
  change is not pushed to DDI. Proposed: Portal emits `install.ownership.changed`
  and `install.suspended` to `POST {DDI}/internal/portal/install-events`, which
  suspends the property; until then an activated property is not re-verified.
- **Versioning:** contract name in header and body; unknown major → 422 terminal.

## Master Distributor gaps (inspected at `541734e`)

- Auth: HS256 JWTs with a shared `TRUST_ID_JWT_SECRET` (default
  `dev-trust-id-secret-change-me`) whose roles are self-asserted claims; not TrustID.
- `ENABLE_GUEST_DOWNLOADS` defaults to `true`: `/downloads/:appId/latest` hands out
  any app's latest binary without authentication, bypassing any licensing.
- `checksumSha256` is optional at publish and is filled with a random digest when
  omitted, so recorded integrity metadata can be fabricated; there is no artifact
  signature.
- Signed URLs point at `/signed/...` under the storage base URL; no MD route
  verifies them, and the volume provider has no byte-serving route.
- No product/plan concept, no license verification, no DDI integration.
