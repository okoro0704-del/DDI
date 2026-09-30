# Digiconomy Digital Infrastructure Foundation V1

## Canonical boundary

```text
APPLICATIONS
     |
     v
DIGICONOMY DIGITAL INFRASTRUCTURE
     |
     +-- identity
     +-- communication
     +-- data
     +-- jobs
     +-- distribution
     +-- value
     +-- intelligence
     |
     v
SEVEN PRIMITIVES
```

Apps consume DDI. DDI consumes primitive capabilities. DDI is neither a replacement for the seven primitives nor an eighth primitive. PDI is a logical `InfrastructureRecord` belonging to a human inside DDI, not a new primitive or a private copy of each primitive.

## Foundation components

`packages/contracts` defines opaque infrastructure, application, binding, and relationship identifiers; records; normalized results; requests; audit records; and the primitive-adapter contract. `packages/core` supplies an explicit in-memory deterministic test store only. Production durability is blocked until the ecosystem selects a DDI database and migration ownership; no database was reset or modified.

Infrastructure records have a TrustID subject reference, type, status, applications, bindings, relationships, timestamps, and non-sensitive metadata. Application records are separate frontend deliverables with stable IDs, URLs, lifecycle state, and requested/granted capabilities. URLs are attributes, never identities.

The Portal projection deliberately returns `apps` separately from `infrastructure`, includes only safe references, and expresses missing states as `NOT_PROVISIONED`, `NOT_CONNECTED`, or `UNAVAILABLE`. It is an API read model, not a Portal UI alteration: the existing Portal requires an authenticated DDI client and configuration before it can consume this surface.

## Capability and authority pipeline

The sole pipeline is validate infrastructure and application, require verified actor, check granted capability, call the existing Digi Authority verifier boundary, resolve the binding and adapter, execute, normalize, and audit. Production authority must be backed by `@trustid/authority-verifier`; Foundation V1 takes an injected verifier so it cannot invent a second authority system. Authority claims must bind exact actor, action, resource, audience, expiry, revocation, grant, JTI, and token.

Login is never infrastructure access. An authenticated visitor may use a creator app only when separately authorized; it receives no creator infrastructure access merely by authenticating. A Digi Twin is an actor, never implicit owner.

## Primitive adapter status

| Namespace | Provider | Foundation status |
| --- | --- | --- |
| identity | TrustID | CONNECTED contract: TrustID signed assertion verifier injection; silent or summon-required result |
| communication | ElfCom | CONTRACT_ONLY; fails `PROVIDER_NOT_CONFIGURED` |
| data | DataZone | CONTRACT_ONLY; fails `PROVIDER_NOT_CONFIGURED` |
| jobs | Platform Jobs | CONTRACT_ONLY; fails `PROVIDER_NOT_CONFIGURED` |
| distribution | Master Distributor | CONTRACT_ONLY; fails `PROVIDER_NOT_CONFIGURED` |
| value | FundzMan | CONTRACT_ONLY; fails `PROVIDER_NOT_CONFIGURED` |
| intelligence | Digi AI | CONTRACT_ONLY; fails `PROVIDER_NOT_CONFIGURED` |

TrustID remains independently deployable and continues to own OIDC, passkeys, sessions, device security, biometric processing, assertion signing, and identity data. DDI does not receive those secrets. Its production integration must use TrustID's existing `POST /trust/assertions/digi`, JWKS, EdDSA-only verification, issuer/audience/temporal/JTI validation, and a DDI-owned session/actor resolution boundary.

## Provisioning and future boundaries

Provisioning is: authenticate owner through TrustID, find/create infrastructure, register app and URLs, request/grant capabilities, bind configured providers, then activate. Distribution is not faked; Master Distributor integration remains a future adapter configuration.

`executionMode` supports `APP` and `SPACE`. No DK3, Offline Kernel, Space Runtime, or frozen Dual Kernel package is copied or changed. A future Space adapter may implement the same request contract and synchronize through the existing Space/Offline Kernel boundary. Twin/PDI discovery is intentionally deferred: TrustID remains the identity verifier and Digi Authority remains the authorization authority.

## Security, audit, and blockers

The router fails closed for unknown/suspended infrastructure, unknown/cross-infrastructure/paused applications, missing actor, missing/invalid/expired/revoked/mismatched authority, ungranted capability, unconfigured provider, and unavailable provider. It never derives ownership from request content. Audits contain decisions and correlation metadata but omit assertions, tokens, credentials, biometrics, private keys, passwords, and payloads.

Production blockers: a selected durable DDI store and migration owner; a deployed DDI API; a cryptographic TrustID assertion verifier backed by its JWKS; a configured Digi Authority verifier/consumption endpoint; registered provider endpoints/credentials per primitive; and an authenticated Portal integration. Nothing in this Foundation is deployed.
