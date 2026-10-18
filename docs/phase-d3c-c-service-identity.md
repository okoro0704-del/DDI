# Phase D3C-C — Portal → Master Distributor service identity, replay protection, idempotency

Local implementation only. No deployment, no production keys, no persistent database migrated.

## Portal → Master Distributor authentication

Before: in `INSTALL_MODE=remote` the Portal forwarded the end user's TrustID access token to
Master Distributor (MD) and, whenever TrustID was off or no token existed, silently bootstrapped
**locally** instead. MD (after D3C-B) rejects user tokens, so the remote path could not work.

Now (`apps/portal-api/src/services/distributor.ts`):

- Every remote call is signed as the **Portal service** (`lifeos-portal`) with a
  `digiconomy-service+jwt` token: Ed25519, `aud=master-distributor`, `htm`/`htu` = exact method and
  path, ≤ 300 s, single-use `jti`. MD maps `lifeos-portal` to `tenants:provision` / `tenants:read`
  from its own configuration; claims in the token grant nothing.
- The owner's canonical TrustID subject is sent only as business context
  (`x-lifeos-owner-subject`) and recorded by MD on `tenant.bootstrap.completed`
  (`requestedBy`, `ownerSubject`). `local:` subjects are never sent. The user's token is never sent.
- No per-request fallback: remote mode without a Portal identity answers
  `503 distributor_identity_unconfigured`. Owner authorization and install eligibility checks are
  unchanged (the call sites are the same).

**Behaviour change:** a non-production Portal in remote mode without `PORTAL_SERVICE_*` used to
bootstrap guest installs locally; it now fails closed. Configure a Portal identity, or use
`INSTALL_MODE=local`.

Production fail-closed (Portal `readDdiIntegrationConfig`, DDI `readConfig`/`buildApi`, MD
`createSecurityRuntime`):

| Condition | Result |
| --- | --- |
| Portal remote mode without a Portal signing key, or with a non-`https` MD URL | refuse to start |
| Any `test-*` signing key or trust anchor | refuse to start / token rejected |
| Trusted services without a PostgreSQL URL (no shared replay store) | refuse to start (Portal, MD, DDI) |
| D3A shared secret on `/internal/ddi/*` | refused in production; DDI must sign with its own identity |

## Replay protection

`ReplayStore.consume(issuer, jti, expiresAt)` is atomic and shared:

- **PostgreSQL** (`PostgresReplayStore`): `INSERT … ON CONFLICT (jti_hash) DO NOTHING`; accepted iff
  one row was inserted. Tables: DDI `ddi_service_token_replay` (migration 009), Portal
  `portal.service_token_replay` (schema step 004), MD `md_service_token_replay` (migration 003).
- Stores only `SHA-256(issuer \n jti)`, never a token. Rows are retained until `exp + 30 s`, then
  purged (at most once a minute per instance); a purged token is already refused by its `exp`.
- Verification order: structure → pinned key → signature → audience/time/method/path → **consume**.
  Rejected tokens never reach the store.
- Store failure throws `ServiceReplayUnavailable` → HTTP 503. Replay protection is never skipped.
- `MemoryReplayStore` remains for development and tests only; production requires PostgreSQL.

## Portal provisioning idempotency

`portal.ddi_provisioning_claims` (primary key `idempotency_key`, unique `install_id`):

1. `peek` (read-only): a committed outcome for the key is replayed verbatim (even if the install has
   changed since); a different fingerprint is `409 idempotency_conflict`.
2. Authorization and eligibility checks (owner, account, suspension, failure, product) — no claim
   is created for an ineligible request.
3. `claim`: atomic insert. Another key holding the install → `409 install_already_licensed`. A live
   claim by another request → `503 provisioning_in_progress` (DDI retries the same key). A claim older
   than the lease (30 s) → taken over by a single conditional update.
4. Bind the license on the install, `flush()` the store (durable), then `commit` (lease-guarded).

Recovery: a crash after claim and before commit leaves a stale claim; the next retry takes it over
and redoes the same binding, which is idempotent for the same license. Limitation: the install's
`ddiLicense` field is written through the Portal's write-behind store; the claim table, not that
field, is the cross-instance authority.

## ElfCom parallel-test timeouts (investigation)

Five `communication-binding` tests were cancelled in some D3C-B parallel runs when the suite's
`before` hook did not see ElfCom print `listening` within 60 s. Measurements on this 12-CPU machine:

| Condition | ElfCom start | Suite result |
| --- | --- | --- |
| Isolated, cold `tsx` cache | 29.6 s | — |
| Isolated, warm | 2.4–3.4 s | — |
| Full DDI suite, parallel, warm cache | — | passed |
| Full DDI suite, parallel, fresh empty `tsx` cache | — | passed |
| Full DDI suite, parallel, TrustID pin (×2) | — | passed |
| Full DDI suite under concurrent Portal e2e load; independent probe | 16.4 s / 7.0 s / 5.3 s | passed |

Not reproduced in these runs; no orphaned ElfCom processes or port conflicts were found. The fixed
60 s stdout-based readiness wait plus a cold `tsx` compile under heavy concurrent load remains the
most plausible cause. Recommended (not applied): start ElfCom from a prebuilt `dist` in CI, poll its
health endpoint instead of stdout, kill the process tree on Windows, and give the ElfCom suite its own
CI step. No security assertion was changed.

## Adjacent blockers (analysed, not implemented)

| Area | Status and recommendation |
| --- | --- |
| Authority grant revocation | Portal-driven property revocation denies locally at once, but recorded Authority grants are not revoked (Authority revocation needs the owner's session). Needs an Authority service-revocation contract. |
| Delivery-token URL exposure | `GET /v1/delivery/:token` puts a single-use, ≤ 300 s token in the path, so access logs can capture it. Prefer `POST` or a header, or redact the path in logs and at the CDN. |
| KMS/HSM keys | Service signing keys and artifact publisher keys are PEM in environment variables. Production needs KMS-held keys, rotation (multiple `kid`s are already supported), and a key-distribution procedure. |
| MD storage | Only volume storage works; S3/R2 refuses (no SigV4 client). Decide: Railway volume with backups (single writer), or implement a SigV4 client. |
| DDI entitlement in Portal | The Portal records `ddiLicense` but nothing in the Portal is gated on it; Finprove billing still gates installs. |
| Existing-release republishing | MD releases from before migration 002 lack verified signatures and are refused at delivery until republished through upload → sign → publish. |
| Multi-repository CI | The D3C acceptance suites need DDI, Portal and MD checkouts plus PostgreSQL; no CI job runs them yet. |
