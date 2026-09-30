import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import type { ApplicationRecord, AuditRecord, Capability, DigiOwnerId, InfrastructureRecord, PrimitiveBinding, Relationship } from "../../contracts/src/index.ts";
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
        const existing = await this.hydrate(client, row.response.id);
        if (!existing) throw new Error("IDEMPOTENCY_MISSING");
        return existing;
      }
      const at = new Date().toISOString();
      const infra: InfrastructureRecord = { id: `infra:${randomUUID()}` as InfrastructureRecord["id"], ownerId, type: input.type, status: "ACTIVE", applicationIds: [], primitiveBindingIds: [], relationshipIds: [], createdAt: at, updatedAt: at, metadata: input.metadata ?? {} };
      await client.query(`INSERT INTO ddi_infrastructures (id, owner_subject, owner_id, type, status, metadata, created_at, updated_at) VALUES ($1, '', $2, $3, $4, $5::jsonb, $6, $6)`, [infra.id, ownerId, infra.type, infra.status, JSON.stringify(infra.metadata), at]);
      const relation: Relationship = { id: `relationship:${randomUUID()}` as Relationship["id"], from: infra.id, to: ownerId, type: "OWNER", createdAt: at };
      await client.query(`INSERT INTO ddi_relationships (id, source, target, relationship_type, status, metadata, created_at, updated_at) VALUES ($1, $2, $3, 'OWNER', 'ACTIVE', '{}'::jsonb, $4, $4)`, [relation.id, relation.from, relation.to, at]);
      infra.relationshipIds = [relation.id];
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
      const app: ApplicationRecord = { id: `app:${randomUUID()}` as ApplicationRecord["id"], infrastructureId: infra.id, type: input.type, displayName: input.displayName, publicUrl: input.publicUrl, adminUrl: input.adminUrl, status: "ACTIVE", requestedCapabilities: input.capabilities, grantedCapabilities: [], createdAt: at, updatedAt: at };
      await client.query(`INSERT INTO ddi_applications (id, infrastructure_id, type, display_name, public_url, admin_url, status, requested_capabilities, granted_capabilities, created_at, updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,'[]'::jsonb,$9,$9)`, [app.id, app.infrastructureId, app.type, app.displayName, app.publicUrl ?? null, app.adminUrl ?? null, app.status, JSON.stringify(app.requestedCapabilities), at]);
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

  async bind(ownerId: DigiOwnerId, infrastructureId: string, namespace: PrimitiveBinding["namespace"], provider: PrimitiveBinding["provider"], reference?: string): Promise<PrimitiveBinding> {
    return this.transaction(async (client) => {
      const infra = await this.hydrate(client, infrastructureId);
      if (!infra || infra.ownerId !== ownerId) throw new Error("OWNER_REQUIRED");
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
    await this.pool.query(`INSERT INTO ddi_audits (id, correlation_id, infrastructure_id, application_id, actor_subject, owner_id, audience, capability, action, resource, provider, grant_id, decision, reason, execution_mode, result, timestamp) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`, [randomUUID(), audit.correlationId, audit.infrastructureId, audit.applicationId, audit.actor ?? null, audit.ownerId ?? null, audit.audience, audit.capability, audit.action, audit.resource, audit.provider ?? null, audit.grantId ?? null, audit.decision, audit.reason ?? null, audit.executionMode, audit.result, audit.timestamp]);
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
      this.pool.query<{ correlation_id: string; infrastructure_id: string; application_id: string; actor_subject: string | null; owner_id: string | null; audience: string; capability: string; action: string; resource: string; provider: string | null; grant_id: string | null; decision: AuditRecord["decision"]; reason: string | null; execution_mode: AuditRecord["executionMode"]; result: AuditRecord["result"]; timestamp: Date }>(`SELECT correlation_id, infrastructure_id, application_id, actor_subject, owner_id, audience, capability, action, resource, provider, grant_id, decision, reason, execution_mode, result, timestamp FROM ddi_audits ORDER BY timestamp`),
    ]);
    const applications = apps.rows.map(mapApp);
    const primitiveBindings = bindings.rows.map(mapBinding);
    const relationships = relations.rows.map(mapRelation);
    const infrastructures = await Promise.all(infras.rows.map(row => this.assemble(row, applications, primitiveBindings, relationships)));
    return { infrastructures, applications, bindings: primitiveBindings, relationships, audits: audits.rows.map(row => ({ timestamp: iso(row.timestamp), correlationId: row.correlation_id, infrastructureId: row.infrastructure_id as AuditRecord["infrastructureId"], applicationId: row.application_id as AuditRecord["applicationId"], ownerId: (row.owner_id ?? undefined) as DigiOwnerId | undefined, actor: row.actor_subject ?? undefined, audience: row.audience, capability: row.capability as AuditRecord["capability"], action: row.action, resource: row.resource, provider: (row.provider ?? undefined) as AuditRecord["provider"], grantId: row.grant_id ?? undefined, decision: row.decision, reason: row.reason ?? undefined, executionMode: row.execution_mode, result: row.result })), idempotency: {} };
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

function mapApp(row: AppRow): ApplicationRecord {
  return { id: row.id as ApplicationRecord["id"], infrastructureId: row.infrastructure_id as ApplicationRecord["infrastructureId"], type: row.type, displayName: row.display_name, publicUrl: row.public_url ?? undefined, adminUrl: row.admin_url ?? undefined, status: row.status, requestedCapabilities: row.requested_capabilities, grantedCapabilities: row.granted_capabilities, createdAt: iso(row.created_at), updatedAt: iso(row.updated_at) };
}
function mapBinding(row: BindingRow): PrimitiveBinding {
  return { id: row.id as PrimitiveBinding["id"], infrastructureId: row.infrastructure_id as PrimitiveBinding["infrastructureId"], namespace: row.namespace, provider: row.provider, configured: row.configured, reference: row.provider_reference ?? undefined };
}
function mapRelation(row: RelationRow): Relationship {
  return { id: row.id as Relationship["id"], from: row.source, to: row.target, type: row.relationship_type, createdAt: iso(row.created_at) };
}
