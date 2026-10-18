# Phase D3C-B — Secure Portal provisioning × Master Distributor × DDI

Local implementation only. Production DDI still composes `UnavailableCommercialProvisioner`;
the real Portal adapter is enabled only by `DDI_COMMERCIAL_PROVISIONING_MODE=portal-local-integration`
outside production, and `readConfig` refuses that mode in production.

## Service authentication (`digiconomy-service+jwt` v1)

TrustID has no workload-identity or client-credentials flow, so service calls use short-lived
signed service tokens with **pinned keys**. This identifies services only; people are still
identified by TrustID / Digi sessions.

| Claim / rule | Value |
| --- | --- |
| Algorithm | Ed25519 (`EdDSA`) only; `alg: none` and others rejected |
| `iss` = `sub` | calling service id; key looked up by (`iss`, `kid`) in the verifier's config |
| `aud` | receiving service id (`ddi`, `lifeos-portal`, `master-distributor`) |
| `htm`, `htu` | HTTP method and exact path; a token for one route fails on another |
| Lifetime | `exp − iat ≤ 300 s`, 30 s skew; single use per `jti` (in-process replay cache) |
| Permissions | from the **verifier's** configuration only; claims such as `roles` / `permissions` are ignored |
| Test keys | `kid` prefixed `test-`; refused as trust anchors and signing keys in production |

| Caller → receiver | Route | Permission |
| --- | --- | --- |
| DDI → Portal | `POST /internal/ddi/ownership/verify` | `ownership:verify` |
| DDI → Portal | `POST /internal/ddi/provisioning` | `provisioning:bind` |
| Portal → DDI | `POST /internal/portal/install-events` | `portal:install-events` |
| Master Distributor → DDI | `POST /internal/downloads/redeem` | `downloads:redeem` |
| Publisher → MD | `PUT /v1/uploads`, `POST /v1/releases` | `releases:publish` |
| Operator → MD | `GET /v1/releases/...`, domain status | `releases:read`, `tenants:read` |
| Portal → MD | tenant/domain bootstrap, packaging | `tenants:provision`, `packages:compile` |

Configuration: DDI `DDI_TRUSTED_SERVICES`, `DDI_SERVICE_ID/KEY_ID/PRIVATE_KEY`; Portal
`PORTAL_TRUSTED_SERVICES`, `PORTAL_SERVICE_*`, `DDI_INSTALL_EVENTS_URL`, `DDI_PORTAL_PRODUCT_MAP`;
MD `MD_TRUSTED_SERVICES`, `MD_ARTIFACT_SIGNING_KEYS`, `MD_SERVICE_*`, `DDI_BASE_URL`.
Production private keys belong in a KMS/HSM; none were created.

## Portal provisioning (`ddi.portal.provisioning.v1`) — implemented

Binds DDI's license to an install the owner already created through the Portal's own flow.
It never creates an install, so it cannot duplicate one, and it skips no domain, OS or
distributor check.

- `Idempotency-Key` must equal `ddi-provision:<redemptionId>`; same key and body → same reference;
  different body → 409. Records are durable (`portal.records` kind `ddiProvisioning`).
- 404 not owner / missing / `local:` subject; 423 install or owner suspended (DDI retries);
  422 failed install, product/app mismatch, unsupported contract; 409 install licensed to another license.
- `status` is `PROVISIONED` only when the install is READY, otherwise `ACCEPTED` with the real
  `installStatus`. DDI still activates only after its own `activate` ownership verification.

## Portal → DDI install events (`portal.install-events.v1`) — implemented

Emitted inside the Portal store's write path for install suspension/reinstatement, owner-account
suspension/reinstatement, and install deletion (`INSTALL_RETIRED`). Each event carries the
canonical install id, owner subject, `portal-install:<id>`, event id, correlation id, a
per-install monotonic `sequence`, and the **full** DDI-relevant state
`{ installSuspended, ownerSuspended, retired }`. Delivery is an at-least-once outbox with backoff.

DDI applies events idempotently by event id and only for a strictly newer sequence. Any
restriction suspends the property (retirement revokes it, terminally); restoration needs a clean
state at a newer sequence. Reconciliation (`reconcilePortalInstalls`, every 5 min) asks the Portal
directly: anything short of a verified READY restricts, and it restores only on a newer sequence.

The Portal has no ownership transfer. An event or answer naming a different owner than the
redeemer sets a sticky `owner_mismatch` restriction that only an operator can resolve.

## Master Distributor

- **Integrity:** bytes are uploaded first; MD computes SHA-256 and size; publishing requires the
  matching `checksumSha256` (missing → `CHECKSUM_REQUIRED`) and an Ed25519 publisher signature over
  `md.artifact-signature.v1\n<appId>\n<version>\n<platform>\n<filename>\n<sha256>\n<size>` against a
  pinned key. Delivery re-hashes the bytes and re-verifies the signature before serving.
- **Delivery:** `GET /v1/delivery/:token`, single use, ≤ 300 s, exact version, served by MD with
  `x-artifact-sha256`, `x-artifact-signature`, `x-artifact-signing-key`. No storage URLs are issued.
- **Policy:** releases are `licensed` by default. Guest downloads are off by default and, when
  enabled, serve only releases explicitly published as `public`.
- **Fulfilment:** `POST /v1/fulfillment/ddi-grants { grantToken, artifactId, version, propertyId? }`
  resolves the exact release, redeems at DDI as `master-distributor`, requires DDI to echo the same
  artifact and version, then issues a delivery. MD has no licensing logic.

## Identifier mapping

`artifactId = <EcosystemAppId>.<ArtifactPlatform>` (e.g. `personal-brandos.apk`). App ids contain no
`.`, so the split is unambiguous and verified against MD's enum. The id names an artifact line; the
**version is always bound separately**: DDI grants store `artifact_version` and DDI requires an exact
match at redemption, so a grant for `1.4.0` cannot fulfil `1.5.0`. DDI catalogs must list only ids MD
publishes. DDI plans entitle all versions of an artifact; version-scoped entitlement needs a catalog
extension.

## Migrations and rollback

| Repo | Migration | Effect |
| --- | --- | --- |
| DDI | `007_portal_install_state.sql` | event log + per-install state (additive) |
| DDI | `008_download_grant_version.sql` | `ddi_download_grants.artifact_version` (additive, nullable) |
| Portal | record kinds `ddiProvisioning`, `ddiInstallEvents` | `records_kind_known` constraint recomputed at boot |
| MD | `002_artifact_integrity_delivery` | `app_releases.access`, `md_uploads`, `md_deliveries` |

All are additive. Rollback = deploy the previous code; the new tables/columns are ignored by it.
Releases published before MD 002 have no verified signature and are refused at delivery until
republished; that is intended, since their checksums were never verified.
