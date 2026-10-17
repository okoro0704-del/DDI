import type { Actor, Capability, CapabilityRequest, CapabilityResult, ConnectedPropertyType, InfrastructureType, PrimitiveBinding } from "../../contracts/src/index.ts";
import { ElfComAdapter, TrustIdAdapter, UnavailableAdapter, executeCapability, toAudit, type AuthorityVerifier, type PrimitiveAdapter } from "../../core/src/index.ts";
import type { DigiAuthorityClient, DigiSessionClient } from "./digi.ts";
import type { AuthorityGrantPort, DdiRepository } from "./repository.ts";
import { ownershipReceipt, type OwnershipVerifier } from "./ownership.ts";

export function authorityVerifier(client: DigiAuthorityClient): AuthorityVerifier {
  return async ({ request }) => {
    const token = request.authority?.token;
    const actor = request.actor?.authorityActor;
    if (!token || !actor || !request.actor?.ownerId) return { ok: false, reason: "MISSING" };
    return client.consume({ token, audience: request.audience, actor, action: request.action, resource: request.resource, ownerId: request.actor.ownerId });
  };
}

export function defaultAdapters(verify: (assertion: string) => Promise<{ subject?: string } | null>, elfcom: { baseUrl?: string; serviceToken?: string } = {}): Map<string, PrimitiveAdapter> {
  const adapters = new Map<string, PrimitiveAdapter>();
  adapters.set("identity", new TrustIdAdapter(verify));
  adapters.set("communication", new ElfComAdapter({ baseUrl: elfcom.baseUrl ?? process.env.ELFCOM_BASE_URL, serviceToken: elfcom.serviceToken ?? process.env.ELFCOM_PDI_SERVICE_TOKEN }));
  for (const [namespace, provider] of [["data", "DataZone"], ["jobs", "PlatformJobs"], ["distribution", "MasterDistributor"], ["value", "FundzMan"], ["intelligence", "DigiAI"]] as const) adapters.set(namespace, new UnavailableAdapter(namespace, provider));
  return adapters;
}

/** One durable execution pipeline. JSON storage is not accepted here. */
export class DurableDdiService {
  private repository: DdiRepository;
  private authority: AuthorityVerifier;
  private adapters: Map<string, PrimitiveAdapter>;
  private sessions: DigiSessionClient | undefined;
  private grants: AuthorityGrantPort | undefined;
  private ownership: OwnershipVerifier | undefined;
  constructor(repository: DdiRepository, authority: AuthorityVerifier, adapters: Map<string, PrimitiveAdapter>, sessions?: DigiSessionClient, grants?: AuthorityGrantPort, ownership?: OwnershipVerifier) {
    this.repository = repository;
    this.authority = authority;
    this.adapters = adapters;
    this.sessions = sessions;
    this.grants = grants;
    this.ownership = ownership;
  }
  async authenticate(token: string): Promise<Actor | null> {
    const session = await this.sessions?.resolve(token);
    if (!session) return null;
    return { ownerId: session.ownerId, subject: session.subject, kind: "HUMAN", verified: true };
  }
  authenticateApplication(secret: string) { return this.repository.findApplicationByCredential(secret); }
  findPersonal(actor: Actor) { if (!actor.verified || !actor.ownerId) throw new Error("OWNER_REQUIRED"); return this.repository.findPersonal(actor.ownerId, actor.subject); }
  async provisionProperty(actor: Actor, input: { type: ConnectedPropertyType; externalSystem: string; externalReference: string; displayName: string; idempotencyKey: string }) {
    if (!actor.verified || !actor.ownerId || !actor.subject) throw new Error("OWNER_REQUIRED");
    if (!this.ownership) throw new Error("OWNERSHIP_VERIFICATION_UNAVAILABLE");
    const verification = await this.ownership.verify({ trustIdSubject: actor.subject, externalSystem: input.externalSystem, externalReference: input.externalReference, type: input.type });
    return this.repository.provisionProperty(actor.ownerId, { ...input, ownershipEvidence: ownershipReceipt(verification) });
  }
  getProperty(id: string) { return this.repository.getProperty(id); }
  listProperties(infrastructureId: string) { return this.repository.listProperties(infrastructureId); }
  async revokeProperty(actor: Actor, id: string, correlationId: string, sessionToken?: string) {
    if (!actor.verified || !actor.ownerId) throw new Error("OWNER_REQUIRED");
    // Persist the property lifecycle denial first.  This is the fail-closed
    // boundary if the Authority endpoint is temporarily unavailable.
    const property = await this.repository.revokeProperty(actor.ownerId, id, correlationId);
    const connections = await this.repository.listConnectionsForProperty(id);
    if (!connections.length) return property;
    if (!this.grants) throw new Error("PROPERTY_GRANT_REVOCATION_PENDING");
    for (const connection of connections) {
      if (connection.status === "REVOKED") continue;
      try {
        // Digi Authority exposes individual grant revocation only.  DDI owns
        // these recorded references, so it can invalidate them without an
        // invented bulk-revocation API.
        await this.repository.revokeConnection(actor.ownerId, connection.id, `${correlationId}:${connection.id}`, this.grants, sessionToken);
      } catch {
        throw new Error("PROPERTY_GRANT_REVOCATION_PENDING");
      }
    }
    return property;
  }
  requestConnection(applicationId: string, capabilities: Capability[], correlationId: string, idempotencyKey: string) { return this.repository.requestConnection(applicationId, capabilities, correlationId, idempotencyKey); }
  requestCapabilityChange(applicationId: string, capabilities: Capability[], correlationId: string) { return this.repository.requestCapabilityChange(applicationId, capabilities, correlationId); }
  approveConnection(actor: Actor, connectionId: string, capabilities: Capability[], correlationId: string, sessionToken?: string) {
    if (!actor.verified || !actor.ownerId) throw new Error("OWNER_REQUIRED");
    if (!this.grants) throw new Error("AUTHORITY_GRANT_UNAVAILABLE");
    return this.repository.approveConnection(actor.ownerId, connectionId, capabilities, correlationId, this.grants, sessionToken);
  }
  revokeConnection(actor: Actor, connectionId: string, correlationId: string, sessionToken?: string) {
    if (!actor.verified || !actor.ownerId) throw new Error("OWNER_REQUIRED");
    if (!this.grants) throw new Error("AUTHORITY_GRANT_UNAVAILABLE");
    return this.repository.revokeConnection(actor.ownerId, connectionId, correlationId, this.grants, sessionToken);
  }
  revokeCapabilities(actor: Actor, connectionId: string, capabilities: Capability[], correlationId: string, sessionToken?: string) {
    if (!actor.verified || !actor.ownerId) throw new Error("OWNER_REQUIRED");
    if (!this.grants) throw new Error("AUTHORITY_GRANT_UNAVAILABLE");
    return this.repository.revokeCapabilities(actor.ownerId, connectionId, capabilities, correlationId, this.grants, sessionToken);
  }
  getConnection(id: string) { return this.repository.getConnection(id); }
  listConnections(infrastructureId: string) { return this.repository.listConnections(infrastructureId); }
  provision(actor: Actor, input: { type: InfrastructureType; metadata?: Record<string, string>; idempotencyKey: string }) {
    if (!actor.verified || !actor.ownerId || !input.idempotencyKey) throw new Error("AUTHENTICATED_ACTOR_AND_IDEMPOTENCY_REQUIRED");
    const metadata = { ...(input.metadata ?? {}) };
    delete metadata.ownerTrustId;
    delete metadata.accountRef;
    return this.repository.provision(actor.ownerId, { type: input.type, metadata, idempotencyKey: input.idempotencyKey, ownerTrustId: actor.subject });
  }
  registerApp(actor: Actor, infrastructureId: string, input: { type: string; displayName: string; publicUrl?: string; adminUrl?: string; capabilities: Capability[]; idempotencyKey: string }) {
    if (!actor.verified || !actor.ownerId) throw new Error("OWNER_REQUIRED");
    return this.repository.registerApplication(actor.ownerId, infrastructureId, input);
  }
  grantCapabilities(actor: Actor, infrastructureId: string, applicationId: string, capabilities: Capability[]) {
    if (!actor.verified || !actor.ownerId) throw new Error("OWNER_REQUIRED");
    return this.repository.grantCapabilities(actor.ownerId, infrastructureId, applicationId, capabilities);
  }
  bind(actor: Actor, infrastructureId: string, namespace: PrimitiveBinding["namespace"], provider: PrimitiveBinding["provider"], reference?: string) {
    if (!actor.verified || !actor.ownerId) throw new Error("OWNER_REQUIRED");
    return this.repository.bind(actor.ownerId, infrastructureId, namespace, provider, reference);
  }
  getInfrastructure(id: string) { return this.repository.getInfrastructure(id); }
  async execute(request: CapabilityRequest): Promise<CapabilityResult> {
    try {
      if (request.capability.startsWith("identity.")) await this.repository.ensurePersonalIdentity(request.infrastructureId);
      if (request.capability.startsWith("communication.")) await this.repository.ensurePersonalCommunication(request.infrastructureId);
      const [infrastructure, application, connections] = await Promise.all([this.repository.getInfrastructure(request.infrastructureId), this.repository.getApplication(request.applicationId), this.repository.listConnections(request.infrastructureId)]);
      const property = application?.propertyId ? await this.repository.getProperty(application.propertyId) : null;
      request.propertyId = application?.propertyId;
      if (application?.propertyId && (!property || property.status !== "ACTIVE")) {
        const result: CapabilityResult = { status: "DENIED", correlationId: request.correlationId, reason: "PROPERTY_NOT_ACTIVE" };
        await this.repository.insertAudit(toAudit(request, result));
        return result;
      }
      const namespace = request.capability.split(".")[0] as PrimitiveBinding["namespace"];
      const binding = await this.repository.findBinding(request.infrastructureId, namespace);
      const connection = connections.find(item => item.applicationId === request.applicationId) ?? null;
      const outcome = await executeCapability({ request, infrastructure, application, binding, connection, adapters: [...this.adapters.values()], authority: this.authority });
      // A revocation that completes while a read is in flight must win over a
      // cached positive Authority decision.  Mutating primitives require their
      // own atomic provider contract before they can be enabled here.
      if (application?.propertyId && outcome.result.status === "COMPLETED") {
        const current = await this.repository.getProperty(application.propertyId);
        if (!current || current.status !== "ACTIVE") {
          const result: CapabilityResult = { status: "DENIED", correlationId: request.correlationId, reason: "PROPERTY_NOT_ACTIVE" };
          await this.repository.insertAudit(toAudit(request, result));
          return result;
        }
      }
      try { await this.repository.insertAudit(outcome.audit); }
      catch { return { status: "FAILED", correlationId: request.correlationId, reason: "AUDIT_UNAVAILABLE" }; }
      return outcome.result;
    } catch {
      return { status: "FAILED", correlationId: request.correlationId, reason: "STORAGE_UNAVAILABLE" };
    }
  }
  async view(infrastructureId: string) {
    const infra = await this.repository.getInfrastructure(infrastructureId);
    if (!infra) throw new Error("UNKNOWN_INFRASTRUCTURE");
    const names = ["identity", "communication", "data", "jobs", "distribution", "value", "intelligence"] as const;
    const bindings = await Promise.all(names.map(namespace => this.repository.findBinding(infra.id, namespace)));
    const [snapshot, properties, connections] = await Promise.all([this.repository.snapshot(), this.repository.listProperties(infra.id), this.repository.listConnections(infra.id)]);
    return {
      apps: snapshot.applications.filter(app => app.infrastructureId === infra.id).map(app => ({ id: app.id, propertyId: app.propertyId, name: app.displayName, status: app.status, publicUrl: app.publicUrl, adminUrl: app.adminUrl, capabilities: app.grantedCapabilities })),
      properties,
      connections,
      infrastructure: {
        id: infra.id,
        ownerId: infra.ownerId,
        status: infra.status,
        capabilities: Object.fromEntries(names.map((namespace, index) => {
          const binding = bindings[index];
          return [namespace, { status: binding?.configured ? "CONNECTED" : binding ? "NOT_CONNECTED" : "NOT_PROVISIONED", provider: binding?.provider }];
        })),
      },
    };
  }
  snapshot() { return this.repository.snapshot(); }
}
