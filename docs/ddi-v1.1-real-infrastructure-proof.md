# DDI V1.1 real infrastructure proof

## Baseline and TrustID contract

Foundation V1 began at 11 passing deterministic tests. TrustID runtime source, not only its documentation, establishes the contract consumed here: `POST /trust/assertions/digi` derives `sub` from the authenticated TrustID session, ignores caller subject/audience input, signs EdDSA JWTs, sets issuer, fixed Digi audience, `iat`, `nbf`, `exp`, and `jti`, and publishes JWKS at `/.well-known/jwks.json`. DDI's `CanonicalTrustIdVerifier` dynamically loads the existing `@trustid/digi-bridge` verifier, which validates JWKS signature, EdDSA-only algorithm, issuer, audience, temporal claims, subject, and JTI before yielding an actor.

`CanonicalTrustIdVerifier` is production-shaped only when configured with an explicit TrustID issuer, audience, JWKS endpoint, and canonical bridge-module URL. It fails closed. Test proofs use a clearly named controlled fixture and are not a production TrustID service.

## Persistence and lifecycle

`migrations/001_ddi_foundation.sql` is the DDI-owned PostgreSQL schema: it creates records for infrastructure, applications, primitive bindings, relationships, audits, and idempotency. It is an explicit migration; it is not run at process startup and contains no reset, drop, seed, or force-push behavior.

`JsonTestStore` is deliberately limited to deterministic local/test restart evidence. It uses atomic replace writes and is never described as production persistence. PostgreSQL repository wiring, a configured `DATABASE_URL`, and a migration runner remain blockers before production use.

The V1.1 durable service provisions from a verified actor only, persists an OWNER relation in the same save, requires an idempotency key, requires the durable owner relation to register an app, validates optional URLs, persists the app/relationship/binding, and creates append-only safe audit records. Owner cannot be supplied in a request body.

## Identity, ownership, authority, and routing

TrustID proves authentication, never infrastructure ownership. DDI's durable OWNER relationship controls management. V1.1's real primitive route is `identity.currentActor`: verified TrustID assertion -> DDI infrastructure/application context -> TrustID identity adapter -> normalized result -> durable audit. Missing or invalid evidence returns an interaction object requesting TrustID; DDI does not embed or impersonate TrustID UI.

The Foundation's Digi Authority boundary remains unchanged. A production consequential route must supply the existing authority-verifier and consumption configuration; V1.1 does not mint grants or create a parallel permission system. Bootstrap owner management and delegated application capability authorization remain distinct.

## Portal, health, and space

The read model returns `{ apps, infrastructure }`, with an object keyed by capability and only honest `CONNECTED`, `NOT_CONNECTED`, or `NOT_PROVISIONED` states. It fabricates no external IDs. Portal source is intentionally untouched. `APP | SPACE` remains part of the contract; no Space/DK3 work is implemented.

A network HTTP API, CORS policy, production environment validation, PostgreSQL health checks, and full authority service health are not yet implemented. Consequently no `GET /health` production claim is made.

## Proof and V1.2 requirements

The deterministic restart test proves unchanged IDs, relationships, binding, and allow/deny audit after fresh service construction. It proves Actor B cannot register an app on Actor A's infrastructure, cannot use App A against Infrastructure B, and does not gain application/PDI linkage by authenticating.

Before V1.2/production: implement a PostgreSQL repository against this migration; provide authenticated HTTP endpoints; add explicit configuration/CORS/health validation; run a live controlled TrustID assertion through configured JWKS; wire the existing Digi Authority verifier and consumption endpoint; then perform a process-level PostgreSQL restart proof. No Portal, LifeOS, Dual Kernel, Space Runtime, or primitive source changes are required for that work.
