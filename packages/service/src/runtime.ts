import type { Actor, Capability, CapabilityRequest, CapabilityResult, InfrastructureType, PrimitiveBinding } from "../../contracts/src/index.ts";
import { ElfComAdapter, TrustIdAdapter, UnavailableAdapter, executeCapability, type AuthorityVerifier, type PrimitiveAdapter } from "../../core/src/index.ts";
import type { DigiAuthorityClient, DigiSessionClient } from "./digi.ts";
import type { AuthorityGrantPort, DdiRepository } from "./repository.ts";

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
  constructor(repository: DdiRepository, authority: AuthorityVerifier, adapters: Map<string, PrimitiveAdapter>, sessions?: DigiSessionClient, grants?: AuthorityGrantPort) {
    this.repository = repository;
    this.authority = authority;
    this.adapters = adapters;
    this.sessions = sessions;
    this.grants = grants;
  }
  async authenticate(token: string): Promise<Actor | null> {
    const session = await this.sessions?.resolve(token);
    if (!session) return null;
    return { ownerId: session.ownerId, subject: session.subject, kind: "HUMAN", verified: true };
  }
  authenticateApplication(secret: string) { return this.repository.findApplicationByCredential(secret); }
  findPersonal(actor: Actor) { if (!actor.verified || !actor.ownerId) throw new Error("OWNER_REQUIRED"); return this.repository.findPersonal(actor.ownerId, actor.subject); }
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
      const namespace = request.capability.split(".")[0] as PrimitiveBinding["namespace"];
      const binding = await this.repository.findBinding(request.infrastructureId, namespace);
      const connection = connections.find(item => item.applicationId === request.applicationId) ?? null;
      const outcome = await executeCapability({ request, infrastructure, application, binding, connection, adapters: [...this.adapters.values()], authority: this.authority });
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
    const snapshot = await this.repository.snapshot();
    return {
      apps: snapshot.applications.filter(app => app.infrastructureId === infra.id).map(app => ({ id: app.id, name: app.displayName, status: app.status, publicUrl: app.publicUrl, adminUrl: app.adminUrl, capabilities: app.grantedCapabilities })),
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
