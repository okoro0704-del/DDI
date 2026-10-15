# Phase D3D-A — CI, crash recovery and deployment safety

Local implementation only. Nothing in this phase was pushed, merged, deployed or migrated on a hosted
database, and no Railway, Netlify or GitHub setting was changed.

| Repository | Branch (local) | Base |
| --- | --- | --- |
| DDI | `feature/ddi-d3d-a-ci-recovery` | `feature/ddi-d3c-connected-infrastructure` @ `b7c3def` |
| LifeOS Portal | `feature/portal-d3d-a-bootstrap-recovery` | `feature/portal-d3c-provisioning` @ `7402344` |
| Master Distributor | `feature/md-d3d-a-idempotent-bootstrap` | `feature/md-d3c-service-security` @ `18327b7` |

## 1. Tenant bootstrap idempotency (Master Distributor)

### Before (inspected at `18327b7`)

`POST /v1/distributor/tenants/bootstrap` stored no tenant record. Its side effects were a
`domain_mappings` row (custom domain only), in-memory bus events and in-memory OAuth routes.

| Case | Behaviour before D3D-A |
| --- | --- |
| Repeated request, custom domain | Second call fails `409 Domain already provisioned`; the caller can never learn the result. |
| Repeated request, no custom domain | Every call re-emits `tenant.bootstrap.*` and re-registers OAuth: duplicate side effects. |
| Concurrent requests | Both pass the domain lookup, both call DNS/SSL providers; one insert fails with a unique violation (500). |
| Process restart | Nothing durable to consult; same as a repeated request. |
| Transaction failure | Partial side effects (domain row) block every retry with 409. |
| Lost response after success | Unrecoverable: a retry either fails (409) or duplicates. |

The Portal made it worse: each install attempt generated a fresh random tenant id
(`tid_<subdomain>_<random>`) in a write-behind store, so a retry after a crash created a **second
logical MD tenant** for the same subdomain.

### After

**Master Distributor** — `md_tenant_bootstraps` (migration 004, additive): one row per tenant id,
unique subdomain, the request fingerprint (payload + calling service + owner subject), a lease, and
the original result.

| Case | Behaviour |
| --- | --- |
| Same request after completion | `200` with the original result (same `compiledAt`), no side effects. |
| Different request for the tenant, or another caller/owner | `409 TENANT_BOOTSTRAP_CONFLICT` |
| Another tenant on the subdomain | `409 SUBDOMAIN_UNAVAILABLE` |
| Concurrent same request | Exactly one runs; others `503 TENANT_BOOTSTRAP_IN_PROGRESS` (`Retry-After: 2`), then `200`. |
| Crashed attempt | Taken over after `MD_TENANT_BOOTSTRAP_LEASE_MS` (60 s); the existing domain mapping is reused. |
| Failed attempt | Claim released; the same request can be retried at once. |
| Ledger unavailable | `503 TENANT_BOOTSTRAP_UNAVAILABLE` before any side effect. |
| Completion write fails | `503`; the lease expires and a retry redoes the (safe) steps. |

Bus events are emitted again only when a crashed or unrecorded attempt is redone (at-least-once);
a replay of a completed bootstrap emits nothing.

**Portal** — `portal.install_claims` (schema step 005, additive), used in `INSTALL_MODE=remote`:
one claim per subdomain across instances, holding the MD tenant id and the exact bootstrap payload
fixed before anything is created, the checkpointed MD result, and the ready install id.

```
claim(subdomain) ─► MD bootstrap (claim's tenant id + payload) ─► checkpoint(MD result) ─► install ready ─► flush ─► commit(install id)
        │                         ▲ test barrier here: MD done, Portal has no record
        └─ same owner retry after a crash: takeover after lease ─► MD replays original result (200)
```

- Same owner, app and domain: a crash at any point is recovered with the **original** tenant id.
- Different owner (or app/domain): `409 subdomain_unavailable`, on every instance.
- Committed: `409` (already installed); a second installation is never created.
- MD refused (4xx) before any checkpoint: the claim is released. Ambiguous failure (5xx, timeout):
  the claim is abandoned with its tenant id, and the same owner may retry at once.
- Production refuses `INSTALL_MODE=remote` without a database (claims must be shared).
- The personal (mybrandOS) install still treats an *unavailable* Master Distributor as optional, but
  claim conflicts and in-flight installs are no longer swallowed.

### Evidence

- MD (`tests/integration/tenant-bootstrap.test.ts`, memory and PostgreSQL ledgers, plus two MD
  instances sharing a database and a restart): 13 tests. Restoring the old non-idempotent behaviour
  fails 5 of the in-memory cases.
- Portal (`apps/portal-api/test/install-claims.test.ts`, memory and PostgreSQL): claim semantics,
  takeover, abandon/release, concurrency, and the remote guard against a stub MD.
- Cross-repository, real processes (`tests/e2e/d3da-crash-recovery.e2e.ts`): a Portal **process** is
  killed at a deterministic barrier after MD committed and before the Portal checkpointed; two new
  Portal processes (on different MD instances) recover. Verified: one MD tenant and one
  `tenant.bootstrap.completed` event; one downstream white-label provisioning; the stale claim was
  recovered with the crashed attempt's tenant id; the Portal recorded MD's original result; repeated
  and rival installs are refused on every instance; a two-owner race on a fresh subdomain yields one
  installation.

### Limitations

- A crash between the Portal's `flush()` of the ready install and `commit` leaves a ready row and a
  stale claim; the same owner's retry on another instance can create a second ready row. Narrow
  window; closing it needs a read-through install store (the Portal store is a per-instance cache).
- Bus events are at-least-once on recovery; consumers must tolerate duplicates.
- A subdomain bootstrapped at MD stays bound to its owner until an MD tenant release exists.

## 2. Cross-repository CI

`.github/workflows/d3-cross-repo-acceptance.yml` (DDI) and `.github/workflows/md-ci.yml` (MD) are
proposed and **inactive** until pushed.

| Control | Implementation |
| --- | --- |
| Untrusted PR code | `pull_request` / `workflow_dispatch` only; `permissions: contents: read`; `persist-credentials: false`; no cache writes. |
| No credentials | No `secrets.*`; the safety gate fails on any credential-shaped variable. |
| Pinned code | Actions and sibling repos pinned to full SHAs; the gate verifies each checkout's `HEAD`. |
| Disposable databases | `postgres:16-alpine` by digest, password = run id, loopback only. |
| Ephemeral identities | Ed25519 keys generated inside each test process (`test-*` ids, refused in production). |
| No production endpoints | Gate fails on non-loopback URLs and on Railway/Netlify/getlifeos/Supabase hostnames. |
| Health-checked startup | Postgres health check; Portal processes by `READY` + `GET /health`; ElfCom by `GET /health` (was a stdout match). |
| Separate steps | DDI · Portal · MD · D3C-B · D3C-C · D3D-A. |

The existing `ddi-postgres-verification.yml` is unchanged; it uses tag-pinned actions and no
explicit `permissions` block (repository default). Tightening it is recommended separately.

## 3. HS256 / Master Distributor caller inventory

Found by searching local checkouts at their current heads (`TRUST_ID_JWT_SECRET`, HS256 minting,
MD URLs and paths). Production environment variables were **not** read.

| Caller | Repository | What it does | Auth | Classification |
| --- | --- | --- | --- | --- |
| Portal remote installs (feature branch) | LifeOS-Portal `7402344`+ | `tenants/bootstrap`, domain status/provision | Ed25519 `lifeos-portal` | **Already Ed25519** |
| Portal remote installs (production line) | LifeOS-Portal `main` | Same paths | Forwards the user's TrustID token | **Requires migration** (ship the feature branch first) |
| DDI fulfilment ← MD | DDI | MD → DDI `/internal/downloads/redeem` | Ed25519 `master-distributor` | **Already Ed25519** |
| TrustID BaaS SDK `MasterDistributionClient` | TRUSTID `packages/baas-sdk` | `domains/provision`, domain status, `tenants/bootstrap` | HS256 (`MASTER_DISTRIBUTION_JWT_SECRET`) | **Requires migration**; `MASTER_DISTRIBUTION_MODE` defaults to `unbound` |
| Business OS APIs (`RemoteMasterDistributorAdapter`) | e-COMMERCEOS, SERVICEOS, TransportationOS | `/health`, `POST /v1/deployments` | None | **Requires migration or retirement**: MD has no `/v1/deployments` |
| LifeOS Shell API `MasterDistributorClient` | LifeOS-Shell- | `/health`, `/v1/deployments` | None | Same as above |
| `scripts/deploy-distribution.ts` | LifeOS-Shell- | `/v1/releases` on the LifeOS API hub (default `lucid-integrity-…`), HS256 push to `distribution-hub` | Static bearer; HS256 | **Not an MD caller**; HS256 belongs to Platform Jobs |
| Platform Jobs engine and `distribution-hub` | platformjob | Own APIs; verify and mint HS256 | HS256 (`TRUST_ID_JWT_SECRET`) | **Not an MD caller** (no MD URL found); HS256 is internal to Platform Jobs |
| mybrandOS API | mybrandOS | Reads `MASTER_DISTRIBUTOR_URL` (config plumbing only) | — | **Unknown**: no MD call found |
| DataZone | DataZone | Verifies HS256 for its own APIs | HS256 | **Not an MD caller** |
| MD webhooks (`/v1/distributor/webhooks`) | — | `webhooks:ingest` | — | **Unknown / externally managed**: no caller found locally |

Railway (read-only, D3C): the `MasternDistribution` service has **no public domain**, so external
callers cannot reach production MD today; only same-project private networking can. Hosted callers
and their environment are therefore **unverified**.

### Compatibility-first cutover (not executed)

1. Inventory confirmation (read-only): list variable *names* (not values) for every service with
   `MASTER_DISTRIBUTOR_URL`/`MASTER_DISTRIBUTION_*`; check MD access logs for callers and paths.
2. Issue an Ed25519 identity per caller (KMS-held), and add it to MD's `MD_TRUSTED_SERVICES` with the
   least permissions it needs.
3. Ship caller support first (Portal feature branch; a TrustID SDK signer; retire `/v1/deployments`
   clients or point them at nothing).
4. Gate MD's deploy (section 4), then deploy MD with **both** paths: an explicit, time-boxed
   `MD_ACCEPT_LEGACY_HS256=until:<date>` compatibility verifier that logs every legacy use, maps a
   legacy caller to a fixed, minimal permission set, and is refused in production after the date.
   (Not implemented in D3D-A: MD's branch currently rejects HS256 outright; implement only if step 1
   finds a legacy caller that cannot move first.)
5. Move callers one at a time; watch the legacy-use log reach zero; remove the compatibility path
   and the `TRUST_ID_JWT_SECRET`/`MASTER_DISTRIBUTION_JWT_SECRET` variables.

**Rollback:** redeploy the previous MD deployment (migrations 002–004 are additive and ignored by
older code); callers keep their Ed25519 configuration, which older MD ignores; the HS256 secret is not
rotated until step 5, so rollback needs no key change.

## 4. Deployment gating proposal (no settings changed)

Observed (read-only, D3C): MD and six Portal services auto-deploy on push to `main`, without waiting for
CI; PR environments are off everywhere.

| Option | Prevents an incompatible merge from deploying? | Cost |
| --- | --- | --- |
| Railway "wait for CI" (check suites) | Only blocks on failing checks; a green but incompatible change still deploys on merge. MD has no CI yet. | Low |
| Dedicated release branch (`release/production`) as Railway's deploy branch | Yes: merging to `main` deploys nothing; promotion is a deliberate fast-forward. | Low; one promotion step |
| Manual deployment (disconnect the repo trigger; `railway up`/redeploy) | Yes, but relies on people and local state; weak audit trail. | Medium |
| Protected GitHub release workflow (environment with required reviewers) | Yes, with approvals, audit and ordering across repos; needs a Railway deploy token in a protected environment secret. | Medium |

**Recommendation:** point each production service at a protected `release/production` branch now
(no tokens needed), and enable "wait for CI" on it. Promotion is a reviewed fast-forward of
`release/production` to a commit whose CI is green, done in dependency order: callers' Ed25519
support before MD; DDI and Portal schema before code that uses it. Later, replace manual promotion
with a protected GitHub `production` environment that has required reviewers and an ordered
multi-repository release.

## 5. D3D-B contracts (proposed, not implemented)

### Authority grant revocation on install retirement

`POST /authority/grants/revoke` on Authority, authenticated by a DDI service token
(`digiconomy-service+jwt`, `aud=authority`, permission `grants:revoke-for-property`).
Body `{ contractVersion: "authority.revoke.v1", ownerSubject, propertyId, reason:
"PROPERTY_RETIRED" | "OWNER_MISMATCH" | "OPERATOR", sourceEventId }`. Idempotent by `sourceEventId`;
revokes every grant bound to the property and returns `{ revoked: [grantId], alreadyRevoked: [...] }`.
DDI calls it from the install-state handler (retirement is terminal) through its leased outbox;
until it succeeds, the local denial stays in force.

### Delivery tokens out of URL paths

`POST /v1/delivery` with `Authorization: Delivery <token>` (or the token in a JSON body), returning
the bytes; `GET /v1/delivery/:token` is kept for one release, logged as deprecated, then removed.
Log and CDN rules redact `/v1/delivery/*`. Tokens stay single-use, version-pinned, ≤ 300 s.

### Portal DDI-license enforcement

An install with `ddiProvisioning` is usable only while its DDI license is `ACTIVE`: the Portal checks
the bound license state (pushed by DDI install-state/license events, cached with a sequence) before
launch URLs, tenant APIs and downloads. Finprove billing remains the gate for installs without a DDI
binding. States: `ACTIVE` → full; `SUSPENDED` → read-only owner access; `REVOKED`/`EXPIRED` →
blocked with an explicit reason. Decide the Finprove relationship before implementing.

### Signing-key management and rotation

- Keys: one Ed25519 key per service identity and per artifact publisher, held in KMS/HSM; services
  receive a signing handle, never PEM in environment variables.
- Distribution: verifiers pin `kid → public key` per issuer in configuration; multiple `kid`s are
  already supported.
- Rotation: add the new public key to every verifier → switch the signer to the new `kid` → after
  the maximum token lifetime plus skew (≤ 330 s) for service tokens, or after republishing for
  artifact signatures, remove the old key. Emergency revocation removes the `kid` immediately.
- Production already refuses `test-*` key ids; add an expiry date to every pinned key and alert
  30 days before it.
