import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import type { ConnectedPropertyType } from "../../contracts/src/index.ts";
import type { OwnershipVerifier } from "./ownership.ts";

/**
 * D3C-B: Portal install state -> DDI property privileges.
 *
 * Restriction is immediate and comes from any authenticated source (sequenced
 * event, or reconciliation that cannot confirm a READY install). Restoration
 * only follows a strictly newer Portal sequence reporting a clean state, so a
 * stale READY, a duplicate, or a late event can never re-activate a property.
 * RETIRED is terminal. The Portal supports no ownership transfer: an event or
 * answer for a different owner than the one who redeemed is a sticky mismatch.
 */
export const PORTAL_INSTALL_EVENT_TYPES = ["INSTALL_SUSPENDED", "INSTALL_REINSTATED", "INSTALL_RETIRED", "OWNER_SUSPENDED", "OWNER_REINSTATED", "INSTALL_STATE"] as const;
export type PortalInstallEventType = typeof PORTAL_INSTALL_EVENT_TYPES[number];
export type PortalInstallState = { installSuspended: boolean; ownerSuspended: boolean; retired: boolean };
export type PortalInstallEvent = { eventId: string; type: PortalInstallEventType; installId: string; externalReference: string; ownerSubject: string; sequence: number; state: PortalInstallState; correlationId: string; occurredAt: string };
export type ApplyOutcome = { outcome: "APPLIED" | "DUPLICATE" | "STALE" | "NO_PROPERTY"; propertyId?: string; propertyStatus?: string; sequence?: number };

type StateRow = { external_reference: string; property_id: string | null; last_sequence: string; install_suspended: boolean; owner_suspended: boolean; retired: boolean; owner_mismatch: boolean; reconcile_restricted: boolean; restricted_from: string | null };

export class PostgresPortalInstallState {
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

  /** Idempotent by eventId; ordered by sequence. */
  async applyEvent(event: PortalInstallEvent, sourceService: string, at: Date): Promise<ApplyOutcome> {
    return this.transaction(async client => {
      const inserted = await client.query(`INSERT INTO ddi_portal_install_events (event_id, external_reference, event_type, sequence, owner_subject, correlation_id, source_service, outcome, received_at) VALUES ($1,$2,$3,$4,$5,$6,$7,'RECEIVED',$8) ON CONFLICT (event_id) DO NOTHING`, [event.eventId, event.externalReference, event.type, event.sequence, event.ownerSubject, event.correlationId, sourceService, at.toISOString()]);
      if (inserted.rowCount !== 1) return { outcome: "DUPLICATE", sequence: event.sequence };
      const result = await this.apply(client, { externalReference: event.externalReference, sequence: event.sequence, state: event.state, ownerSubject: event.ownerSubject, correlationId: event.correlationId, at });
      await client.query(`UPDATE ddi_portal_install_events SET outcome = $2 WHERE event_id = $1`, [event.eventId, result.outcome]);
      return result;
    });
  }

  /** Reconciliation: a verified READY with its sequence, or a restriction with a reason. */
  async applyReconciliation(input: { externalReference: string; ownerSubject: string; at: Date } & ({ ready: true; sequence?: number } | { ready: false; reason: string })) {
    return this.transaction(client => input.ready
      ? this.apply(client, { externalReference: input.externalReference, sequence: input.sequence ?? null, state: { installSuspended: false, ownerSuspended: false, retired: false }, ownerSubject: input.ownerSubject, correlationId: `reconcile:${randomUUID()}`, at: input.at })
      : this.apply(client, { externalReference: input.externalReference, sequence: null, state: null, ownerSubject: input.ownerSubject, correlationId: `reconcile:${randomUUID()}`, at: input.at, restrictReason: input.reason }));
  }

  private async apply(client: PoolClient, input: { externalReference: string; sequence: number | null; state: PortalInstallState | null; ownerSubject: string; correlationId: string; at: Date; restrictReason?: string }): Promise<ApplyOutcome> {
    const at = input.at.toISOString();
    const found = await client.query<{ id: string; owner_id: string; infrastructure_id: string; status: string }>(`SELECT id, owner_id, infrastructure_id, status FROM ddi_connected_properties WHERE external_system = 'lifeos' AND external_reference = $1 FOR UPDATE`, [input.externalReference]);
    const property = found.rows[0];
    await client.query(`INSERT INTO ddi_portal_install_state (external_reference, property_id, updated_at) VALUES ($1,$2,$3) ON CONFLICT (external_reference) DO UPDATE SET property_id = COALESCE(ddi_portal_install_state.property_id, EXCLUDED.property_id)`, [input.externalReference, property?.id ?? null, at]);
    const locked = await client.query<StateRow>(`SELECT external_reference, property_id, last_sequence, install_suspended, owner_suspended, retired, owner_mismatch, reconcile_restricted, restricted_from FROM ddi_portal_install_state WHERE external_reference = $1 FOR UPDATE`, [input.externalReference]);
    const row = locked.rows[0]!;
    const last = Number(row.last_sequence);
    if (input.sequence !== null && input.sequence <= last) return { outcome: "STALE", propertyId: property?.id, propertyStatus: property?.status, sequence: last };
    const known = property ? await client.query<{ owner_trust_subject: string }>(`SELECT owner_trust_subject FROM ddi_activation_redemptions WHERE property_id = $1 AND owner_trust_subject IS NOT NULL ORDER BY created_at LIMIT 1`, [property.id]) : null;
    const knownSubject = known?.rows[0]?.owner_trust_subject;
    const flags = { install_suspended: row.install_suspended, owner_suspended: row.owner_suspended, retired: row.retired, owner_mismatch: row.owner_mismatch, reconcile_restricted: row.reconcile_restricted };
    if (knownSubject && input.ownerSubject !== knownSubject) flags.owner_mismatch = true;
    let reason = input.restrictReason;
    if (input.state) {
      // Only a sequenced state may clear flags; an unsequenced one may only restrict.
      const sequenced = input.sequence !== null;
      flags.install_suspended = sequenced ? input.state.installSuspended : flags.install_suspended || input.state.installSuspended;
      flags.owner_suspended = sequenced ? input.state.ownerSuspended : flags.owner_suspended || input.state.ownerSuspended;
      flags.retired = flags.retired || input.state.retired;
      if (sequenced) flags.reconcile_restricted = false;
    }
    if (input.restrictReason) flags.reconcile_restricted = true;
    if (flags.owner_mismatch) reason = "OWNER_MISMATCH";
    const restricted = Object.values(flags).some(Boolean);
    let restrictedFrom = row.restricted_from;
    let status = property?.status;
    if (property) {
      if (flags.retired && property.status !== "REVOKED") {
        status = "REVOKED";
        await client.query(`UPDATE ddi_connected_properties SET status = 'REVOKED', revoked_at = $2, updated_at = $2 WHERE id = $1`, [property.id, at]);
        await this.event(client, "PROPERTY_REVOKED", property, input.correlationId, "REVOKED", "PORTAL_INSTALL_RETIRED", at);
      } else if (restricted && (property.status === "ACTIVE" || property.status === "PENDING_ACTIVATION")) {
        restrictedFrom = property.status;
        status = "SUSPENDED";
        await client.query(`UPDATE ddi_connected_properties SET status = 'SUSPENDED', updated_at = $2 WHERE id = $1`, [property.id, at]);
        await this.event(client, "PROPERTY_SUSPENDED", property, input.correlationId, "SUSPENDED", reason ?? this.reasonFor(flags), at);
      } else if (!restricted && property.status === "SUSPENDED" && restrictedFrom) {
        status = restrictedFrom;
        await client.query(`UPDATE ddi_connected_properties SET status = $2, updated_at = $3 WHERE id = $1 AND status = 'SUSPENDED'`, [property.id, restrictedFrom, at]);
        await this.event(client, "PROPERTY_REINSTATED", property, input.correlationId, restrictedFrom, "PORTAL_STATE_CLEAN", at);
        restrictedFrom = null;
      }
    }
    await client.query(`UPDATE ddi_portal_install_state SET property_id = COALESCE(property_id, $2), last_sequence = $3, install_suspended = $4, owner_suspended = $5, retired = $6, owner_mismatch = $7, reconcile_restricted = $8, restricted_from = $9, reason = $10, updated_at = $11 WHERE external_reference = $1`, [input.externalReference, property?.id ?? null, input.sequence ?? last, flags.install_suspended, flags.owner_suspended, flags.retired, flags.owner_mismatch, flags.reconcile_restricted, restrictedFrom, restricted ? (reason ?? this.reasonFor(flags)) : null, at]);
    return { outcome: property ? "APPLIED" : "NO_PROPERTY", propertyId: property?.id, propertyStatus: status, sequence: input.sequence ?? last };
  }

  private reasonFor(flags: Record<string, boolean>) {
    return Object.entries(flags).filter(([, value]) => value).map(([key]) => key.toUpperCase()).join(",") || "RESTRICTED";
  }

  private async event(client: PoolClient, eventType: "PROPERTY_SUSPENDED" | "PROPERTY_REINSTATED" | "PROPERTY_REVOKED", property: { id: string; owner_id: string; infrastructure_id: string }, correlationId: string, result: string, reason: string, at: string) {
    await client.query(`INSERT INTO ddi_connection_audits (id, event_type, correlation_id, owner_id, infrastructure_id, property_id, result, reason, timestamp) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [randomUUID(), eventType, correlationId, property.owner_id, property.infrastructure_id, property.id, result, reason, at]);
  }

  async state(externalReference: string) {
    const result = await this.pool.query<StateRow & { reason: string | null }>(`SELECT external_reference, property_id, last_sequence, install_suspended, owner_suspended, retired, owner_mismatch, reconcile_restricted, restricted_from, reason FROM ddi_portal_install_state WHERE external_reference = $1`, [externalReference]);
    const row = result.rows[0];
    return row ? { ...row, last_sequence: Number(row.last_sequence) } : null;
  }

  /** Portal-backed properties whose redeeming owner subject is known, oldest-checked first. */
  async reconcilable(limit: number) {
    const result = await this.pool.query<{ id: string; external_reference: string; property_type: ConnectedPropertyType; status: string; owner_trust_subject: string }>(
      `SELECT p.id, p.external_reference, p.property_type, p.status, r.owner_trust_subject FROM ddi_connected_properties p
       JOIN LATERAL (SELECT owner_trust_subject FROM ddi_activation_redemptions WHERE property_id = p.id AND owner_trust_subject IS NOT NULL ORDER BY created_at LIMIT 1) r ON TRUE
       WHERE p.external_system = 'lifeos' AND p.status IN ('ACTIVE', 'SUSPENDED') ORDER BY p.updated_at, p.id LIMIT $1`, [limit]);
    return result.rows;
  }
}

/**
 * Recovers from lost Portal events by asking the Portal directly. It restricts on
 * anything short of a verified READY for the same owner, and restores only when
 * the Portal reports a strictly newer sequence than DDI last applied.
 */
export async function reconcilePortalInstalls(input: { store: PostgresPortalInstallState; ownership: OwnershipVerifier; limit?: number; now?: () => Date }) {
  const summary = { checked: 0, restricted: 0, restored: 0, unchanged: 0, unavailable: 0 };
  for (const row of await input.store.reconcilable(input.limit ?? 100)) {
    summary.checked++;
    const at = input.now?.() ?? new Date();
    let outcome: ApplyOutcome;
    try {
      const verified = await input.ownership.verify({ trustIdSubject: row.owner_trust_subject, externalSystem: "lifeos", externalReference: row.external_reference, type: row.property_type, purpose: "ACTIVATE" });
      outcome = await input.store.applyReconciliation({ externalReference: row.external_reference, ownerSubject: row.owner_trust_subject, at, ready: true, sequence: verified.sequence });
    } catch (error) {
      const reason = error instanceof Error ? error.message : "UNAVAILABLE";
      if (reason === "OWNERSHIP_VERIFICATION_UNAVAILABLE" || !/^[A-Z_]+$/.test(reason)) { summary.unavailable++; continue; }
      outcome = await input.store.applyReconciliation({ externalReference: row.external_reference, ownerSubject: row.owner_trust_subject, at, ready: false, reason });
    }
    if (outcome.propertyStatus === row.status) summary.unchanged++;
    else if (outcome.propertyStatus === "SUSPENDED" || outcome.propertyStatus === "REVOKED") summary.restricted++;
    else summary.restored++;
  }
  return summary;
}
