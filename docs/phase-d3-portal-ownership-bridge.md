# Phase D3 — Portal ownership bridge

## Implemented boundary

`POST /internal/ddi/ownership/verify` is an internal LifeOS Portal route. It
accepts only DDI's configured service credential and queries the authoritative
`PortalInstall` record. A response is issued only when the supplied canonical
TrustID subject exactly equals `PortalInstall.ownerTrustId` and the install is
`ready` and not suspended.

DDI's `POST /me/pdi/properties` no longer accepts `ownershipEvidence`. The
runtime calls the configured Portal verifier, checks that its response binds
the same canonical subject, external system, and external reference, rejects
expired responses, and stores only a non-secret receipt hash. Production DDI
composition requires `PORTAL_OWNERSHIP_URL` and
`PORTAL_OWNERSHIP_SHARED_SECRET`; missing configuration fails closed.

The external reference format for this bridge is `portal-install:<install-id>`.
It is an authoritative Portal install reference, not a catalog slug or client
form value. The request is a fresh authenticated lookup, so the returned
receipt is not a bearer assertion that can be replayed by a browser.

## Preserved boundaries

Portal TrustID authentication feature flags are unchanged. This route does not
enable TrustID sign-in, accept an end-user session, create a PDI, mint an
Authority grant, or grant a primitive capability. DDI keeps the one-PDI-per-
owner constraint and only connects verified properties to that PDI.

## Remaining D3 work before staging

Commercial activation is **not implemented** by this bridge. Existing Portal
`PortalBilling` records prove the current Finprove checkout/install flow only;
they do not satisfy D3 activation-code requirements. A staging candidate needs
a durable, PostgreSQL-atomic activation-code/entitlement/outbox model with
hashed single-use codes, expiry/revocation, operator audit, idempotent DDI
provisioning retries, and protected-download decisions.

Likewise, D2 retains local property denial when Digi Authority is unavailable,
but this repository has no verified live Authority endpoint or durable external
revocation retry worker. Real Authority grant revocation and retry evidence,
clean remote CI, isolated staging secrets, and the Portal commercial workflow
remain staging gates.

## Focused evidence

- Portal internal verifier: ready owner accepted; forged service credential,
  cross-owner reference, and non-ready install rejected.
- DDI verifier: response subject/reference binding, malformed response,
  expired response, and upstream unavailability fail closed.
- DDI production composition refuses missing Portal verification configuration.
