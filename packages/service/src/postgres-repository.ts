import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import type { ApplicationRecord, AuditRecord, AuthorityGrantRef, Capability, ConnectionAuditRecord, DigiOwnerId, InfrastructureRecord, PdiApplicationConnection, PrimitiveBinding, Relationship } from "../../contracts/src/index.ts";
import { assertCapabilitySubset, authorityBinding, sameCapabilities } from "../../core/src/connection.ts";
import { communicationBindingReference, isCanonicalMailboxSubject, parseCommunicationBinding } from "../../core/src/index.ts";
import type { PersistentState } from "./store.ts";
import type { DdiRepository, ProvisionInput, RegisterAppInput } from "./repository.ts";

type InfraRow = { id: string; owner_id: string | null; type: InfrastructureRecord["type"]; status: InfrastructureRecord["status"]; metadata: Record<string, string>; created_at: Date; updated_at: Date };
type AppRow = { id: string; infrastructure_id: string; type: string; display_name: string; public_url: string | null; admin_url: string | null; status: ApplicationRecord["status"]; requested_capabilities: Capability[]; granted_capabilities: Capability[]; created_at: Date; updated_at: Date };
type BindingRow = { id: string; infrastructure_id: string; namespace: PrimitiveBinding["namespace"]; provider: PrimitiveBinding["provider"]; configured: boolean; provider_reference: string | null };
type RelationRow = { id: string; source: string; target: string; relationship_type: Relationship["type"]; created_at: Date };

const iso = (value: Date | string) => new Date(value).toISOString();

export class PostgresDdiRepository implements DdiRepository {
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

  async provision(ownerId: DigiOwnerId, input: ProvisionInput): Promise<InfrastructureRecord> {
    if (!input.idempotencyKey) throw new Error("AUTHENTICATED_ACTOR_AND_IDEMPOTENCY_REQUIRED");
    return this.transaction(async (client) => {
      await client.query(`INSERT INTO ddi_idempotency (key, owner_subject, owner_id, response, created_at) VALUES ($1, '', $2, '{}'::jsonb, NOW()) ON CONFLICT (key) DO NOTHING`, [input.idempotencyKey, ownerId]);
      const locked = await client.query<{ owner_id: string | null; response: InfrastructureRecord }>(`SELECT owner_id, response FROM ddi_idempotency WHERE key = $1 FOR UPDATE`, [input.idempotencyKey]);
      const row = locked.rows[0];
      if (!row) throw new Error("IDEMPOTENCY_MISSING");
      if (row.owner_id !== ownerId) throw new Error("IDEMPOTENCY_OWNER_MISMATCH");
      if (row.response?.id) {
        if (input.type === "PERSONAL") { await this.ensureIdentityBinding(client, row.response.id); await this.ensureCommunicationBinding(client, row.response.id, input.ownerTrustId); }
        const existing = await this.hydrate(client, row.response.id);
        if (!existing) throw new Error("IDEMPOTENCY_MISSING");
        return existing;
      }
      if (input.type === "PERSONAL") {
        const canonical = await client.query<{ id: string }>(`SELECT id FROM ddi_infrastructures WHERE owner_id = $1 AND type = 'PERSONAL' FOR UPDATE`, [ownerId]);
        if (canonical.rows[0]) {
          await this.ensureIdentityBinding(client, canonical.rows[0].id);
          await this.ensureCommunicationBinding(client, canonical.rows[0].id, input.ownerTrustId);
          const existing = await this.hydrate(client, canonical.rows[0].id);
          if (!existing) throw new Error("UNKNOWN_INFRASTRUCTURE");
          await client.query(`UPDATE ddi_idempotency SET response = $2::jsonb WHERE key = $1`, [input.idempotencyKey, JSON.stringify(existing)]);
          return existing;
        }
      }
      const at = new Date().toISOString();
      const infra: InfrastructureRecord = { id: `infra:${randomUUID()}` as InfrastructureRecord["id"], ownerId, type: input.type, status: "ACTIVE", applicationIds: [], primitiveBindingIds: [], relationshipIds: [], createdAt: at, updatedAt: at, metadata: input.metadata ?? {} };
      await client.query("SAVEPOINT ddi_personal_insert");
      try {
        await client.query(`INSERT INTO ddi_infrastructures (id, owner_subject, owner_id, type, status, metadata, created_at, updated_at) VALUES ($1, '', $2, $3, $4, $5::jsonb, $6, $6)`, [infra.id, ownerId, infra.type, infra.status, JSON.stringify(infra.metadata), at]);
      } catch (error) {
        const code = error && typeof error === "object" && "code" in error ? String((error as { code?: string }).code) : "";
        if (code !== "23505" || input.type !== "PERSONAL") throw error;
        await client.query("ROLLBACK TO SAVEPOINT ddi_personal_insert");
        const canonical = await client.query<{ id: string }>(`SELECT id FROM ddi_infrastructures WHERE owner_id = $1 AND type = 'PERSONAL'`, [ownerId]);
        if (canonical.rows[0]) { await this.ensureIdentityBinding(client, canonical.rows[0].id); await this.ensureCommunicationBinding(client, canonical.rows[0].id, input.ownerTrustId); }
        const existing = canonical.rows[0] ? await this.hydrate(client, canonical.rows[0].id) : null;
        if (!existing) throw error;
        await client.query(`UPDATE ddi_idempotency SET response = $2::jsonb WHERE key = $1`, [input.idempotencyKey, JSON.stringify(existing)]);
        return existing;
      }
      const relation: Relationship = { id: `relationship:${randomUUID()}` as Relationship["id"], from: infra.id, to: ownerId, type: "OWNER", createdAt: at };
      await client.query(`INSERT INTO ddi_relationships (id, source, target, relationship_type, status, metadata, created_at, updated_at) VALUES ($1, $2, $3, 'OWNER', 'ACTIVE', '{}'::jsonb, $4, $4)`, [relation.id, relation.from, relation.to, at]);
      infra.relationshipIds = [relation.id];
      if (infra.type === "PERSONAL") {
        const binding = await this.ensureIdentityBinding(client, infra.id);
        const communication = await this.ensureCommunicationBinding(client, infra.id, input.ownerTrustId);
        infra.primitiveBindingIds = [binding?.id, communication?.id].filter((item): item is NonNullable<typeof item> => item !== undefined);
      }
      await this.connectionEvent(client, { eventType: "PDI_CREATED", correlationId: input.idempotencyKey, ownerId, infrastructureId: infra.id, result: "CREATED", timestamp: at });
      await client.query(`UPDATE ddi_idempotency SET response = $2::jsonb WHERE key = $1`, [input.idempotencyKey, JSON.stringify(infra)]);
      return infra;
    });
  }

  async registerApplication(ownerId: DigiOwnerId, infrastructureId: string, input: RegisterAppInput): Promise<ApplicationRecord> {
    for (const value of [input.publicUrl, input.adminUrl]) if (value) { try { new URL(value); } catch { throw new Error("INVALID_REQUEST"); } }
    const key = `application:${input.idempotencyKey}`;
    return this.transaction(async (client) => {
      const infra = await this.hydrate(client, infrastructureId);
      if (!infra) throw new Error("UNKNOWN_INFRASTRUCTURE");
      if (infra.ownerId !== ownerId) throw new Error("OWNER_REQUIRED");
      if (infra.status !== "ACTIVE") throw new Error("INFRASTRUCTURE_NOT_ACTIVE");
      await client.query(`INSERT INTO ddi_idempotency (key, owner_subject, owner_id, response, created_at) VALUES ($1, '', $2, '{}'::jsonb, NOW()) ON CONFLICT (key) DO NOTHING`, [key, ownerId]);
      const locked = await client.query<{ owner_id: string | null; response: { id?: string } }>(`SELECT owner_id, response FROM ddi_idempotency WHERE key = $1 FOR UPDATE`, [key]);
      const row = locked.rows[0];
      if (!row || row.owner_id !== ownerId) throw new Error("IDEMPOTENCY_OWNER_MISMATCH");
      if (row.response?.id) {
        const existing = await this.application(client, row.response.id);
        if (!existing) throw new Error("UNKNOWN_APPLICATION");
        return existing;
      }
      const at = new Date().toISOString();
      const secret = `ddiapp_${randomBytes(32).toString("base64url")}`;
      const credentialHash = createHash("sha256").update(secret).digest("hex");
      const app: ApplicationRecord & { applicationCredential: string } = { id: `app:${randomUUID()}` as ApplicationRecord["id"], infrastructureId: infra.id, type: input.type, displayName: input.displayName, publicUrl: input.publicUrl, adminUrl: input.adminUrl, status: "ACTIVE", requestedCapabilities: input.capabilities, grantedCapabilities: [], createdAt: at, updatedAt: at, applicationCredential: secret };
      await client.query(`INSERT INTO ddi_applications (id, infrastructure_id, type, display_name, public_url, admin_url, status, requested_capabilities, granted_capabilities, credential_hash, created_at, updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,'[]'::jsonb,$9,$10,$10)`, [app.id, app.infrastructureId, app.type, app.displayName, app.publicUrl ?? null, app.adminUrl ?? null, app.status, JSON.stringify(app.requestedCapabilities), credentialHash, at]);
      const relationId = `relationship:${randomUUID()}`;
      await client.query(`INSERT INTO ddi_relationships (id, source, target, relationship_type, status, metadata, created_at, updated_at) VALUES ($1,$2,$3,'APPLICATION','ACTIVE','{}'::jsonb,$4,$4)`, [relationId, app.id, infra.id, at]);
      await client.query(`UPDATE ddi_infrastructures SET updated_at = $2 WHERE id = $1`, [infra.id, at]);
      await client.query(`UPDATE ddi_idempotency SET response = $2::jsonb WHERE key = $1`, [key, JSON.stringify({ id: app.id })]);
      return app;
    });
  }

  async grantCapabilities(ownerId: DigiOwnerId, infrastructureId: string, applicationId: string, capabilities: Capability[]): Promise<ApplicationRecord> {
    return this.transaction(async (client) => {
      const infra = await this.hydrate(client, infrastructureId);
      const app = await this.application(client, applicationId);
      if (!infra || !app || app.infrastructureId !== infra.id) throw new Error("UNKNOWN_APPLICATION");
      if (infra.ownerId !== ownerId) throw new Error("OWNER_REQUIRED");
      for (const capability of capabilities) if (!app.requestedCapabilities.includes(capability)) throw new Error("CAPABILITY_NOT_REQUESTED");
      const granted = [...new Set([...app.grantedCapabilities, ...capabilities])];
      const at = new Date().toISOString();
      await client.query(`UPDATE ddi_applications SET granted_capabilities = $2::jsonb, updated_at = $3 WHERE id = $1`, [applicationId, JSON.stringify(granted), at]);
      app.grantedCapabilities = granted;
      app.updatedAt = at;
      return app;
    });
  }

  async ensurePersonalIdentity(infrastructureId: string) {
    await this.transaction(async (client) => { await this.ensureIdentityBinding(client, infrastructureId); });
  }

  private async ensureIdentityBinding(client: PoolClient, infrastructureId: string) {
    const infra = await client.query<{ owner_id: string | null; type: string }>(`SELECT owner_id, type FROM ddi_infrastructures WHERE id = $1 FOR UPDATE`, [infrastructureId]);
    const row = infra.rows[0];
    if (!row?.owner_id || row.type !== "PERSONAL") return null;
    const existing = await client.query<BindingRow>(`SELECT id, infrastructure_id, namespace, provider, configured, provider_reference FROM ddi_primitive_bindings WHERE infrastructure_id = $1 AND namespace = 'identity' FOR UPDATE`, [infrastructureId]);
    if (existing.rows[0]) {
      if (existing.rows[0].provider !== "TrustID") throw new Error("PROVIDER_CONFLICT");
      return mapBinding(existing.rows[0]);
    }
    const at = new Date().toISOString();
    const inserted = await client.query<BindingRow>(`INSERT INTO ddi_primitive_bindings (id, infrastructure_id, namespace, provider, configured, provider_reference, created_at, updated_at) VALUES ($1,$2,'identity','TrustID',TRUE,'SYSTEM_MANAGED',$3,$3) RETURNING id, infrastructure_id, namespace, provider, configured, provider_reference`, [`binding:${randomUUID()}`, infrastructureId, at]);
    const relationId = `relationship:${randomUUID()}`;
    await client.query(`INSERT INTO ddi_relationships (id, source, target, relationship_type, status, metadata, created_at, updated_at) VALUES ($1,$2,$3,'PRIMITIVE_BINDING','ACTIVE','{}'::jsonb,$4,$4)`, [relationId, infrastructureId, inserted.rows[0]?.id, at]);
    await client.query(`UPDATE ddi_infrastructures SET updated_at = $2 WHERE id = $1`, [infrastructureId, at]);
    return inserted.rows[0] ? mapBinding(inserted.rows[0]) : null;
  }

  async ensurePersonalCommunication(infrastructureId: string, ownerTrustId?: string) {
    await this.transaction(async (client) => { await this.ensureCommunicationBinding(client, infrastructureId, ownerTrustId); });
  }

  private async ensureCommunicationBinding(client: PoolClient, infrastructureId: string, ownerTrustId?: string) {
    const infra = await client.query<{ owner_id: string | null; type: string }>(`SELECT owner_id, type FROM ddi_infrastructures WHERE id = $1 FOR UPDATE`, [infrastructureId]);
    const row = infra.rows[0];
    if (!row?.owner_id || row.type !== "PERSONAL") return null;
    const subject = isCanonicalMailboxSubject(ownerTrustId, row.owner_id) ? ownerTrustId : undefined;
    const existing = await client.query<BindingRow>(`SELECT id, infrastructure_id, namespace, provider, configured, provider_reference FROM ddi_primitive_bindings WHERE infrastructure_id = $1 AND namespace = 'communication' FOR UPDATE`, [infrastructureId]);
    if (existing.rows[0]) {
      if (existing.rows[0].provider !== "ElfCom") throw new Error("PROVIDER_CONFLICT");
      if (!subject) return mapBinding(existing.rows[0]);
      const current = parseCommunicationBinding(existing.rows[0].provider_reference ?? undefined, row.owner_id);
      const next = communicationBindingReference(subject, row.owner_id);
      if (current.status === "OK" && current.ownerTrustId === subject) return mapBinding(existing.rows[0]);
      if (current.status === "OK") throw new Error("PROVIDER_CONFLICT");
      const at = new Date().toISOString();
      await client.query(`UPDATE ddi_primitive_bindings SET provider_reference = $2, configured = TRUE, updated_at = $3 WHERE id = $1`, [existing.rows[0].id, next, at]);
      return mapBinding({ ...existing.rows[0], provider_reference: next, configured: true });
    }
    if (!subject) return null;
    const reference = communicationBindingReference(subject, row.owner_id);
    const at = new Date().toISOString();
    const inserted = await client.query<BindingRow>(`INSERT INTO ddi_primitive_bindings (id, infrastructure_id, namespace, provider, configured, provider_reference, created_at, updated_at) VALUES ($1,$2,'communication','ElfCom',TRUE,$3,$4,$4) RETURNING id, infrastructure_id, namespace, provider, configured, provider_reference`, [`binding:${randomUUID()}`, infrastructureId, reference, at]);
    const relationId = `relationship:${randomUUID()}`;
    await client.query(`INSERT INTO ddi_relationships (id, source, target, relationship_type, status, metadata, created_at, updated_at) VALUES ($1,$2,$3,'PRIMITIVE_BINDING','ACTIVE','{}'::jsonb,$4,$4)`, [relationId, infrastructureId, inserted.rows[0]?.id, at]);
    await client.query(`UPDATE ddi_infrastructures SET updated_at = $2 WHERE id = $1`, [infrastructureId, at]);
    return inserted.rows[0] ? mapBinding(inserted.rows[0]) : null;
  }

  async bind(ownerId: DigiOwnerId, infrastructureId: string, namespace: PrimitiveBinding["namespace"], provider: PrimitiveBinding["provider"], reference?: string): Promise<PrimitiveBinding> {
    return this.transaction(async (client) => {
      const infra = await this.hydrate(client, infrastructureId);
      if (!infra || infra.ownerId !== ownerId) throw new Error("OWNER_REQUIRED");
      if (namespace === "identity" && infra.type === "PERSONAL" && provider !== "TrustID") throw new Error("PROVIDER_LOCKED");
      if (namespace === "communication" && infra.type === "PERSONAL" && provider !== "ElfCom") throw new Error("PROVIDER_LOCKED");
      const at = new Date().toISOString();
      const inserted = await client.query<BindingRow>(`INSERT INTO ddi_primitive_bindings (id, infrastructure_id, namespace, provider, configured, provider_reference, created_at, updated_at) VALUES ($1,$2,$3,$4,TRUE,$5,$6,$6) ON CONFLICT (infrastructure_id, namespace) DO NOTHING RETURNING id, infrastructure_id, namespace, provider, configured, provider_reference`, [`binding:${randomUUID()}`, infrastructureId, namespace, provider, reference ?? null, at]);
      if (inserted.rows[0]) {
        const relationId = `relationship:${randomUUID()}`;
        await client.query(`INSERT INTO ddi_relationships (id, source, target, relationship_type, status, metadata, created_at, updated_at) VALUES ($1,$2,$3,'PRIMITIVE_BINDING','ACTIVE','{}'::jsonb,$4,$4)`, [relationId, infrastructureId, inserted.rows[0].id, at]);
        await client.query(`UPDATE ddi_infrastructures SET updated_at = $2 WHERE id = $1`, [infrastructureId, at]);
        return mapBinding(inserted.rows[0]);
      }
      const existing = await client.query<BindingRow>(`SELECT id, infrastructure_id, namespace, provider, configured, provider_reference FROM ddi_primitive_bindings WHERE infrastructure_id = $1 AND namespace = $2`, [infrastructureId, namespace]);
      const row = existing.rows[0];
      if (!row) throw new Error("BINDING_MISSING");
      if (row.provider !== provider) throw new Error("PROVIDER_CONFLICT");
      return mapBinding(row);
    });
  }

  async getInfrastructure(id: string) { const client = await this.pool.connect(); try { return await this.hydrate(client, id); } finally { client.release(); } }
  async getApplication(id: string) { const client = await this.pool.connect(); try { return await this.application(client, id); } finally { client.release(); } }
  async findBinding(infrastructureId: string, namespace: PrimitiveBinding["namespace"]) {
    const result = await this.pool.query<BindingRow>(`SELECT id, infrastructure_id, namespace, provider, configured, provider_reference FROM ddi_primitive_bindings WHERE infrastructure_id = $1 AND namespace = $2`, [infrastructureId, namespace]);
    return result.rows[0] ? mapBinding(result.rows[0]) : null;
  }
  async insertAudit(audit: AuditRecord) {
    await this.pool.query(`INSERT INTO ddi_audits (id, correlation_id, infrastructure_id, application_id, actor_subject, owner_id, audience, capability, action, resource, provider, grant_id, decision, reason, execution_mode, result, timestamp, connection_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`, [randomUUID(), audit.correlationId, audit.infrastructureId, audit.applicationId, audit.actor ?? null, audit.ownerId ?? null, audit.audience, audit.capability, audit.action, audit.resource, audit.provider ?? null, audit.grantId ?? null, audit.decision, audit.reason ?? null, audit.executionMode, audit.result, audit.timestamp, audit.connectionId ?? null]);
  }
  async relationshipsFor(infrastructureId: string) {
    const result = await this.pool.query<RelationRow>(`SELECT id, source, target, relationship_type, created_at FROM ddi_relationships WHERE source = $1 OR target = $1 ORDER BY created_at`, [infrastructureId]);
    return result.rows.map(mapRelation);
  }
  async snapshot(): Promise<PersistentState> {
    const [infras, apps, bindings, relations, audits] = await Promise.all([
      this.pool.query<InfraRow>(`SELECT id, owner_id, type, status, metadata, created_at, updated_at FROM ddi_infrastructures ORDER BY created_at`),
      this.pool.query<AppRow>(`SELECT id, infrastructure_id, type, display_name, public_url, admin_url, status, requested_capabilities, granted_capabilities, created_at, updated_at FROM ddi_applications ORDER BY created_at`),
      this.pool.query<BindingRow>(`SELECT id, infrastructure_id, namespace, provider, configured, provider_reference FROM ddi_primitive_bindings`),
      this.pool.query<RelationRow>(`SELECT id, source, target, relationship_type, created_at FROM ddi_relationships ORDER BY created_at`),
      this.pool.query<{ correlation_id: string; infrastructure_id: string; application_id: string; actor_subject: string | null; owner_id: string | null; audience: string; capability: string; action: string; resource: string; provider: string | null; grant_id: string | null; connection_id: string | null; decision: AuditRecord["decision"]; reason: string | null; execution_mode: AuditRecord["executionMode"]; result: AuditRecord["result"]; timestamp: Date }>(`SELECT correlation_id, infrastructure_id, application_id, actor_subject, owner_id, audience, capability, action, resource, provider, grant_id, connection_id, decision, reason, execution_mode, result, timestamp FROM ddi_audits ORDER BY timestamp`),
    ]);
    const applications = apps.rows.map(mapApp);
    const primitiveBindings = bindings.rows.map(mapBinding);
    const relationships = relations.rows.map(mapRelation);
    const infrastructures = await Promise.all(infras.rows.map(row => this.assemble(row, applications, primitiveBindings, relationships)));
    const connections = (await this.pool.query<ConnectionRow>(`SELECT id, infrastructure_id, application_id, owner_id, status, requested_capabilities, approved_capabilities, pending_capabilities, authority_grant_refs, revision, created_at, updated_at, approved_at, revoked_at FROM ddi_connections ORDER BY created_at`)).rows.map(mapConnection);
    const connectionAudits = await this.connectionAudits();
    return { infrastructures, applications, bindings: primitiveBindings, relationships, connections, connectionAudits, audits: audits.rows.map(row => ({ timestamp: iso(row.timestamp), correlationId: row.correlation_id, infrastructureId: row.infrastructure_id as AuditRecord["infrastructureId"], applicationId: row.application_id as AuditRecord["applicationId"], ownerId: (row.owner_id ?? undefined) as DigiOwnerId | undefined, actor: row.actor_subject ?? undefined, audience: row.audience, capability: row.capability as AuditRecord["capability"], action: row.action, resource: row.resource, provider: (row.provider ?? undefined) as AuditRecord["provider"], grantId: row.grant_id ?? undefined, connectionId: (row.connection_id ?? undefined) as AuditRecord["connectionId"], decision: row.decision, reason: row.reason ?? undefined, executionMode: row.execution_mode, result: row.result })), idempotency: {} };
  }

  async findPersonal(ownerId: DigiOwnerId, ownerTrustId?: string) {
    const result = await this.pool.query<{ id: string }>(`SELECT id FROM ddi_infrastructures WHERE owner_id = $1 AND type = 'PERSONAL'`, [ownerId]);
    if (!result.rows[0]) return null;
    await this.ensurePersonalIdentity(result.rows[0].id);
    await this.ensurePersonalCommunication(result.rows[0].id, ownerTrustId);
    return this.getInfrastructure(result.rows[0].id);
  }
  async findApplicationByCredential(secret: string) {
    const hash = createHash("sha256").update(secret).digest("hex");
    const result = await this.pool.query<{ id: string }>(`SELECT id FROM ddi_applications WHERE credential_hash = $1`, [hash]);
    return result.rows[0] ? this.getApplication(result.rows[0].id) : null;
  }
  async getConnection(id: string) {
    const result = await this.pool.query<ConnectionRow>(`SELECT id, infrastructure_id, application_id, owner_id, status, requested_capabilities, approved_capabilities, pending_capabilities, authority_grant_refs, revision, created_at, updated_at, approved_at, revoked_at FROM ddi_connections WHERE id = $1`, [id]);
    return result.rows[0] ? mapConnection(result.rows[0]) : null;
  }
  async listConnections(infrastructureId: string) {
    const result = await this.pool.query<ConnectionRow>(`SELECT id, infrastructure_id, application_id, owner_id, status, requested_capabilities, approved_capabilities, pending_capabilities, authority_grant_refs, revision, created_at, updated_at, approved_at, revoked_at FROM ddi_connections WHERE infrastructure_id = $1 ORDER BY created_at`, [infrastructureId]);
    return result.rows.map(mapConnection);
  }
  async connectionAudits() {
    const result = await this.pool.query<{ event_type: ConnectionAuditRecord["eventType"]; correlation_id: string; owner_id: string | null; infrastructure_id: string; application_id: string | null; connection_id: string | null; capability: string | null; grant_id: string | null; result: string; reason: string | null; timestamp: Date }>(`SELECT event_type, correlation_id, owner_id, infrastructure_id, application_id, connection_id, capability, grant_id, result, reason, timestamp FROM ddi_connection_audits ORDER BY timestamp`);
    return result.rows.map(row => ({ eventType: row.event_type, correlationId: row.correlation_id, ownerId: (row.owner_id ?? undefined) as DigiOwnerId | undefined, infrastructureId: row.infrastructure_id as ConnectionAuditRecord["infrastructureId"], applicationId: (row.application_id ?? undefined) as ConnectionAuditRecord["applicationId"], connectionId: (row.connection_id ?? undefined) as ConnectionAuditRecord["connectionId"], capability: (row.capability ?? undefined) as Capability | undefined, grantId: row.grant_id ?? undefined, result: row.result, reason: row.reason ?? undefined, timestamp: iso(row.timestamp) }));
  }
  async requestConnection(applicationId: string, capabilities: Capability[], correlationId: string, idempotencyKey: string) {
    if (!capabilities.length || !idempotencyKey) throw new Error("INVALID_REQUEST");
    return this.transaction(async (client) => {
      const app = await this.application(client, applicationId);
      if (!app) throw new Error("UNKNOWN_APPLICATION");
      assertCapabilitySubset(capabilities, app.requestedCapabilities);
      const infra = await this.hydrate(client, app.infrastructureId);
      if (!infra || infra.status !== "ACTIVE") throw new Error("INFRASTRUCTURE_NOT_ACTIVE");
      const key = `connection:${idempotencyKey}`;
      await client.query(`INSERT INTO ddi_idempotency (key, owner_subject, owner_id, response, created_at) VALUES ($1, '', $2, '{}'::jsonb, NOW()) ON CONFLICT (key) DO NOTHING`, [key, infra.ownerId]);
      const lockedKey = await client.query<{ response: { id?: string } }>(`SELECT response FROM ddi_idempotency WHERE key = $1 FOR UPDATE`, [key]);
      if (lockedKey.rows[0]?.response?.id) {
        const prior = await this.connectionById(client, lockedKey.rows[0].response.id);
        if (prior) { if (prior.applicationId !== app.id) throw new Error("IDEMPOTENCY_OWNER_MISMATCH"); return prior; }
      }
      const at = new Date().toISOString();
      const inserted = await client.query<ConnectionRow>(`INSERT INTO ddi_connections (id, infrastructure_id, application_id, owner_id, status, requested_capabilities, approved_capabilities, pending_capabilities, authority_grant_refs, revision, created_at, updated_at) VALUES ($1,$2,$3,$4,'REQUESTED',$5::jsonb,'[]'::jsonb,'[]'::jsonb,'[]'::jsonb,1,$6,$6) ON CONFLICT (infrastructure_id, application_id) DO NOTHING RETURNING id, infrastructure_id, application_id, owner_id, status, requested_capabilities, approved_capabilities, pending_capabilities, authority_grant_refs, revision, created_at, updated_at, approved_at, revoked_at`, [`connection:${randomUUID()}`, infra.id, app.id, infra.ownerId, JSON.stringify(capabilities), at]);
      if (inserted.rows[0]) {
        const created = mapConnection(inserted.rows[0]);
        await this.connectionEvent(client, { eventType: "CONNECTION_REQUESTED", correlationId, ownerId: created.ownerId, infrastructureId: created.infrastructureId, applicationId: created.applicationId, connectionId: created.id, result: "REQUESTED", timestamp: at });
        await client.query(`UPDATE ddi_idempotency SET response = $2::jsonb WHERE key = $1`, [key, JSON.stringify({ id: created.id })]);
        return created;
      }
      const current = await this.connectionFor(client, infra.id, app.id);
      if (!current) throw new Error("CONNECTION_NOT_FOUND");
      if (current.status === "ACTIVE") throw new Error("CONNECTION_ALREADY_ACTIVE");
      if (current.status === "REQUESTED" && sameCapabilities(current.requestedCapabilities, capabilities)) return current;
      if (current.status === "REQUESTED_CHANGE" && sameCapabilities(current.pendingCapabilities, capabilities)) return current;
      const nextStatus = current.status === "REVOKED" ? "REQUESTED" : current.status === "REQUESTED_CHANGE" ? "REQUESTED_CHANGE" : "REQUESTED";
      const event = current.status === "REVOKED" ? "CONNECTION_RECONNECTED" : "CAPABILITY_REQUESTED";
      const updated = await client.query<ConnectionRow>(`UPDATE ddi_connections SET status = $2, requested_capabilities = CASE WHEN $2 = 'REQUESTED' THEN $3::jsonb ELSE requested_capabilities END, pending_capabilities = CASE WHEN $2 = 'REQUESTED_CHANGE' THEN $3::jsonb ELSE '[]'::jsonb END, approved_capabilities = CASE WHEN $2 = 'REQUESTED' AND status = 'REVOKED' THEN '[]'::jsonb ELSE approved_capabilities END, authority_grant_refs = CASE WHEN status = 'REVOKED' THEN '[]'::jsonb ELSE authority_grant_refs END, approved_at = CASE WHEN status = 'REVOKED' THEN NULL ELSE approved_at END, revoked_at = CASE WHEN status = 'REVOKED' THEN NULL ELSE revoked_at END, revision = revision + 1, updated_at = $4 WHERE id = $1 RETURNING id, infrastructure_id, application_id, owner_id, status, requested_capabilities, approved_capabilities, pending_capabilities, authority_grant_refs, revision, created_at, updated_at, approved_at, revoked_at`, [current.id, nextStatus, JSON.stringify(capabilities), at]);
      const saved = mapConnection(updated.rows[0]!);
      await this.connectionEvent(client, { eventType: event, correlationId, ownerId: saved.ownerId, infrastructureId: saved.infrastructureId, applicationId: saved.applicationId, connectionId: saved.id, result: saved.status, timestamp: at });
      await client.query(`UPDATE ddi_idempotency SET response = $2::jsonb WHERE key = $1`, [key, JSON.stringify({ id: saved.id })]);
      return saved;
    });
  }
  async requestCapabilityChange(applicationId: string, capabilities: Capability[], correlationId: string) {
    if (!capabilities.length) throw new Error("INVALID_REQUEST");
    return this.transaction(async (client) => {
      const app = await this.application(client, applicationId);
      if (!app) throw new Error("UNKNOWN_APPLICATION");
      assertCapabilitySubset(capabilities, app.requestedCapabilities);
      const current = await this.connectionFor(client, app.infrastructureId, app.id);
      if (!current || current.status !== "ACTIVE") throw new Error("CONNECTION_NOT_ACTIVE");
      const fresh = capabilities.filter(capability => !current.approvedCapabilities.includes(capability));
      if (!fresh.length) throw new Error("CAPABILITY_ALREADY_APPROVED");
      const at = new Date().toISOString();
      const updated = await client.query<ConnectionRow>(`UPDATE ddi_connections SET status = 'REQUESTED_CHANGE', pending_capabilities = $2::jsonb, revision = revision + 1, updated_at = $3 WHERE id = $1 RETURNING id, infrastructure_id, application_id, owner_id, status, requested_capabilities, approved_capabilities, pending_capabilities, authority_grant_refs, revision, created_at, updated_at, approved_at, revoked_at`, [current.id, JSON.stringify(fresh), at]);
      const saved = mapConnection(updated.rows[0]!);
      await this.connectionEvent(client, { eventType: "CAPABILITY_REQUESTED", correlationId, ownerId: saved.ownerId, infrastructureId: saved.infrastructureId, applicationId: saved.applicationId, connectionId: saved.id, result: "REQUESTED_CHANGE", timestamp: at });
      return saved;
    });
  }
  async approveConnection(ownerId: DigiOwnerId, connectionId: string, capabilities: Capability[], correlationId: string, grants: { ensureGrant(input: { ownerId: string; actor: string; action: string; resource: string; audience: string; sessionToken?: string }): Promise<{ grantId: string }> }, sessionToken?: string) {
    if (!capabilities.length) throw new Error("INVALID_REQUEST");
    return this.transaction(async (client) => {
      const current = await this.connectionById(client, connectionId);
      if (!current) throw new Error("CONNECTION_NOT_FOUND");
      if (current.ownerId !== ownerId) throw new Error("OWNER_REQUIRED");
      if (current.status !== "REQUESTED" && current.status !== "REQUESTED_CHANGE") {
        if (current.status === "ACTIVE" && sameCapabilities(current.approvedCapabilities, capabilities)) return current;
        throw new Error("CONNECTION_NOT_APPROVABLE");
      }
      const allowed = current.status === "REQUESTED" ? current.requestedCapabilities : current.pendingCapabilities;
      assertCapabilitySubset(capabilities, allowed);
      const refs: AuthorityGrantRef[] = [];
      for (const capability of capabilities) {
        const binding = authorityBinding(current.applicationId, current.infrastructureId, capability);
        let grantId: string;
        try { grantId = (await grants.ensureGrant({ ownerId, actor: binding.actor, action: binding.action, resource: binding.resource, audience: binding.audience, sessionToken })).grantId; }
        catch (error) { if (error instanceof Error && /^[A-Z0-9_]+$/.test(error.message)) throw error; throw new Error("AUTHORITY_GRANT_UNAVAILABLE"); }
        refs.push({ ...binding, grantId });
      }
      const still = await this.connectionById(client, connectionId);
      if (!still || (still.status !== "REQUESTED" && still.status !== "REQUESTED_CHANGE")) throw new Error("CONNECTION_NOT_APPROVABLE");
      const approved = still.status === "REQUESTED_CHANGE" ? [...new Set([...still.approvedCapabilities, ...capabilities])] : [...capabilities];
      const kept = still.authorityGrantRefs.filter(item => approved.includes(item.capability) && !refs.some(ref => ref.capability === item.capability));
      const at = new Date().toISOString();
      const updated = await client.query<ConnectionRow>(`UPDATE ddi_connections SET status = 'ACTIVE', approved_capabilities = $2::jsonb, pending_capabilities = '[]'::jsonb, authority_grant_refs = $3::jsonb, approved_at = $4, revision = revision + 1, updated_at = $4 WHERE id = $1 RETURNING id, infrastructure_id, application_id, owner_id, status, requested_capabilities, approved_capabilities, pending_capabilities, authority_grant_refs, revision, created_at, updated_at, approved_at, revoked_at`, [connectionId, JSON.stringify(approved), JSON.stringify([...kept, ...refs]), at]);
      const saved = mapConnection(updated.rows[0]!);
      await this.connectionEvent(client, { eventType: "CONNECTION_APPROVED", correlationId, ownerId: saved.ownerId, infrastructureId: saved.infrastructureId, applicationId: saved.applicationId, connectionId: saved.id, result: "APPROVED", timestamp: at });
      await this.connectionEvent(client, { eventType: "CONNECTION_ACTIVATED", correlationId, ownerId: saved.ownerId, infrastructureId: saved.infrastructureId, applicationId: saved.applicationId, connectionId: saved.id, result: "ACTIVE", timestamp: at });
      for (const ref of refs) await this.connectionEvent(client, { eventType: "CAPABILITY_APPROVED", correlationId, ownerId: saved.ownerId, infrastructureId: saved.infrastructureId, applicationId: saved.applicationId, connectionId: saved.id, capability: ref.capability, grantId: ref.grantId, result: "APPROVED", timestamp: at });
      return saved;
    });
  }
  async revokeConnection(ownerId: DigiOwnerId, connectionId: string, correlationId: string, grants: { revokeGrant(input: { ownerId: string; grantId: string; sessionToken?: string }): Promise<void> }, sessionToken?: string) {
    return this.transaction(async (client) => {
      const current = await this.connectionById(client, connectionId);
      if (!current) throw new Error("CONNECTION_NOT_FOUND");
      if (current.ownerId !== ownerId) throw new Error("OWNER_REQUIRED");
      if (current.status === "REVOKED") return current;
      if (current.status !== "ACTIVE" && current.status !== "REQUESTED" && current.status !== "REQUESTED_CHANGE") throw new Error("CONNECTION_NOT_REVOCABLE");
      for (const ref of current.authorityGrantRefs) await grants.revokeGrant({ ownerId, grantId: ref.grantId, sessionToken });
      const at = new Date().toISOString();
      const updated = await client.query<ConnectionRow>(`UPDATE ddi_connections SET status = 'REVOKED', revoked_at = $2, revision = revision + 1, updated_at = $2 WHERE id = $1 RETURNING id, infrastructure_id, application_id, owner_id, status, requested_capabilities, approved_capabilities, pending_capabilities, authority_grant_refs, revision, created_at, updated_at, approved_at, revoked_at`, [connectionId, at]);
      const saved = mapConnection(updated.rows[0]!);
      await this.connectionEvent(client, { eventType: "CONNECTION_REVOKED", correlationId, ownerId: saved.ownerId, infrastructureId: saved.infrastructureId, applicationId: saved.applicationId, connectionId: saved.id, result: "REVOKED", timestamp: at });
      return saved;
    });
  }
  async revokeCapabilities(ownerId: DigiOwnerId, connectionId: string, capabilities: Capability[], correlationId: string, grants: { revokeGrant(input: { ownerId: string; grantId: string; sessionToken?: string }): Promise<void> }, sessionToken?: string) {
    if (!capabilities.length) throw new Error("INVALID_REQUEST");
    return this.transaction(async (client) => {
      const current = await this.connectionById(client, connectionId);
      if (!current || current.status !== "ACTIVE") throw new Error("CONNECTION_NOT_ACTIVE");
      if (current.ownerId !== ownerId) throw new Error("OWNER_REQUIRED");
      assertCapabilitySubset(capabilities, current.approvedCapabilities);
      const removed = current.authorityGrantRefs.filter(item => capabilities.includes(item.capability));
      for (const ref of removed) await grants.revokeGrant({ ownerId, grantId: ref.grantId, sessionToken });
      const approved = current.approvedCapabilities.filter(item => !capabilities.includes(item));
      const refs = current.authorityGrantRefs.filter(item => !capabilities.includes(item.capability));
      const at = new Date().toISOString();
      const updated = await client.query<ConnectionRow>(`UPDATE ddi_connections SET approved_capabilities = $2::jsonb, authority_grant_refs = $3::jsonb, revision = revision + 1, updated_at = $4 WHERE id = $1 RETURNING id, infrastructure_id, application_id, owner_id, status, requested_capabilities, approved_capabilities, pending_capabilities, authority_grant_refs, revision, created_at, updated_at, approved_at, revoked_at`, [connectionId, JSON.stringify(approved), JSON.stringify(refs), at]);
      const saved = mapConnection(updated.rows[0]!);
      for (const capability of capabilities) await this.connectionEvent(client, { eventType: "CAPABILITY_REVOKED", correlationId, ownerId: saved.ownerId, infrastructureId: saved.infrastructureId, applicationId: saved.applicationId, connectionId: saved.id, capability, result: "REVOKED", timestamp: at });
      return saved;
    });
  }
  private async connectionById(client: PoolClient, id: string) {
    const result = await client.query<ConnectionRow>(`SELECT id, infrastructure_id, application_id, owner_id, status, requested_capabilities, approved_capabilities, pending_capabilities, authority_grant_refs, revision, created_at, updated_at, approved_at, revoked_at FROM ddi_connections WHERE id = $1 FOR UPDATE`, [id]);
    return result.rows[0] ? mapConnection(result.rows[0]) : null;
  }
  private async connectionFor(client: PoolClient, infrastructureId: string, applicationId: string) {
    const result = await client.query<ConnectionRow>(`SELECT id, infrastructure_id, application_id, owner_id, status, requested_capabilities, approved_capabilities, pending_capabilities, authority_grant_refs, revision, created_at, updated_at, approved_at, revoked_at FROM ddi_connections WHERE infrastructure_id = $1 AND application_id = $2 FOR UPDATE`, [infrastructureId, applicationId]);
    return result.rows[0] ? mapConnection(result.rows[0]) : null;
  }
  private async connectionEvent(client: PoolClient, event: ConnectionAuditRecord) {
    await client.query(`INSERT INTO ddi_connection_audits (id, event_type, correlation_id, owner_id, infrastructure_id, application_id, connection_id, capability, grant_id, result, reason, timestamp) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`, [randomUUID(), event.eventType, event.correlationId, event.ownerId ?? null, event.infrastructureId, event.applicationId ?? null, event.connectionId ?? null, event.capability ?? null, event.grantId ?? null, event.result, event.reason ?? null, event.timestamp]);
  }
  private async hydrate(client: Pool | PoolClient, id: string) {
    const result = await client.query<InfraRow>(`SELECT id, owner_id, type, status, metadata, created_at, updated_at FROM ddi_infrastructures WHERE id = $1`, [id]);
    const row = result.rows[0];
    if (!row?.owner_id) return null;
    const apps = await client.query<AppRow>(`SELECT id, infrastructure_id, type, display_name, public_url, admin_url, status, requested_capabilities, granted_capabilities, created_at, updated_at FROM ddi_applications WHERE infrastructure_id = $1`, [id]);
    const bindings = await client.query<BindingRow>(`SELECT id, infrastructure_id, namespace, provider, configured, provider_reference FROM ddi_primitive_bindings WHERE infrastructure_id = $1`, [id]);
    const relations = await client.query<RelationRow>(`SELECT id, source, target, relationship_type, created_at FROM ddi_relationships WHERE source = $1 OR target = $1`, [id]);
    return this.assemble(row, apps.rows.map(mapApp), bindings.rows.map(mapBinding), relations.rows.map(mapRelation));
  }
  private assemble(row: InfraRow, applications: ApplicationRecord[], bindings: PrimitiveBinding[], relationships: Relationship[]): InfrastructureRecord {
    return { id: row.id as InfrastructureRecord["id"], ownerId: row.owner_id as DigiOwnerId, type: row.type, status: row.status, applicationIds: applications.filter(app => app.infrastructureId === row.id).map(app => app.id), primitiveBindingIds: bindings.filter(binding => binding.infrastructureId === row.id).map(binding => binding.id), relationshipIds: relationships.filter(relation => relation.from === row.id || relation.to === row.id).map(relation => relation.id), createdAt: iso(row.created_at), updatedAt: iso(row.updated_at), metadata: row.metadata ?? {} };
  }
  private async application(client: Pool | PoolClient, id: string) {
    const result = await client.query<AppRow>(`SELECT id, infrastructure_id, type, display_name, public_url, admin_url, status, requested_capabilities, granted_capabilities, created_at, updated_at FROM ddi_applications WHERE id = $1`, [id]);
    return result.rows[0] ? mapApp(result.rows[0]) : null;
  }
}

type ConnectionRow = { id: string; infrastructure_id: string; application_id: string; owner_id: string; status: PdiApplicationConnection["status"]; requested_capabilities: Capability[]; approved_capabilities: Capability[]; pending_capabilities: Capability[]; authority_grant_refs: AuthorityGrantRef[]; revision: number; created_at: Date; updated_at: Date; approved_at: Date | null; revoked_at: Date | null };
function mapConnection(row: ConnectionRow): PdiApplicationConnection {
  return { id: row.id as PdiApplicationConnection["id"], infrastructureId: row.infrastructure_id as PdiApplicationConnection["infrastructureId"], applicationId: row.application_id as PdiApplicationConnection["applicationId"], ownerId: row.owner_id as DigiOwnerId, status: row.status, requestedCapabilities: row.requested_capabilities, approvedCapabilities: row.approved_capabilities, pendingCapabilities: row.pending_capabilities, authorityGrantRefs: row.authority_grant_refs, revision: row.revision, createdAt: iso(row.created_at), updatedAt: iso(row.updated_at), approvedAt: row.approved_at ? iso(row.approved_at) : undefined, revokedAt: row.revoked_at ? iso(row.revoked_at) : undefined };
}
function mapApp(row: AppRow): ApplicationRecord {
  return { id: row.id as ApplicationRecord["id"], infrastructureId: row.infrastructure_id as ApplicationRecord["infrastructureId"], type: row.type, displayName: row.display_name, publicUrl: row.public_url ?? undefined, adminUrl: row.admin_url ?? undefined, status: row.status, requestedCapabilities: row.requested_capabilities, grantedCapabilities: row.granted_capabilities, createdAt: iso(row.created_at), updatedAt: iso(row.updated_at) };
}
function mapBinding(row: BindingRow): PrimitiveBinding {
  const reference = row.provider_reference ?? undefined;
  return { id: row.id as PrimitiveBinding["id"], infrastructureId: row.infrastructure_id as PrimitiveBinding["infrastructureId"], namespace: row.namespace, provider: row.provider, configured: row.configured, reference, management: reference === "SYSTEM_MANAGED" || reference?.startsWith("SYSTEM_MANAGED:") ? "SYSTEM_MANAGED" : undefined };
}
function mapRelation(row: RelationRow): Relationship {
  return { id: row.id as Relationship["id"], from: row.source, to: row.target, type: row.relationship_type, createdAt: iso(row.created_at) };
}
