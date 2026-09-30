import { randomUUID } from "node:crypto";
import type { Actor, ApplicationId, ApplicationRecord, AuditRecord, AuthorityDecision, AuthorityGrantRef, Capability, CapabilityRequest, CapabilityResult, ConnectionAuditRecord, ConnectionId, InfrastructureId, InfrastructureRecord, InfrastructureStatus, InfrastructureType, PdiApplicationConnection, PrimitiveAdapter, PrimitiveBinding, PrimitiveBindingId, Provider, Relationship, RelationshipId } from "../../contracts/src/index.ts";
import { assertCapabilitySubset, authorityBinding, sameCapabilities } from "./connection.ts";
export * from "../../contracts/src/index.ts";
export { authorityBinding, describeCapabilities, describeCapability } from "./connection.ts";

const now = () => new Date().toISOString();
const id = <T extends string>(prefix: string) => `${prefix}:${randomUUID()}` as T;

export class InMemoryDdiStore {
  infrastructures = new Map<InfrastructureId, InfrastructureRecord>();
  applications = new Map<ApplicationId, ApplicationRecord>();
  bindings = new Map<PrimitiveBindingId, PrimitiveBinding>();
  relationships = new Map<RelationshipId, Relationship>();
  connections = new Map<ConnectionId, PdiApplicationConnection>();
  connectionAudits: ConnectionAuditRecord[] = [];
  audits: AuditRecord[] = [];
}

export class UnavailableAdapter implements PrimitiveAdapter {
  namespace: PrimitiveBinding["namespace"];
  provider: Provider;
  constructor(namespace: PrimitiveBinding["namespace"], provider: Provider) { this.namespace = namespace; this.provider = provider; }
  async resolve(binding: PrimitiveBinding) { return binding.configured ? { ok: false, reason: "PROVIDER_UNAVAILABLE" } : { ok: false, reason: "PROVIDER_NOT_CONFIGURED" }; }
  async execute(request: CapabilityRequest): Promise<CapabilityResult> { return { status: "CAPABILITY_UNAVAILABLE", correlationId: request.correlationId, provider: this.provider, reason: "PROVIDER_NOT_CONFIGURED" }; }
  async health() { return "NOT_CONFIGURED" as const; }
}

/** TrustID remains the identity primitive. Ownership stays the Digi ownerId already on the actor. */
export class TrustIdAdapter implements PrimitiveAdapter {
  namespace = "identity" as const;
  provider = "TrustID" as const;
  private verifyAssertion: (assertion: string) => Promise<{ subject?: string; ownerId?: Actor["ownerId"] } | null>;
  private configured: boolean;
  constructor(verifyAssertion: (assertion: string) => Promise<{ subject?: string; ownerId?: Actor["ownerId"] } | null>, configured = true) { this.verifyAssertion = verifyAssertion; this.configured = configured; }
  async resolve() { return this.configured ? { ok: true } : { ok: false, reason: "PROVIDER_NOT_CONFIGURED" }; }
  async execute(request: CapabilityRequest): Promise<CapabilityResult> {
    const assertion = typeof request.payload === "object" && request.payload && "assertion" in request.payload ? String((request.payload as { assertion?: string }).assertion ?? "") : "";
    if (request.capability === "identity.currentActor") {
      if (!request.actor?.verified || !request.actor.ownerId) return { status: "AUTHENTICATION_REQUIRED", correlationId: request.correlationId, provider: this.provider, reason: "TRUSTID_INTERACTION_REQUIRED" };
      let subject = request.actor.subject;
      if (assertion) {
        const verified = await this.verifyAssertion(assertion);
        if (!verified?.subject) return { status: "AUTHENTICATION_REQUIRED", correlationId: request.correlationId, provider: this.provider, reason: "TRUSTID_INTERACTION_REQUIRED" };
        subject = verified.subject;
      }
      return { status: "COMPLETED", correlationId: request.correlationId, provider: this.provider, data: { ownerId: request.actor.ownerId, subject, interaction: "SILENT" } };
    }
    const proof = assertion ? await this.verifyAssertion(assertion) : null;
    if (!proof?.subject) return { status: "AUTHENTICATION_REQUIRED", correlationId: request.correlationId, provider: this.provider, reason: "TRUSTID_INTERACTION_REQUIRED" };
    return { status: "COMPLETED", correlationId: request.correlationId, provider: this.provider, data: { subject: proof.subject, ownerId: request.actor?.ownerId, interaction: "SILENT" } };
  }
  async health() { return this.configured ? "CONNECTED" as const : "NOT_CONFIGURED" as const; }
}

export type AuthorityVerifier = (input: { request: CapabilityRequest; infrastructure: InfrastructureRecord }) => Promise<AuthorityDecision>;

export function auditDecision(status: CapabilityResult["status"]): AuditRecord["decision"] {
  if (status === "COMPLETED") return "ALLOW";
  if (status === "FAILED") return "FAILED";
  if (status === "AUTHENTICATION_REQUIRED") return "AUTHENTICATION";
  if (status.includes("UNAVAILABLE")) return "UNAVAILABLE";
  return "DENY";
}

export function toAudit(request: CapabilityRequest, result: CapabilityResult, grantId?: string): AuditRecord {
  return {
    timestamp: now(),
    correlationId: request.correlationId,
    infrastructureId: request.infrastructureId,
    applicationId: request.applicationId,
    ownerId: request.actor?.ownerId,
    actor: request.actor?.authorityActor,
    audience: request.audience,
    capability: request.capability,
    action: request.action,
    resource: request.resource,
    provider: result.provider,
    grantId,
    connectionId: request.connectionId,
    decision: auditDecision(result.status),
    reason: result.reason,
    executionMode: request.executionMode ?? "APP",
    result: result.status,
  };
}

/** Canonical capability execution. Callers supply already-loaded records. */
export async function executeCapability(input: {
  request: CapabilityRequest;
  infrastructure: InfrastructureRecord | null;
  application: ApplicationRecord | null;
  binding: PrimitiveBinding | null;
  connection: PdiApplicationConnection | null;
  adapters: PrimitiveAdapter[];
  authority: AuthorityVerifier;
}): Promise<{ result: CapabilityResult; audit: AuditRecord }> {
  const request = input.request;
  const finish = (result: CapabilityResult, grantId?: string) => ({ result, audit: toAudit(request, result, grantId) });
  const infra = input.infrastructure;
  const app = input.application;
  if (!infra) return finish({ status: "DENIED", correlationId: request.correlationId, reason: "UNKNOWN_INFRASTRUCTURE" });
  if (!app || app.infrastructureId !== infra.id) return finish({ status: "DENIED", correlationId: request.correlationId, reason: "UNKNOWN_OR_CROSS_INFRASTRUCTURE_APP" });
  if (infra.status !== "ACTIVE") return finish({ status: "DENIED", correlationId: request.correlationId, reason: "INFRASTRUCTURE_NOT_ACTIVE" });
  if (app.status !== "ACTIVE") return finish({ status: "DENIED", correlationId: request.correlationId, reason: "APPLICATION_NOT_ACTIVE" });
  if (!request.actor?.verified || !request.actor.ownerId) return finish({ status: "AUTHENTICATION_REQUIRED", correlationId: request.correlationId, reason: "VERIFIED_ACTOR_REQUIRED" });
  if (request.actor.ownerId !== infra.ownerId) return finish({ status: "DENIED", correlationId: request.correlationId, reason: "OWNER_MISMATCH" });
  const connection = input.connection;
  if (!connection || connection.infrastructureId !== infra.id || connection.applicationId !== app.id) return finish({ status: "DENIED", correlationId: request.correlationId, reason: "CONNECTION_REQUIRED" });
  request.connectionId = connection.id;
  if (connection.status !== "ACTIVE" && connection.status !== "REQUESTED_CHANGE") return finish({ status: "DENIED", correlationId: request.correlationId, reason: "CONNECTION_NOT_ACTIVE" });
  if (!connection.approvedCapabilities.includes(request.capability)) return finish({ status: "DENIED", correlationId: request.correlationId, reason: "CAPABILITY_NOT_APPROVED" });
  let decision: AuthorityDecision;
  try { decision = await input.authority({ request, infrastructure: infra }); }
  catch { return finish({ status: "FAILED", correlationId: request.correlationId, reason: "AUTHORITY_UNAVAILABLE" }); }
  if (!decision.ok) {
    const status = decision.reason === "MISSING" ? "AUTHENTICATION_REQUIRED" as const : "DENIED" as const;
    return finish({ status, correlationId: request.correlationId, reason: `AUTHORITY_${decision.reason}` });
  }
  const namespace = request.capability.split(".")[0] as PrimitiveBinding["namespace"];
  const binding = input.binding;
  const namespaceAdapters = input.adapters.filter(adapter => adapter.namespace === namespace);
  const adapter = binding ? namespaceAdapters.find(item => item.provider === binding.provider) : undefined;
  if (!binding || !adapter) {
    const mismatch = Boolean(binding && namespaceAdapters.length > 0);
    return finish({ status: "CAPABILITY_UNAVAILABLE", correlationId: request.correlationId, provider: binding?.provider, reason: mismatch ? "PROVIDER_MISMATCH" : "PROVIDER_NOT_CONFIGURED" });
  }
  try {
    const resolved = await adapter.resolve(binding);
    if (!resolved.ok) return finish({ status: "CAPABILITY_UNAVAILABLE", correlationId: request.correlationId, provider: binding.provider, reason: resolved.reason });
    return finish(await adapter.execute(request), decision.grantId);
  } catch {
    return finish({ status: "FAILED", correlationId: request.correlationId, provider: binding.provider, reason: "ADAPTER_FAILED" });
  }
}

export class DdiService {
  public store: InMemoryDdiStore;
  private authority: AuthorityVerifier;
  private adapters: Map<string, PrimitiveAdapter>;
  constructor(store: InMemoryDdiStore | undefined, authority: AuthorityVerifier, adapters = new Map<string, PrimitiveAdapter>()) { this.store = store ?? new InMemoryDdiStore(); this.authority = authority; this.adapters = adapters; }
  createInfrastructure(owner: Actor, type: InfrastructureType, metadata: Record<string, string> = {}): InfrastructureRecord {
    if (!owner.verified || !owner.ownerId) throw new Error("AUTHENTICATED_OWNER_REQUIRED");
    if (type === "PERSONAL") {
      const existing = [...this.store.infrastructures.values()].find(item => item.ownerId === owner.ownerId && item.type === "PERSONAL");
      if (existing) { this.ensurePersonalIdentity(existing.id); return existing; }
    }
    const createdAt = now();
    const record: InfrastructureRecord = { id: id<InfrastructureId>("infra"), ownerId: owner.ownerId, type, status: "ACTIVE", applicationIds: [], primitiveBindingIds: [], relationshipIds: [], createdAt, updatedAt: createdAt, metadata };
    this.store.infrastructures.set(record.id, record);
    this.relationship(record.id, owner.ownerId, "OWNER");
    if (type === "PERSONAL") this.ensurePersonalIdentity(record.id);
    return record;
  }
  registerApplication(input: Omit<ApplicationRecord, "id" | "createdAt" | "updatedAt" | "grantedCapabilities"> & { grantedCapabilities?: Capability[] }): ApplicationRecord {
    const infrastructure = this.store.infrastructures.get(input.infrastructureId);
    if (!infrastructure) throw new Error("UNKNOWN_INFRASTRUCTURE");
    const createdAt = now();
    const record: ApplicationRecord = { ...input, grantedCapabilities: [], id: id<ApplicationId>("app"), createdAt, updatedAt: createdAt };
    this.store.applications.set(record.id, record);
    infrastructure.applicationIds.push(record.id);
    infrastructure.updatedAt = createdAt;
    this.relationship(record.id, infrastructure.id, "APPLICATION");
    return record;
  }
  grantCapabilities(applicationId: ApplicationId, capabilities: Capability[]) {
    const app = this.store.applications.get(applicationId);
    if (!app) throw new Error("UNKNOWN_APPLICATION");
    for (const capability of capabilities) if (!app.requestedCapabilities.includes(capability)) throw new Error("CAPABILITY_NOT_REQUESTED");
    app.grantedCapabilities = [...new Set([...app.grantedCapabilities, ...capabilities])];
    app.updatedAt = now();
    return app;
  }
  bind(infrastructureId: InfrastructureId, namespace: PrimitiveBinding["namespace"], provider: Provider, configured = false, reference?: string) {
    const infrastructure = this.requiredInfrastructure(infrastructureId);
    if (namespace === "identity" && infrastructure.type === "PERSONAL" && provider !== "TrustID") throw new Error("PROVIDER_LOCKED");
    const existing = [...this.store.bindings.values()].find(binding => binding.infrastructureId === infrastructureId && binding.namespace === namespace);
    if (existing) { if (existing.provider !== provider) throw new Error("PROVIDER_CONFLICT"); return existing; }
    const binding = { id: id<PrimitiveBindingId>("binding"), infrastructureId, namespace, provider, configured, reference, management: reference === "SYSTEM_MANAGED" ? "SYSTEM_MANAGED" as const : undefined };
    this.store.bindings.set(binding.id, binding);
    infrastructure.primitiveBindingIds.push(binding.id);
    this.relationship(infrastructureId, binding.id, "PRIMITIVE_BINDING");
    return binding;
  }
  suspend(id: InfrastructureId, status: InfrastructureStatus = "SUSPENDED") { const infra = this.requiredInfrastructure(id); infra.status = status; infra.updatedAt = now(); }
  findPersonal(ownerId: Actor["ownerId"]) { return [...this.store.infrastructures.values()].find(item => item.ownerId === ownerId && item.type === "PERSONAL") ?? null; }
  requestConnection(applicationId: ApplicationId, capabilities: Capability[], correlationId = "connection"): PdiApplicationConnection {
    const app = this.store.applications.get(applicationId);
    if (!app) throw new Error("UNKNOWN_APPLICATION");
    if (!capabilities.length) throw new Error("INVALID_REQUEST");
    assertCapabilitySubset(capabilities, app.requestedCapabilities);
    const infra = this.requiredInfrastructure(app.infrastructureId);
    const existing = [...this.store.connections.values()].find(item => item.infrastructureId === infra.id && item.applicationId === app.id);
    const at = now();
    if (!existing) {
      const connection: PdiApplicationConnection = { id: id<ConnectionId>("connection"), infrastructureId: infra.id, applicationId: app.id, ownerId: infra.ownerId, status: "REQUESTED", requestedCapabilities: [...capabilities], approvedCapabilities: [], pendingCapabilities: [], authorityGrantRefs: [], revision: 1, createdAt: at, updatedAt: at };
      this.store.connections.set(connection.id, connection);
      this.connectionAudit(connection, "CONNECTION_REQUESTED", correlationId, "REQUESTED");
      return connection;
    }
    if (existing.status === "ACTIVE") throw new Error("CONNECTION_ALREADY_ACTIVE");
    if (existing.status === "REQUESTED" && sameCapabilities(existing.requestedCapabilities, capabilities)) return existing;
    if (existing.status === "REQUESTED") { existing.requestedCapabilities = [...capabilities]; existing.updatedAt = at; existing.revision += 1; this.connectionAudit(existing, "CAPABILITY_REQUESTED", correlationId, "REQUESTED"); return existing; }
    if (existing.status === "REQUESTED_CHANGE") { if (sameCapabilities(existing.pendingCapabilities, capabilities)) return existing; existing.pendingCapabilities = [...capabilities]; existing.updatedAt = at; existing.revision += 1; this.connectionAudit(existing, "CAPABILITY_REQUESTED", correlationId, "REQUESTED_CHANGE"); return existing; }
    existing.status = "REQUESTED";
    existing.requestedCapabilities = [...capabilities];
    existing.approvedCapabilities = [];
    existing.pendingCapabilities = [];
    existing.authorityGrantRefs = [];
    existing.approvedAt = undefined;
    existing.revokedAt = undefined;
    existing.updatedAt = at;
    existing.revision += 1;
    this.connectionAudit(existing, "CONNECTION_RECONNECTED", correlationId, "REQUESTED");
    return existing;
  }
  requestCapabilityChange(applicationId: ApplicationId, capabilities: Capability[], correlationId = "capability-change") {
    const app = this.store.applications.get(applicationId);
    if (!app) throw new Error("UNKNOWN_APPLICATION");
    assertCapabilitySubset(capabilities, app.requestedCapabilities);
    const connection = [...this.store.connections.values()].find(item => item.applicationId === applicationId);
    if (!connection || connection.status !== "ACTIVE") throw new Error("CONNECTION_NOT_ACTIVE");
    const fresh = capabilities.filter(capability => !connection.approvedCapabilities.includes(capability));
    if (!fresh.length) throw new Error("CAPABILITY_ALREADY_APPROVED");
    connection.status = "REQUESTED_CHANGE";
    connection.pendingCapabilities = fresh;
    connection.updatedAt = now();
    connection.revision += 1;
    this.connectionAudit(connection, "CAPABILITY_REQUESTED", correlationId, "REQUESTED_CHANGE");
    return connection;
  }
  async approveConnection(owner: Actor, connectionId: ConnectionId, capabilities: Capability[], grants: { ensureGrant(input: AuthorityGrantRef): Promise<{ grantId: string }> }, correlationId = "approve"): Promise<PdiApplicationConnection> {
    if (!owner.verified || !owner.ownerId) throw new Error("OWNER_REQUIRED");
    const connection = this.store.connections.get(connectionId);
    if (!connection) throw new Error("CONNECTION_NOT_FOUND");
    if (connection.ownerId !== owner.ownerId) throw new Error("OWNER_REQUIRED");
    if (connection.status !== "REQUESTED" && connection.status !== "REQUESTED_CHANGE") throw new Error("CONNECTION_NOT_APPROVABLE");
    const allowed = connection.status === "REQUESTED" ? connection.requestedCapabilities : connection.pendingCapabilities;
    if (!capabilities.length) throw new Error("INVALID_REQUEST");
    assertCapabilitySubset(capabilities, allowed);
    const refs: AuthorityGrantRef[] = [];
    for (const capability of capabilities) {
      const binding = authorityBinding(connection.applicationId, connection.infrastructureId, capability);
      try { const grant = await grants.ensureGrant({ ...binding, grantId: "" }); refs.push({ ...binding, grantId: grant.grantId }); }
      catch { throw new Error("AUTHORITY_GRANT_UNAVAILABLE"); }
    }
    const current = this.store.connections.get(connectionId);
    if (!current || current.revision !== connection.revision || (current.status !== "REQUESTED" && current.status !== "REQUESTED_CHANGE")) throw new Error("CONNECTION_NOT_APPROVABLE");
    const at = now();
    if (current.status === "REQUESTED_CHANGE") current.approvedCapabilities = [...new Set([...current.approvedCapabilities, ...capabilities])];
    else current.approvedCapabilities = [...capabilities];
    current.pendingCapabilities = [];
    current.authorityGrantRefs = [...current.authorityGrantRefs.filter(item => current.approvedCapabilities.includes(item.capability)), ...refs];
    current.status = "ACTIVE";
    current.approvedAt = at;
    current.updatedAt = at;
    current.revision += 1;
    this.connectionAudit(current, "CONNECTION_APPROVED", correlationId, "APPROVED");
    this.connectionAudit(current, "CONNECTION_ACTIVATED", correlationId, "ACTIVE");
    for (const capability of capabilities) this.connectionAudit(current, "CAPABILITY_APPROVED", correlationId, "APPROVED", capability);
    return current;
  }
  async revokeConnection(owner: Actor, connectionId: ConnectionId, grants: { revokeGrant(input: { grantId: string }): Promise<void> }, correlationId = "revoke") {
    if (!owner.verified || !owner.ownerId) throw new Error("OWNER_REQUIRED");
    const connection = this.store.connections.get(connectionId);
    if (!connection) throw new Error("CONNECTION_NOT_FOUND");
    if (connection.ownerId !== owner.ownerId) throw new Error("OWNER_REQUIRED");
    if (connection.status === "REVOKED") return connection;
    if (connection.status !== "ACTIVE" && connection.status !== "REQUESTED" && connection.status !== "REQUESTED_CHANGE") throw new Error("CONNECTION_NOT_REVOCABLE");
    for (const ref of connection.authorityGrantRefs) await grants.revokeGrant({ grantId: ref.grantId });
    connection.status = "REVOKED";
    connection.revokedAt = now();
    connection.updatedAt = connection.revokedAt;
    connection.revision += 1;
    this.connectionAudit(connection, "CONNECTION_REVOKED", correlationId, "REVOKED");
    return connection;
  }
  async revokeCapabilities(owner: Actor, connectionId: ConnectionId, capabilities: Capability[], grants: { revokeGrant(input: { grantId: string }): Promise<void> }, correlationId = "revoke-capability") {
    if (!owner.verified || !owner.ownerId) throw new Error("OWNER_REQUIRED");
    const connection = this.store.connections.get(connectionId);
    if (!connection || connection.status !== "ACTIVE") throw new Error("CONNECTION_NOT_ACTIVE");
    if (connection.ownerId !== owner.ownerId) throw new Error("OWNER_REQUIRED");
    assertCapabilitySubset(capabilities, connection.approvedCapabilities);
    const removed = connection.authorityGrantRefs.filter(item => capabilities.includes(item.capability));
    for (const ref of removed) await grants.revokeGrant({ grantId: ref.grantId });
    connection.approvedCapabilities = connection.approvedCapabilities.filter(item => !capabilities.includes(item));
    connection.authorityGrantRefs = connection.authorityGrantRefs.filter(item => !capabilities.includes(item.capability));
    connection.updatedAt = now();
    connection.revision += 1;
    for (const capability of capabilities) this.connectionAudit(connection, "CAPABILITY_REVOKED", correlationId, "REVOKED", capability);
    return connection;
  }
  private ensurePersonalIdentity(infrastructureId: InfrastructureId) {
    const infra = this.store.infrastructures.get(infrastructureId);
    if (!infra || infra.type !== "PERSONAL") return;
    const existing = [...this.store.bindings.values()].find(item => item.infrastructureId === infrastructureId && item.namespace === "identity");
    if (existing) { if (existing.provider !== "TrustID") throw new Error("PROVIDER_CONFLICT"); return; }
    this.bind(infrastructureId, "identity", "TrustID", true, "SYSTEM_MANAGED");
  }
  async route(request: CapabilityRequest): Promise<CapabilityResult> {
    if (request.capability.startsWith("identity.")) this.ensurePersonalIdentity(request.infrastructureId);
    const infra = this.store.infrastructures.get(request.infrastructureId) ?? null;
    const app = this.store.applications.get(request.applicationId) ?? null;
    const namespace = request.capability.split(".")[0] as PrimitiveBinding["namespace"];
    const binding = [...this.store.bindings.values()].find(item => item.infrastructureId === request.infrastructureId && item.namespace === namespace) ?? null;
    const connection = [...this.store.connections.values()].find(item => item.infrastructureId === request.infrastructureId && item.applicationId === request.applicationId) ?? null;
    const outcome = await executeCapability({ request, infrastructure: infra, application: app, binding, connection, adapters: [...this.adapters.values()], authority: this.authority });
    this.store.audits.push(outcome.audit);
    return outcome.result;
  }
  portalReadModel(infrastructureId: InfrastructureId) {
    const infra = this.requiredInfrastructure(infrastructureId);
    const applications = infra.applicationIds.map(appId => this.store.applications.get(appId)).filter(Boolean).map(app => ({ id: app!.id, displayName: app!.displayName, status: app!.status, publicUrl: app!.publicUrl, adminUrl: app!.adminUrl, capabilities: app!.grantedCapabilities }));
    const namespaces: PrimitiveBinding["namespace"][] = ["identity", "communication", "data", "jobs", "distribution", "value", "intelligence"];
    return { apps: applications, infrastructure: { id: infra.id, ownerId: infra.ownerId, status: infra.status, capabilities: namespaces.map(namespace => { const binding = [...this.store.bindings.values()].find(item => item.infrastructureId === infra.id && item.namespace === namespace); return { namespace, state: !binding ? "NOT_PROVISIONED" : binding.configured ? "CONNECTED" : "NOT_CONNECTED", provider: binding?.provider, reference: binding?.reference }; }) } };
  }
  private connectionAudit(connection: PdiApplicationConnection, eventType: ConnectionAuditRecord["eventType"], correlationId: string, result: string, capability?: Capability) {
    this.store.connectionAudits.push({ eventType, correlationId, ownerId: connection.ownerId, infrastructureId: connection.infrastructureId, applicationId: connection.applicationId, connectionId: connection.id, capability, result, timestamp: now() });
  }
  private requiredInfrastructure(infrastructureId: InfrastructureId) { const record = this.store.infrastructures.get(infrastructureId); if (!record) throw new Error("UNKNOWN_INFRASTRUCTURE"); return record; }
  private relationship(from: string, to: string, type: Relationship["type"]) {
    const relation = { id: id<RelationshipId>("relationship"), from, to, type, createdAt: now() };
    this.store.relationships.set(relation.id, relation);
    for (const target of [from, to]) { const infra = this.store.infrastructures.get(target as InfrastructureId); if (infra) infra.relationshipIds.push(relation.id); }
  }
}
