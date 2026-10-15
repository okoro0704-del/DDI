# DDI Phase D1: connected digital properties

DDI has one PERSONAL infrastructure per canonical Digi owner. A connected property is a PDI-owned reference to a personal brand, business, Space, or application; it is not an owner, session, credential, Authority grant, or replacement PDI.

## Provisioning contract

`POST /me/pdi/properties` requires a canonical Digi Core bearer session. The caller's owner is resolved by DDI; the request contains no owner id. It accepts `type`, `externalSystem`, `externalReference`, `displayName`, `ownershipEvidence`, and an `Idempotency-Key`. The response returns the existing or newly created PERSONAL PDI, the connected-property id, and `created`.

The external-system/reference pair is globally unique. A retry with the same owner and idempotency key returns the same property. A conflicting reference belonging to another PDI fails closed.

## Property scope and lifecycle

An application can declare `propertyId` only for an ACTIVE property owned by its PDI. Its Authority resource becomes `ddi:pdi:<pdi>:property:<property>:<capability>`. Legacy applications retain the existing PDI-wide resource format.

Property revocation first persists `REVOKED`, so DDI denies a property-bound request before consulting an Authority cache. DDI then enumerates only the connections recorded for that property and calls the actual Authority `POST /authority/grants/:grantId/revoke` operation once for every recorded grant. Digi Authority exposes no verified bulk property-revocation operation; DDI does not invent one. If individual Authority invalidation is unavailable, the property remains locally fail-closed and the operation reports `PROPERTY_GRANT_REVOCATION_PENDING` for retry and operator visibility.

Property-bound execution also requires the stored connection binding to match the submitted actor, action, resource, and audience exactly. This prevents a property application from substituting a legacy PDI-wide resource, another property's binding, or an alternative application identifier. A legacy PDI-wide application remains an intentionally separate owner-approved PDI-wide grant; it is not a substitute credential for a revoked property application.

## LifeOS Portal integration contract

The Portal authenticates the Digi owner through the approved Digi session flow, forwards that bearer session unchanged, and never supplies an owner id or creates PDI credentials. It uses a stable external reference and idempotency key for every brand/property registration.

```http
POST /me/pdi/properties
Authorization: Bearer <canonical-digi-session>
Idempotency-Key: lifeos-brand-<stable-brand-id>
Content-Type: application/json

{
  "type": "PERSONAL_BRAND",
  "externalSystem": "lifeos",
  "externalReference": "brand:<stable-brand-id>",
  "displayName": "Example Brand",
  "ownershipEvidence": "<provider-issued-reference>"
}
```

```json
{
  "infrastructure": { "id": "infra:<canonical-pdi>", "type": "PERSONAL" },
  "property": { "id": "property:<connected-property>", "infrastructureId": "infra:<canonical-pdi>", "status": "ACTIVE" },
  "created": true
}
```

The Portal persists both returned identifiers with its own brand record and creates brand deliverables only after this response. Retrying the same key returns the original property. A conflict on an external system/reference fails closed; revocation is handled with `POST /properties/:id/revoke` by the canonical owner, and partial Portal work remains Portal-owned for compensation.

`ownershipEvidence` is currently retained as an opaque audit value, not independently verified against a LifeOS ownership authority. Production Portal provisioning therefore requires a reviewed, signature-verified ownership-evidence adapter before treating an arbitrary Portal assertion as proof of ownership. No such adapter was fabricated in D2.

## Deployment configuration

Production requires `TRUSTID_BRIDGE_MODULE_URL` and `DIGI_AUTHORITY_VERIFIER_MODULE_URL`: deployable URLs accepted by Node ESM import and resolving to the built canonical TrustID bridge and Authority verifier. DDI does not supply an absolute developer-machine default. Issuer, audience, JWKS, and signature verification remain mandatory.

The PostgreSQL CI workflow is `.github/workflows/ddi-postgres-verification.yml`; it uses an isolated PostgreSQL service and pins TrustID to `8bf7852d14fe91ba28670768c7f3b2c898ce581b` and ElfCom to `f0b7e7213e4b0c8bf0efe560212ec1cd3764bdbf`. Multi-owner businesses and legal transfers require a future explicit delegated-administrator/transfer model; D1 intentionally does not infer them from metadata.
