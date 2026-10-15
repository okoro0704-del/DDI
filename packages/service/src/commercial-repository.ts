import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import type { ActivationCodeId, ActivationCodeRecord, CommercialAuditRecord, CommercialOperatorRole, CommercialPlan, CommercialStatus, ConnectedProperty, ConnectedPropertyType, DigiOwnerId, Entitlement, License, Redemption, RedemptionStatus } from "../../contracts/src/index.ts";
import { ACTIVATION_HASH_VERSION, sameDigest } from "./activation-code.ts";

type CodeRow = { id: string; lookup_id: string; secret_hash: string; product_id: string; plan_id: string; plan_snapshot: CommercialPlan; catalog_version: string; payment_reference: string; issued_by: string; status: ActivationCodeRecord["status"]; created_at: Date; expires_at: Date; redeemed_by_owner_id: string | null; redeemed_at: Date | null; redemption_id: string | null; revoked_at: Date | null };
type EntitlementRow = { id: string; owner_id: string; infrastructure_id: string; product_id: string; plan_id: string; edition: string; license_type: Entitlement["licenseType"]; property_id: string | null; status: CommercialStatus; activated_at: Date; expires_at: Date | null; renewable: boolean; downloads: string[]; source_code_id: string; status_reason: string | null; created_at: Date; updated_at: Date };
type LicenseRow = { id: string; entitlement_id: string; owner_id: string; infrastructure_id: string; product_id: string; plan_id: string; property_id: string | null; status: CommercialStatus; issued_at: Date; expires_at: Date | null; restrictions: License["restrictions"]; revision: number; status_reason: string | null; created_at: Date; updated_at: Date };
type RedemptionRow = { id: string; code_id: string; owner_id: string; owner_trust_subject: string | null; idempotency_key: string; infrastructure_id: string; property_id: string | null; entitlement_id: string; license_id: string; status: RedemptionStatus; provisioning_reference: string | null; provisioned_at: Date | null; activated_at: Date | null; last_error: string | null; created_at: Date; updated_at: Date };
type PropertyRow = { id: string; infrastructure_id: string; owner_id: string; property_type: ConnectedPropertyType; external_system: string; external_reference: string; display_name: string; status: ConnectedProperty["status"]; ownership_evidence: string; created_at: Date; updated_at: Date; revoked_at: Date | null };
export type OutboxJob = { id: string; kind: string; aggregateId: string; payload: { redemptionId: string }; attempts: number; maxAttempts: number; leaseToken: string };
export type DownloadGrantRow = { id: string; owner_id: string; license_id: string; entitlement_id: string; product_id: string; artifact_id: string; artifact_version: string | null; property_id: string | null; status: "ISSUED" | "CONSUMED"; expires_at: Date; consumed_at: Date | null };
export type LifecycleAction = "SUSPEND" | "REINSTATE" | "REVOKE";

const CODE_COLUMNS = "id, lookup_id, secret_hash, product_id, plan_id, plan_snapshot, catalog_version, payment_reference, issued_by, status, created_at, expires_at, redeemed_by_owner_id, redeemed_at, redemption_id, revoked_at";
const ENTITLEMENT_COLUMNS = "id, owner_id, infrastructure_id, product_id, plan_id, edition, license_type, property_id, status, activated_at, expires_at, renewable, downloads, source_code_id, status_reason, created_at, updated_at";
const LICENSE_COLUMNS = "id, entitlement_id, owner_id, infrastructure_id, product_id, plan_id, property_id, status, issued_at, expires_at, restrictions, revision, status_reason, created_at, updated_at";
const REDEMPTION_COLUMNS = "id, code_id, owner_id, owner_trust_subject, idempotency_key, infrastructure_id, property_id, entitlement_id, license_id, status, provisioning_reference, provisioned_at, activated_at, last_error, created_at, updated_at";
const PROPERTY_COLUMNS = "id, infrastructure_id, owner_id, property_type, external_system, external_reference, display_name, status, ownership_evidence, created_at, updated_at, revoked_at";

const iso = (value: Date | string) => new Date(value).toISOString();
const optionalIso = (value: Date | null) => value ? iso(value) : undefined;
const uniqueViolation = (error: unknown) => !!error && typeof error === "object" && (error as { code?: string }).code === "23505";

export type RedeemInput = {
  ownerId: DigiOwnerId;
  trustSubject?: string;
  infrastructureId: string;
  lookupId: string;
  presentedHash: string;
  idempotencyKey: string;
  correlationId: string;
  at: Date;
  maxAttempts: number;
  property?: { type: ConnectedPropertyType; externalSystem: string; externalReference: string; displayName: string; ownershipEvidence: string };
};

export class PostgresCommercialRepository {
  private pool: Pool;
  constructor(pool: Pool) { this.pool = pool; }

  private async transaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await fn(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally { client.release(); }
  }

  async audit(event: CommercialAuditRecord, client: Pool | PoolClient = this.pool) {
    await client.query(`INSERT INTO ddi_commercial_audits (id, event_type, correlation_id, actor, owner_id, code_id, entitlement_id, license_id, property_id, redemption_id, product_id, result, reason, timestamp) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`, [randomUUID(), event.eventType, event.correlationId, event.actor ?? null, event.ownerId ?? null, event.codeId ?? null, event.entitlementId ?? null, event.licenseId ?? null, event.propertyId ?? null, event.redemptionId ?? null, event.productId ?? null, event.result, event.reason ?? null, event.timestamp]);
  }

  async audits(): Promise<CommercialAuditRecord[]> {
    const result = await this.pool.query<{ event_type: CommercialAuditRecord["eventType"]; correlation_id: string; actor: string | null; owner_id: string | null; code_id: string | null; entitlement_id: string | null; license_id: string | null; property_id: string | null; redemption_id: string | null; product_id: string | null; result: string; reason: string | null; timestamp: Date }>(`SELECT event_type, correlation_id, actor, owner_id, code_id, entitlement_id, license_id, property_id, redemption_id, product_id, result, reason, timestamp FROM ddi_commercial_audits ORDER BY timestamp, id`);
    return result.rows.map(row => ({ eventType: row.event_type, correlationId: row.correlation_id, actor: row.actor ?? undefined, ownerId: (row.owner_id ?? undefined) as DigiOwnerId | undefined, codeId: (row.code_id ?? undefined) as CommercialAuditRecord["codeId"], entitlementId: (row.entitlement_id ?? undefined) as CommercialAuditRecord["entitlementId"], licenseId: (row.license_id ?? undefined) as CommercialAuditRecord["licenseId"], propertyId: (row.property_id ?? undefined) as CommercialAuditRecord["propertyId"], redemptionId: (row.redemption_id ?? undefined) as CommercialAuditRecord["redemptionId"], productId: row.product_id ?? undefined, result: row.result, reason: row.reason ?? undefined, timestamp: iso(row.timestamp) }));
  }

  /* Operators: server-side role bindings for canonical Digi owners. */
  async operatorRole(ownerId: string): Promise<CommercialOperatorRole | null> {
    const result = await this.pool.query<{ role: CommercialOperatorRole }>(`SELECT role FROM ddi_commercial_operators WHERE owner_id = $1 AND status = 'ACTIVE'`, [ownerId]);
    return result.rows[0]?.role ?? null;
  }
  async setOperator(ownerId: string, role: CommercialOperatorRole | null, grantedBy: string, at: Date) {
    await this.transaction(async client => {
      if (role) await client.query(`INSERT INTO ddi_commercial_operators (owner_id, role, status, granted_by, created_at, updated_at) VALUES ($1,$2,'ACTIVE',$3,$4,$4) ON CONFLICT (owner_id) DO UPDATE SET role = EXCLUDED.role, status = 'ACTIVE', granted_by = EXCLUDED.granted_by, updated_at = EXCLUDED.updated_at`, [ownerId, role, grantedBy, iso(at)]);
      else await client.query(`UPDATE ddi_commercial_operators SET status = 'REVOKED', granted_by = $2, updated_at = $3 WHERE owner_id = $1`, [ownerId, grantedBy, iso(at)]);
      await this.audit({ eventType: role ? "OPERATOR_GRANTED" : "OPERATOR_REVOKED", correlationId: randomUUID(), actor: grantedBy, ownerId: ownerId as DigiOwnerId, result: role ?? "REVOKED", timestamp: iso(at) }, client);
    });
  }

  /* Activation codes */
  async insertCode(input: { lookupId: string; secretHash: string; plan: CommercialPlan; catalogVersion: string; paymentReference: string; issuedBy: string; idempotencyKey: string; at: Date; expiresAt: Date; correlationId: string }): Promise<{ record: ActivationCodeRecord; created: boolean }> {
    return this.transaction(async client => {
      const prior = await client.query<CodeRow>(`SELECT ${CODE_COLUMNS} FROM ddi_activation_codes WHERE issued_by = $1 AND issue_idempotency_key = $2`, [input.issuedBy, input.idempotencyKey]);
      if (prior.rows[0]) {
        if (prior.rows[0].product_id !== input.plan.productId || prior.rows[0].plan_id !== input.plan.planId || prior.rows[0].payment_reference !== input.paymentReference) throw new Error("IDEMPOTENCY_CONFLICT");
        return { record: mapCode(prior.rows[0]), created: false };
      }
      const id = `actcode:${randomUUID()}`;
      await client.query("SAVEPOINT ddi_code_insert");
      try {
        await client.query(`INSERT INTO ddi_activation_codes (id, lookup_id, secret_hash, hash_version, product_id, plan_id, plan_snapshot, catalog_version, payment_reference, issued_by, issue_idempotency_key, status, created_at, expires_at) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,$11,'ISSUED',$12,$13)`, [id, input.lookupId, input.secretHash, ACTIVATION_HASH_VERSION, input.plan.productId, input.plan.planId, JSON.stringify(input.plan), input.catalogVersion, input.paymentReference, input.issuedBy, input.idempotencyKey, iso(input.at), iso(input.expiresAt)]);
      } catch (error) {
        if (!uniqueViolation(error)) throw error;
        await client.query("ROLLBACK TO SAVEPOINT ddi_code_insert");
        const raced = await client.query<CodeRow>(`SELECT ${CODE_COLUMNS} FROM ddi_activation_codes WHERE issued_by = $1 AND issue_idempotency_key = $2`, [input.issuedBy, input.idempotencyKey]);
        if (raced.rows[0]) return { record: mapCode(raced.rows[0]), created: false };
        // A 40-bit lookup collision. The caller regenerates the whole code.
        throw new Error("ACTIVATION_LOOKUP_COLLISION");
      }
      await this.audit({ eventType: "ACTIVATION_CODE_ISSUED", correlationId: input.correlationId, actor: input.issuedBy, codeId: id as ActivationCodeId, productId: input.plan.productId, result: "ISSUED", timestamp: iso(input.at) }, client);
      const created = await client.query<CodeRow>(`SELECT ${CODE_COLUMNS} FROM ddi_activation_codes WHERE id = $1`, [id]);
      return { record: mapCode(created.rows[0]!), created: true };
    });
  }

  async findCodeByLookup(lookupId: string): Promise<{ record: ActivationCodeRecord; secretHash: string } | null> {
    const result = await this.pool.query<CodeRow>(`SELECT ${CODE_COLUMNS} FROM ddi_activation_codes WHERE lookup_id = $1`, [lookupId]);
    return result.rows[0] ? { record: mapCode(result.rows[0]), secretHash: result.rows[0].secret_hash } : null;
  }
  async getCode(id: string) {
    const result = await this.pool.query<CodeRow>(`SELECT ${CODE_COLUMNS} FROM ddi_activation_codes WHERE id = $1`, [id]);
    return result.rows[0] ? mapCode(result.rows[0]) : null;
  }
  async revokeCode(id: string, actor: string, at: Date, correlationId: string) {
    return this.transaction(async client => {
      const result = await client.query<CodeRow>(`SELECT ${CODE_COLUMNS} FROM ddi_activation_codes WHERE id = $1 FOR UPDATE`, [id]);
      const row = result.rows[0];
      if (!row) throw new Error("ACTIVATION_CODE_NOT_FOUND");
      if (row.status === "REVOKED") return mapCode(row);
      if (row.status === "REDEEMED") throw new Error("ACTIVATION_CODE_ALREADY_REDEEMED");
      const updated = await client.query<CodeRow>(`UPDATE ddi_activation_codes SET status = 'REVOKED', revoked_at = $2, revoked_by = $3 WHERE id = $1 RETURNING ${CODE_COLUMNS}`, [id, iso(at), actor]);
      await this.audit({ eventType: "ACTIVATION_CODE_REVOKED", correlationId, actor, codeId: id as ActivationCodeId, productId: row.product_id, result: "REVOKED", timestamp: iso(at) }, client);
      return mapCode(updated.rows[0]!);
    });
  }

  /** Guessing signal only: invalid codes. Upstream outages never lock an owner out. */
  async recentFailedRedemptions(ownerId: string, since: Date) {
    const result = await this.pool.query<{ n: string }>(`SELECT count(*)::text AS n FROM ddi_commercial_audits WHERE owner_id = $1 AND event_type = 'REDEMPTION_FAILED' AND reason = 'ACTIVATION_CODE_INVALID' AND timestamp > $2`, [ownerId, iso(since)]);
    return Number(result.rows[0]?.n ?? 0);
  }

  /**
   * One transaction: lock the code row, re-check hash/status/expiry, connect
   * or reuse the property under the owner's existing PDI, create entitlement,
   * license, redemption and outbox record, then consume the code. Concurrent
   * redeemers serialize on the code row lock; the loser sees REDEEMED.
   */
  async redeem(input: RedeemInput): Promise<{ redemption: Redemption; replayed: boolean }> {
    return this.transaction(async client => {
      const replay = async () => {
        const prior = await client.query<RedemptionRow & { lookup_id: string; secret_hash: string }>(`SELECT r.${REDEMPTION_COLUMNS.split(", ").join(", r.")}, c.lookup_id, c.secret_hash FROM ddi_activation_redemptions r JOIN ddi_activation_codes c ON c.id = r.code_id WHERE r.owner_id = $1 AND r.idempotency_key = $2`, [input.ownerId, input.idempotencyKey]);
        const row = prior.rows[0];
        if (!row) return null;
        if (row.lookup_id !== input.lookupId || !sameDigest(row.secret_hash, input.presentedHash)) throw new Error("IDEMPOTENCY_CONFLICT");
        return { redemption: mapRedemption(row), replayed: true };
      };
      const earlier = await replay();
      if (earlier) return earlier;
      const locked = await client.query<CodeRow>(`SELECT ${CODE_COLUMNS} FROM ddi_activation_codes WHERE lookup_id = $1 FOR UPDATE`, [input.lookupId]);
      const code = locked.rows[0];
      if (!code || !sameDigest(code.secret_hash, input.presentedHash)) throw new Error("ACTIVATION_CODE_INVALID");
      if (code.status === "REDEEMED") {
        // The same owner retrying the same request after a concurrent commit gets the original result.
        if (code.redeemed_by_owner_id === input.ownerId) { const again = await replay(); if (again) return again; }
        throw new Error("ACTIVATION_CODE_ALREADY_REDEEMED");
      }
      if (code.status === "REVOKED") throw new Error("ACTIVATION_CODE_REVOKED");
      if (code.expires_at.getTime() <= input.at.getTime()) throw new Error("ACTIVATION_CODE_EXPIRED");
      const plan = code.plan_snapshot;
      if (plan.requiresProperty && !input.property) throw new Error("PROPERTY_REQUIRED");
      if (!plan.requiresProperty && input.property) throw new Error("PROPERTY_NOT_APPLICABLE");
      if (input.property && !plan.propertyTypes.includes(input.property.type)) throw new Error("PROPERTY_TYPE_NOT_ENTITLED");
      const pdi = await client.query<{ id: string }>(`SELECT id FROM ddi_infrastructures WHERE id = $1 AND owner_id = $2 AND type = 'PERSONAL' AND status = 'ACTIVE' FOR SHARE`, [input.infrastructureId, input.ownerId]);
      if (!pdi.rows[0]) throw new Error("PERSONAL_PDI_REQUIRED");
      const at = iso(input.at);
      const redemptionId = `redemption:${randomUUID()}`;
      let propertyId: string | undefined;
      if (input.property) {
        const property = input.property;
        const existing = async () => {
          const prior = await client.query<PropertyRow>(`SELECT ${PROPERTY_COLUMNS} FROM ddi_connected_properties WHERE external_system = $1 AND external_reference = $2 FOR UPDATE`, [property.externalSystem, property.externalReference]);
          const row = prior.rows[0];
          if (!row) return undefined;
          // Purchasing a product never transfers or shares someone else's property.
          if (row.owner_id !== input.ownerId || row.infrastructure_id !== input.infrastructureId) throw new Error("PROPERTY_REFERENCE_CONFLICT");
          if (row.property_type !== property.type) throw new Error("PROPERTY_TYPE_MISMATCH");
          if (row.status !== "ACTIVE" && row.status !== "PENDING_ACTIVATION") throw new Error("PROPERTY_NOT_ACTIVATABLE");
          return row.id;
        };
        propertyId = await existing();
        if (!propertyId) {
          const id = `property:${randomUUID()}`;
          await client.query("SAVEPOINT ddi_commercial_property");
          try {
            await client.query(`INSERT INTO ddi_connected_properties (id, infrastructure_id, owner_id, property_type, external_system, external_reference, display_name, status, ownership_evidence, provisioning_idempotency_key, created_at, updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,'PENDING_ACTIVATION',$8,$9,$10,$10)`, [id, input.infrastructureId, input.ownerId, property.type, property.externalSystem, property.externalReference, property.displayName, property.ownershipEvidence, `commercial:${redemptionId}`, at]);
            await client.query(`INSERT INTO ddi_connection_audits (id, event_type, correlation_id, owner_id, infrastructure_id, property_id, result, timestamp) VALUES ($1,'PROPERTY_CONNECTED',$2,$3,$4,$5,'PENDING_ACTIVATION',$6)`, [randomUUID(), input.correlationId, input.ownerId, input.infrastructureId, id, at]);
            propertyId = id;
          } catch (error) {
            if (!uniqueViolation(error)) throw error;
            await client.query("ROLLBACK TO SAVEPOINT ddi_commercial_property");
            propertyId = await existing();
            if (!propertyId) throw error;
          }
        }
      }
      const expiresAt = plan.licenseType === "TERM" && plan.termDays ? iso(new Date(input.at.getTime() + plan.termDays * 86_400_000)) : null;
      const entitlementId = `entitlement:${randomUUID()}`;
      const licenseId = `license:${randomUUID()}`;
      await client.query(`INSERT INTO ddi_entitlements (id, owner_id, infrastructure_id, product_id, plan_id, edition, license_type, property_id, status, activated_at, expires_at, renewable, downloads, source_code_id, created_at, updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'ACTIVE',$9,$10,$11,$12::jsonb,$13,$9,$9)`, [entitlementId, input.ownerId, input.infrastructureId, plan.productId, plan.planId, plan.edition, plan.licenseType, propertyId ?? null, at, expiresAt, plan.renewable, JSON.stringify(plan.downloads), code.id]);
      await client.query(`INSERT INTO ddi_licenses (id, entitlement_id, owner_id, infrastructure_id, product_id, plan_id, property_id, status, issued_at, expires_at, restrictions, created_at, updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,'ACTIVE',$8,$9,$10::jsonb,$8,$8)`, [licenseId, entitlementId, input.ownerId, input.infrastructureId, plan.productId, plan.planId, propertyId ?? null, at, expiresAt, JSON.stringify({ propertyBound: !!propertyId })]);
      await client.query(`INSERT INTO ddi_activation_redemptions (id, code_id, owner_id, owner_trust_subject, idempotency_key, infrastructure_id, property_id, entitlement_id, license_id, status, created_at, updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'PROVISIONING_PENDING',$10,$10)`, [redemptionId, code.id, input.ownerId, input.trustSubject ?? null, input.idempotencyKey, input.infrastructureId, propertyId ?? null, entitlementId, licenseId, at]);
      await client.query(`INSERT INTO ddi_commercial_outbox (id, kind, aggregate_id, dedupe_key, payload, status, attempts, max_attempts, next_attempt_at, created_at, updated_at) VALUES ($1,'PROPERTY_PROVISIONING',$2,$3,$4::jsonb,'PENDING',0,$5,$6,$6,$6)`, [`outbox:${randomUUID()}`, redemptionId, `provision:${redemptionId}`, JSON.stringify({ redemptionId }), input.maxAttempts, at]);
      const consumed = await client.query(`UPDATE ddi_activation_codes SET status = 'REDEEMED', redeemed_by_owner_id = $2, redeemed_at = $3, redemption_id = $4 WHERE id = $1 AND status = 'ISSUED'`, [code.id, input.ownerId, at, redemptionId]);
      if (consumed.rowCount !== 1) throw new Error("ACTIVATION_CODE_ALREADY_REDEEMED");
      const base = { correlationId: input.correlationId, actor: `owner:${input.ownerId}`, ownerId: input.ownerId, codeId: code.id as ActivationCodeId, redemptionId: redemptionId as Redemption["id"], entitlementId: entitlementId as Entitlement["id"], licenseId: licenseId as License["id"], propertyId: propertyId as Redemption["propertyId"], productId: plan.productId, timestamp: at };
      await this.audit({ ...base, eventType: "REDEMPTION_SUCCEEDED", result: "REDEEMED" }, client);
      await this.audit({ ...base, eventType: "ENTITLEMENT_CREATED", result: "ACTIVE" }, client);
      await this.audit({ ...base, eventType: "LICENSE_ISSUED", result: "ACTIVE" }, client);
      await this.audit({ ...base, eventType: "PROVISIONING_REQUESTED", result: "PENDING" }, client);
      const created = await client.query<RedemptionRow>(`SELECT ${REDEMPTION_COLUMNS} FROM ddi_activation_redemptions WHERE id = $1`, [redemptionId]);
      return { redemption: mapRedemption(created.rows[0]!), replayed: false };
    });
  }

  async getRedemption(id: string) {
    const result = await this.pool.query<RedemptionRow>(`SELECT ${REDEMPTION_COLUMNS} FROM ddi_activation_redemptions WHERE id = $1`, [id]);
    return result.rows[0] ? { redemption: mapRedemption(result.rows[0]), trustSubject: result.rows[0].owner_trust_subject ?? undefined } : null;
  }
  async getEntitlement(id: string) {
    const result = await this.pool.query<EntitlementRow>(`SELECT ${ENTITLEMENT_COLUMNS} FROM ddi_entitlements WHERE id = $1`, [id]);
    return result.rows[0] ? mapEntitlement(result.rows[0]) : null;
  }
  async getLicense(id: string) {
    const result = await this.pool.query<LicenseRow>(`SELECT ${LICENSE_COLUMNS} FROM ddi_licenses WHERE id = $1`, [id]);
    return result.rows[0] ? mapLicense(result.rows[0]) : null;
  }
  async listEntitlements(ownerId: string) {
    const result = await this.pool.query<EntitlementRow>(`SELECT ${ENTITLEMENT_COLUMNS} FROM ddi_entitlements WHERE owner_id = $1 ORDER BY created_at, id`, [ownerId]);
    return result.rows.map(mapEntitlement);
  }
  async listLicenses(ownerId: string) {
    const result = await this.pool.query<LicenseRow>(`SELECT ${LICENSE_COLUMNS} FROM ddi_licenses WHERE owner_id = $1 ORDER BY created_at, id`, [ownerId]);
    return result.rows.map(mapLicense);
  }
  async getProperty(id: string) {
    const result = await this.pool.query<PropertyRow>(`SELECT ${PROPERTY_COLUMNS} FROM ddi_connected_properties WHERE id = $1`, [id]);
    const row = result.rows[0];
    return row ? { id: row.id, infrastructureId: row.infrastructure_id, ownerId: row.owner_id, type: row.property_type, externalSystem: row.external_system, externalReference: row.external_reference, status: row.status } : null;
  }

  /** Lazily persists expiry once the configured term has elapsed. */
  async markExpired(licenseId: string, at: Date, correlationId: string) {
    await this.transaction(async client => {
      const license = await client.query<LicenseRow>(`UPDATE ddi_licenses SET status = 'EXPIRED', status_reason = 'TERM_ELAPSED', revision = revision + 1, updated_at = $2 WHERE id = $1 AND status IN ('ACTIVE', 'SUSPENDED') AND expires_at IS NOT NULL AND expires_at <= $2 RETURNING ${LICENSE_COLUMNS}`, [licenseId, iso(at)]);
      const row = license.rows[0];
      if (!row) return;
      await client.query(`UPDATE ddi_entitlements SET status = 'EXPIRED', status_reason = 'TERM_ELAPSED', updated_at = $2 WHERE id = $1 AND status IN ('ACTIVE', 'SUSPENDED') AND expires_at IS NOT NULL AND expires_at <= $2`, [row.entitlement_id, iso(at)]);
      await this.audit({ eventType: "LICENSE_EXPIRED", correlationId, actor: "system:expiry", ownerId: row.owner_id as DigiOwnerId, licenseId: row.id as License["id"], entitlementId: row.entitlement_id as Entitlement["id"], productId: row.product_id, result: "EXPIRED", timestamp: iso(at) }, client);
    });
  }

  /** Suspend, reinstate, or revoke a license. REVOKED and EXPIRED are terminal. */
  async changeLicense(licenseId: string, action: LifecycleAction, input: { actor: string; reason?: string; at: Date; correlationId: string }) {
    return this.transaction(async client => {
      const result = await client.query<LicenseRow>(`SELECT ${LICENSE_COLUMNS} FROM ddi_licenses WHERE id = $1 FOR UPDATE`, [licenseId]);
      const row = result.rows[0];
      if (!row) throw new Error("LICENSE_NOT_FOUND");
      const next = transition(row.status, action, row.expires_at, input.at, "LICENSE");
      if (next === row.status) return mapLicense(row);
      const updated = await client.query<LicenseRow>(`UPDATE ddi_licenses SET status = $2, status_reason = $3, revision = revision + 1, updated_at = $4 WHERE id = $1 RETURNING ${LICENSE_COLUMNS}`, [licenseId, next, input.reason ?? action, iso(input.at)]);
      await this.audit({ eventType: action === "SUSPEND" ? "LICENSE_SUSPENDED" : action === "REINSTATE" ? "LICENSE_REINSTATED" : "LICENSE_REVOKED", correlationId: input.correlationId, actor: input.actor, ownerId: row.owner_id as DigiOwnerId, licenseId: row.id as License["id"], entitlementId: row.entitlement_id as Entitlement["id"], productId: row.product_id, result: next, reason: input.reason, timestamp: iso(input.at) }, client);
      return mapLicense(updated.rows[0]!);
    });
  }

  /** Entitlement lifecycle changes cascade to the license created from it. */
  async changeEntitlement(entitlementId: string, action: LifecycleAction, input: { actor: string; reason?: string; at: Date; correlationId: string }) {
    return this.transaction(async client => {
      const result = await client.query<EntitlementRow>(`SELECT ${ENTITLEMENT_COLUMNS} FROM ddi_entitlements WHERE id = $1 FOR UPDATE`, [entitlementId]);
      const row = result.rows[0];
      if (!row) throw new Error("ENTITLEMENT_NOT_FOUND");
      const next = transition(row.status, action, row.expires_at, input.at, "ENTITLEMENT");
      const licenses = await client.query<LicenseRow>(`SELECT ${LICENSE_COLUMNS} FROM ddi_licenses WHERE entitlement_id = $1 FOR UPDATE`, [entitlementId]);
      if (next === row.status) return mapEntitlement(row);
      const updated = await client.query<EntitlementRow>(`UPDATE ddi_entitlements SET status = $2, status_reason = $3, updated_at = $4 WHERE id = $1 RETURNING ${ENTITLEMENT_COLUMNS}`, [entitlementId, next, input.reason ?? action, iso(input.at)]);
      for (const license of licenses.rows) {
        if (license.status === "REVOKED" || license.status === "EXPIRED") continue;
        if (action === "SUSPEND" && license.status !== "ACTIVE") continue;
        if (action === "REINSTATE" && license.status_reason !== `ENTITLEMENT_${row.status}`) continue;
        await client.query(`UPDATE ddi_licenses SET status = $2, status_reason = $3, revision = revision + 1, updated_at = $4 WHERE id = $1`, [license.id, next, action === "REINSTATE" ? null : `ENTITLEMENT_${next}`, iso(input.at)]);
      }
      await this.audit({ eventType: action === "SUSPEND" ? "ENTITLEMENT_SUSPENDED" : action === "REINSTATE" ? "ENTITLEMENT_REINSTATED" : "ENTITLEMENT_REVOKED", correlationId: input.correlationId, actor: input.actor, ownerId: row.owner_id as DigiOwnerId, entitlementId: row.id as Entitlement["id"], productId: row.product_id, result: next, reason: input.reason, timestamp: iso(input.at) }, client);
      return mapEntitlement(updated.rows[0]!);
    });
  }

  /* Durable outbox. A crashed worker's IN_PROGRESS row is re-claimed after its lease expires. */
  async claimOutbox(input: { now: Date; limit: number; leaseMs: number; aggregateId?: string }): Promise<OutboxJob[]> {
    const result = await this.pool.query<{ id: string; kind: string; aggregate_id: string; payload: { redemptionId: string }; attempts: number; max_attempts: number; lease_token: string }>(
      `UPDATE ddi_commercial_outbox o SET status = 'IN_PROGRESS', attempts = o.attempts + 1, lease_token = gen_random_uuid()::text, locked_until = $1::timestamptz + make_interval(secs => $3::double precision / 1000), updated_at = $1
       WHERE o.id IN (SELECT id FROM ddi_commercial_outbox WHERE ((status = 'PENDING' AND next_attempt_at <= $1) OR (status = 'IN_PROGRESS' AND locked_until <= $1)) AND ($4::text IS NULL OR aggregate_id = $4) ORDER BY next_attempt_at, id FOR UPDATE SKIP LOCKED LIMIT $2)
       RETURNING o.id, o.kind, o.aggregate_id, o.payload, o.attempts, o.max_attempts, o.lease_token`,
      [iso(input.now), input.limit, input.leaseMs, input.aggregateId ?? null]);
    return result.rows.map(row => ({ id: row.id, kind: row.kind, aggregateId: row.aggregate_id, payload: row.payload, attempts: row.attempts, maxAttempts: row.max_attempts, leaseToken: row.lease_token }));
  }
  /** Lease-guarded: a worker whose lease was taken over cannot overwrite the newer outcome. */
  async settleOutbox(job: OutboxJob, outcome: { status: "DONE" | "DEAD" | "PENDING"; at: Date; nextAttemptAt?: Date; error?: string }) {
    const result = await this.pool.query(`UPDATE ddi_commercial_outbox SET status = $3::text, last_error = $4::text, next_attempt_at = COALESCE($5::timestamptz, next_attempt_at), lease_token = NULL, locked_until = NULL, updated_at = $6::timestamptz, completed_at = CASE WHEN $3::text IN ('DONE', 'DEAD') THEN $6::timestamptz ELSE NULL END WHERE id = $1 AND lease_token = $2 AND status = 'IN_PROGRESS'`, [job.id, job.leaseToken, outcome.status, outcome.error ?? null, outcome.nextAttemptAt ? iso(outcome.nextAttemptAt) : null, iso(outcome.at)]);
    return result.rowCount === 1;
  }
  async outboxFor(aggregateId: string) {
    const result = await this.pool.query<{ id: string; status: string; attempts: number; last_error: string | null; next_attempt_at: Date }>(`SELECT id, status, attempts, last_error, next_attempt_at FROM ddi_commercial_outbox WHERE aggregate_id = $1`, [aggregateId]);
    return result.rows.map(row => ({ id: row.id, status: row.status, attempts: row.attempts, lastError: row.last_error ?? undefined, nextAttemptAt: iso(row.next_attempt_at) }));
  }

  /** Operator view: redemption and outbox state. No secrets are stored, so none are returned. */
  async redemptionDetail(id: string) {
    const found = await this.getRedemption(id);
    if (!found) return null;
    const outbox = await this.pool.query<{ id: string; status: string; attempts: number; max_attempts: number; requeue_count: number; max_requeues: number; last_error: string | null; next_attempt_at: Date; locked_until: Date | null }>(`SELECT id, status, attempts, max_attempts, requeue_count, max_requeues, last_error, next_attempt_at, locked_until FROM ddi_commercial_outbox WHERE aggregate_id = $1`, [id]);
    return { redemption: found.redemption, outbox: outbox.rows.map(row => ({ id: row.id, status: row.status, attempts: row.attempts, maxAttempts: row.max_attempts, requeueCount: row.requeue_count, maxRequeues: row.max_requeues, lastError: row.last_error ?? undefined, nextAttemptAt: iso(row.next_attempt_at), lockedUntil: optionalIso(row.locked_until) })) };
  }

  /**
   * Bounded operator retry. Only re-schedules the existing job: it creates no
   * entitlement, license, property or PDI, and changes no status other than
   * returning an ATTENTION_REQUIRED redemption to PROVISIONING_PENDING. Every
   * step it re-runs is idempotent and re-verifies ownership with the Portal.
   */
  async requeueOutbox(redemptionId: string, input: { actor: string; reason: string; at: Date; correlationId: string }) {
    return this.transaction(async client => {
      const jobs = await client.query<{ id: string; status: string; locked_until: Date | null; requeue_count: number; max_requeues: number }>(`SELECT id, status, locked_until, requeue_count, max_requeues FROM ddi_commercial_outbox WHERE aggregate_id = $1 FOR UPDATE`, [redemptionId]);
      const job = jobs.rows[0];
      if (!job) throw new Error("OUTBOX_JOB_NOT_FOUND");
      if (job.status === "DONE") throw new Error("OUTBOX_JOB_COMPLETE");
      if (job.status === "IN_PROGRESS" && job.locked_until && job.locked_until.getTime() > input.at.getTime()) throw new Error("OUTBOX_JOB_IN_PROGRESS");
      if (job.requeue_count >= job.max_requeues) throw new Error("OUTBOX_REQUEUE_LIMIT");
      const redemption = await client.query<RedemptionRow>(`SELECT ${REDEMPTION_COLUMNS} FROM ddi_activation_redemptions WHERE id = $1 FOR UPDATE`, [redemptionId]);
      const row = redemption.rows[0];
      if (!row) throw new Error("REDEMPTION_NOT_FOUND");
      if (row.status === "COMPLETED" || row.status === "CANCELLED") throw new Error("OUTBOX_JOB_COMPLETE");
      const license = await client.query<{ status: string }>(`SELECT status FROM ddi_licenses WHERE id = $1`, [row.license_id]);
      if (license.rows[0]?.status === "REVOKED") throw new Error("LICENSE_REVOKED");
      await client.query(`UPDATE ddi_commercial_outbox SET status = 'PENDING', attempts = 0, next_attempt_at = $2, lease_token = NULL, locked_until = NULL, completed_at = NULL, requeue_count = requeue_count + 1, updated_at = $2 WHERE id = $1`, [job.id, iso(input.at)]);
      await client.query(`UPDATE ddi_activation_redemptions SET status = 'PROVISIONING_PENDING', updated_at = $2 WHERE id = $1 AND status = 'ATTENTION_REQUIRED'`, [redemptionId, iso(input.at)]);
      await this.audit({ eventType: "OUTBOX_REQUEUED", correlationId: input.correlationId, actor: input.actor, ownerId: row.owner_id as DigiOwnerId, redemptionId: row.id as Redemption["id"], licenseId: row.license_id as License["id"], propertyId: (row.property_id ?? undefined) as Redemption["propertyId"], result: `REQUEUED:${job.requeue_count + 1}/${job.max_requeues}`, reason: input.reason, timestamp: iso(input.at) }, client);
      return { requeueCount: job.requeue_count + 1, maxRequeues: job.max_requeues };
    });
  }

  async markProvisioned(redemptionId: string, reference: string, at: Date, correlationId: string) {
    await this.transaction(async client => {
      const updated = await client.query<RedemptionRow>(`UPDATE ddi_activation_redemptions SET provisioning_reference = $2, provisioned_at = $3, updated_at = $3 WHERE id = $1 AND provisioned_at IS NULL RETURNING ${REDEMPTION_COLUMNS}`, [redemptionId, reference, iso(at)]);
      const row = updated.rows[0];
      if (row) await this.audit({ eventType: "PROVISIONING_SUCCEEDED", correlationId, actor: "system:outbox", ownerId: row.owner_id as DigiOwnerId, redemptionId: row.id as Redemption["id"], licenseId: row.license_id as License["id"], propertyId: (row.property_id ?? undefined) as Redemption["propertyId"], result: "PROVISIONED", timestamp: iso(at) }, client);
    });
  }
  /**
   * Conditional promotion; a revoked or failed property can never be re-activated here.
   * Promotion also re-binds to DDI's own records: the property must still belong to the
   * redeeming owner and to that owner's ACTIVE PERSONAL PDI, so a fresh Portal READY for a
   * stale or different owner cannot activate it. The fresh receipt replaces the bootstrap one.
   */
  async activateProperty(redemptionId: string, at: Date, correlationId: string, ownershipEvidence?: string) {
    return this.transaction(async client => {
      const result = await client.query<RedemptionRow>(`SELECT ${REDEMPTION_COLUMNS} FROM ddi_activation_redemptions WHERE id = $1 FOR UPDATE`, [redemptionId]);
      const row = result.rows[0];
      if (!row?.property_id) return false;
      const promoted = await client.query(`UPDATE ddi_connected_properties p SET status = 'ACTIVE', ownership_evidence = COALESCE($5, p.ownership_evidence), updated_at = $2 WHERE p.id = $1 AND p.status = 'PENDING_ACTIVATION' AND p.owner_id = $3 AND p.infrastructure_id = $4 AND EXISTS (SELECT 1 FROM ddi_infrastructures i WHERE i.id = $4 AND i.owner_id = $3 AND i.type = 'PERSONAL' AND i.status = 'ACTIVE')`, [row.property_id, iso(at), row.owner_id, row.infrastructure_id, ownershipEvidence ?? null]);
      const property = await client.query<{ status: string; owner_id: string; infrastructure_id: string }>(`SELECT status, owner_id, infrastructure_id FROM ddi_connected_properties WHERE id = $1`, [row.property_id]);
      const current = property.rows[0];
      if (current?.status !== "ACTIVE" || current.owner_id !== row.owner_id || current.infrastructure_id !== row.infrastructure_id) return false;
      if (!row.activated_at) await client.query(`UPDATE ddi_activation_redemptions SET activated_at = $2, updated_at = $2 WHERE id = $1`, [redemptionId, iso(at)]);
      if (promoted.rowCount === 1) {
        await client.query(`INSERT INTO ddi_connection_audits (id, event_type, correlation_id, owner_id, infrastructure_id, property_id, result, timestamp) VALUES ($1,'PROPERTY_CONNECTED',$2,$3,$4,$5,'ACTIVE',$6)`, [randomUUID(), correlationId, row.owner_id, row.infrastructure_id, row.property_id, iso(at)]);
        await this.audit({ eventType: "PROPERTY_ACTIVATED", correlationId, actor: "system:outbox", ownerId: row.owner_id as DigiOwnerId, redemptionId: row.id as Redemption["id"], licenseId: row.license_id as License["id"], propertyId: row.property_id as Redemption["propertyId"], result: "ACTIVE", timestamp: iso(at) }, client);
      }
      return true;
    });
  }
  /** Ownership no longer verifies: the property fails closed and the license is suspended for operator review. */
  async failPropertyActivation(redemptionId: string, reason: string, at: Date, correlationId: string) {
    await this.transaction(async client => {
      const result = await client.query<RedemptionRow>(`SELECT ${REDEMPTION_COLUMNS} FROM ddi_activation_redemptions WHERE id = $1 FOR UPDATE`, [redemptionId]);
      const row = result.rows[0];
      if (!row?.property_id) return;
      await client.query(`UPDATE ddi_connected_properties SET status = 'FAILED', updated_at = $2 WHERE id = $1 AND status = 'PENDING_ACTIVATION'`, [row.property_id, iso(at)]);
      await client.query(`UPDATE ddi_licenses SET status = 'SUSPENDED', status_reason = $2, revision = revision + 1, updated_at = $3 WHERE id = $1 AND status = 'ACTIVE'`, [row.license_id, reason, iso(at)]);
      await client.query(`UPDATE ddi_activation_redemptions SET status = 'ATTENTION_REQUIRED', last_error = $2, updated_at = $3 WHERE id = $1`, [redemptionId, reason, iso(at)]);
      await this.audit({ eventType: "PROPERTY_ACTIVATION_FAILED", correlationId, actor: "system:outbox", ownerId: row.owner_id as DigiOwnerId, redemptionId: row.id as Redemption["id"], licenseId: row.license_id as License["id"], propertyId: row.property_id as Redemption["propertyId"], result: "FAILED", reason, timestamp: iso(at) }, client);
    });
  }
  async setRedemptionStatus(redemptionId: string, status: RedemptionStatus, at: Date, lastError?: string) {
    await this.pool.query(`UPDATE ddi_activation_redemptions SET status = $2, last_error = $3, updated_at = $4 WHERE id = $1 AND status IN ('PROVISIONING_PENDING', 'ATTENTION_REQUIRED')`, [redemptionId, status, lastError ?? null, iso(at)]);
  }

  /* Download grants */
  async insertDownloadGrant(input: { tokenHash: string; ownerId: string; license: License; artifactId: string; version?: string; expiresAt: Date; at: Date; correlationId: string }) {
    const id = `dlgrant:${randomUUID()}`;
    await this.transaction(async client => {
      await client.query(`INSERT INTO ddi_download_grants (id, token_hash, owner_id, license_id, entitlement_id, product_id, artifact_id, artifact_version, property_id, status, expires_at, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'ISSUED',$10,$11)`, [id, input.tokenHash, input.ownerId, input.license.id, input.license.entitlementId, input.license.productId, input.artifactId, input.version ?? null, input.license.propertyId ?? null, iso(input.expiresAt), iso(input.at)]);
      await this.audit({ eventType: "DOWNLOAD_AUTHORIZED", correlationId: input.correlationId, actor: `owner:${input.ownerId}`, ownerId: input.ownerId as DigiOwnerId, licenseId: input.license.id, entitlementId: input.license.entitlementId, propertyId: input.license.propertyId, productId: input.license.productId, result: "ISSUED", reason: `artifact:${input.artifactId}${input.version ? `@${input.version}` : ""}`, timestamp: iso(input.at) }, client);
    });
    return id;
  }
  /** Single-use consumption under a row lock. The license is re-evaluated while the grant is held. */
  async consumeDownloadGrant(tokenHash: string, at: Date, check: (grant: DownloadGrantRow) => Promise<string | null>): Promise<{ ok: true; grant: DownloadGrantRow } | { ok: false; reason: string; grant?: DownloadGrantRow }> {
    return this.transaction(async client => {
      const result = await client.query<DownloadGrantRow>(`SELECT id, owner_id, license_id, entitlement_id, product_id, artifact_id, artifact_version, property_id, status, expires_at, consumed_at FROM ddi_download_grants WHERE token_hash = $1 FOR UPDATE`, [tokenHash]);
      const grant = result.rows[0];
      if (!grant) return { ok: false, reason: "DOWNLOAD_GRANT_INVALID" };
      if (grant.status !== "ISSUED") return { ok: false, reason: "DOWNLOAD_GRANT_CONSUMED", grant };
      if (grant.expires_at.getTime() <= at.getTime()) return { ok: false, reason: "DOWNLOAD_GRANT_EXPIRED", grant };
      const denied = await check(grant);
      if (denied) return { ok: false, reason: denied, grant };
      await client.query(`UPDATE ddi_download_grants SET status = 'CONSUMED', consumed_at = $2 WHERE id = $1`, [grant.id, iso(at)]);
      return { ok: true, grant };
    });
  }
}

function transition(current: CommercialStatus, action: LifecycleAction, expiresAt: Date | null, at: Date, subject: "LICENSE" | "ENTITLEMENT"): CommercialStatus {
  if (action === "REVOKE") return "REVOKED";
  if (current === "REVOKED" || current === "EXPIRED") throw new Error(`${subject}_NOT_MODIFIABLE`);
  if (action === "SUSPEND") return "SUSPENDED";
  if (expiresAt && expiresAt.getTime() <= at.getTime()) throw new Error(`${subject}_EXPIRED`);
  return "ACTIVE";
}

function mapCode(row: CodeRow): ActivationCodeRecord {
  return { id: row.id as ActivationCodeRecord["id"], productId: row.product_id, planId: row.plan_id, plan: row.plan_snapshot, catalogVersion: row.catalog_version, paymentReference: row.payment_reference, issuedBy: row.issued_by as DigiOwnerId, status: row.status, createdAt: iso(row.created_at), expiresAt: iso(row.expires_at), redeemedByOwnerId: (row.redeemed_by_owner_id ?? undefined) as DigiOwnerId | undefined, redeemedAt: optionalIso(row.redeemed_at), redemptionId: (row.redemption_id ?? undefined) as ActivationCodeRecord["redemptionId"], revokedAt: optionalIso(row.revoked_at) };
}
function mapEntitlement(row: EntitlementRow): Entitlement {
  return { id: row.id as Entitlement["id"], ownerId: row.owner_id as DigiOwnerId, infrastructureId: row.infrastructure_id as Entitlement["infrastructureId"], productId: row.product_id, planId: row.plan_id, edition: row.edition, licenseType: row.license_type, propertyId: (row.property_id ?? undefined) as Entitlement["propertyId"], status: row.status, activatedAt: iso(row.activated_at), expiresAt: optionalIso(row.expires_at), renewable: row.renewable, downloads: row.downloads, sourceCodeId: row.source_code_id as Entitlement["sourceCodeId"], statusReason: row.status_reason ?? undefined, createdAt: iso(row.created_at), updatedAt: iso(row.updated_at) };
}
function mapLicense(row: LicenseRow): License {
  return { id: row.id as License["id"], entitlementId: row.entitlement_id as License["entitlementId"], ownerId: row.owner_id as DigiOwnerId, infrastructureId: row.infrastructure_id as License["infrastructureId"], productId: row.product_id, planId: row.plan_id, propertyId: (row.property_id ?? undefined) as License["propertyId"], status: row.status, issuedAt: iso(row.issued_at), expiresAt: optionalIso(row.expires_at), restrictions: row.restrictions, revision: row.revision, statusReason: row.status_reason ?? undefined, createdAt: iso(row.created_at), updatedAt: iso(row.updated_at) };
}
function mapRedemption(row: RedemptionRow): Redemption {
  return { id: row.id as Redemption["id"], codeId: row.code_id as Redemption["codeId"], ownerId: row.owner_id as DigiOwnerId, infrastructureId: row.infrastructure_id as Redemption["infrastructureId"], propertyId: (row.property_id ?? undefined) as Redemption["propertyId"], entitlementId: row.entitlement_id as Redemption["entitlementId"], licenseId: row.license_id as Redemption["licenseId"], status: row.status, provisioningReference: row.provisioning_reference ?? undefined, provisionedAt: optionalIso(row.provisioned_at), activatedAt: optionalIso(row.activated_at), lastError: row.last_error ?? undefined, createdAt: iso(row.created_at), updatedAt: iso(row.updated_at) };
}
