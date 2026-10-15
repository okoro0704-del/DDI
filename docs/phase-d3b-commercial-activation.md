# Phase D3B — Commercial activation, licensing and property provisioning

Flow: operator confirms payment manually → operator issues an activation code →
an authenticated owner redeems it → DDI verifies property ownership with the
Portal → entitlement and license are created → the property is connected under
the owner's existing PERSONAL PDI → licensed downloads become authorizable.

An activation code proves commercial authorization only. It never identifies
or authenticates anyone; redemption requires a canonical Digi session.

## Records (migration `005_commercial_activation.sql`, additive)

| Table | Purpose |
| --- | --- |
| `ddi_commercial_operators` | Server-side role bindings (`COMMERCIAL_ISSUER`, `COMMERCIAL_ADMIN`) for canonical owners |
| `ddi_activation_codes` | Lookup id + HMAC of the secret, plan snapshot, payment reference, expiry, single redemption |
| `ddi_entitlements` | What the owner bought; separate from identity and property ownership |
| `ddi_licenses` | Binds owner, product, entitlement, optional property; `ACTIVE`/`SUSPENDED`/`EXPIRED`/`REVOKED` |
| `ddi_activation_redemptions` | One per code; per-owner idempotency key; provisioning progress |
| `ddi_commercial_outbox` | Durable, leased provisioning jobs; payload holds a redemption id only |
| `ddi_download_grants` | SHA-256 of single-use, short-lived download tokens |
| `ddi_commercial_audits` | Every issuance, attempt, outcome, lifecycle change and download decision; no secrets |

## Activation codes

`DDI-LLLL-LLLL-SSSS-…` in Crockford base32: a 40-bit lookup id plus a 120-bit
secret from `crypto.randomBytes`. Only `HMAC-SHA256(pepper, lookup|secret)` is
stored. The plaintext is returned once, in the issuance response
(`cache-control: no-store`); an idempotent replay cannot recover it, so a lost
code is revoked and reissued. Ten invalid codes from one owner within fifteen
minutes lock that owner out of redemption for the window.

## Redemption

1. The owner must be authenticated; the code, plan, expiry and status are pre-checked.
2. For a property-bound plan, the Portal verifies ownership with purpose `bootstrap`.
3. DDI reuses the owner's PERSONAL PDI (creating the first one only if none exists).
4. One transaction locks the code row, re-checks it, connects or reuses the property,
   creates entitlement, license, redemption and outbox record, and consumes the code.

A failure before step 4 commits leaves the code `ISSUED`.

## PortalInstall bootstrap (READY cycle)

A Portal install may need DDI provisioning before it can become READY, while DDI
needs READY before granting a property privileges. The cycle is broken by
splitting verification from privilege:

- `bootstrap` verification: same owner check; an in-flight install
  (`bootstrapping`, `awaiting_domain`, `provisioning`) answers `readiness: pending`.
  Failed or suspended installs never verify.
- A new property is stored as `PENDING_ACTIVATION`. Every existing privilege path
  requires `ACTIVE`, so it carries no application, capability or download right.
- The outbox job runs two independent, idempotent steps: external provisioning
  (commercial authorization only), then property activation after an `activate`
  verification reports READY. A later `OWNERSHIP_NOT_VERIFIED` fails the property,
  suspends the license and flags the redemption `ATTENTION_REQUIRED`.

## Downloads

`POST /me/licenses/:id/downloads` returns a 256-bit, single-use token scoped to
one owner, license, product, artifact and property, valid for 30–900 s
(default 300). The Master Distributor redeems it at `POST /internal/downloads/redeem`
with `x-ddi-distributor-secret`; DDI re-verifies the license and property at that
moment, so revocation or expiry after issuance still denies. DDI never issues a
storage URL.

## Configuration

| Variable | Notes |
| --- | --- |
| `DDI_COMMERCIAL_CATALOG_PATH` or `DDI_COMMERCIAL_CATALOG` | Product/plan definitions (no prices). Absent: commercial routes answer 503. |
| `DDI_ACTIVATION_CODE_PEPPER` | ≥ 32 chars; required whenever a catalog is set. Rotating it invalidates unredeemed codes. |
| `DDI_DOWNLOAD_DISTRIBUTOR_SECRET` | ≥ 32 chars in production; absent: download redemption answers 503. |
| `DDI_DOWNLOAD_GRANT_TTL_SECONDS` | Optional; clamped to 30–900. |

Operators are bootstrapped with database access, never over HTTP:

```sh
DATABASE_URL=... node scripts/commercial-operator.ts grant <canonical-owner-id> COMMERCIAL_ADMIN
```

## Not yet integrated

- No verified Portal or Master Distributor provisioning endpoint exists. Production
  composition uses `UnavailableCommercialProvisioner`, so redemptions stay
  `PROVISIONING_PENDING` (truthfully) until a real adapter is supplied.
- The Master Distributor does not yet call `/internal/downloads/redeem`.
- No renewal operation, operator requeue for `DEAD` jobs, or live payment.
