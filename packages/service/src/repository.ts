import type { ApplicationRecord, AuditRecord, Capability, ConnectionAuditRecord, InfrastructureId, InfrastructureRecord, InfrastructureType, PdiApplicationConnection, PrimitiveBinding, Relationship } from "../../contracts/src/index.ts";
import type { PersistentState } from "./store.ts";

export type AuthorityGrantPort = {
  ensureGrant(input: { ownerId: string; actor: string; action: string; resource: string; audience: string; sessionToken?: string }): Promise<{ grantId: string }>;
  revokeGrant(input: { ownerId: string; grantId: string; sessionToken?: string }): Promise<void>;
};
export type RegisteredApplication = ApplicationRecord & { applicationCredential?: string };

export type ProvisionInput = { type: InfrastructureType; metadata?: Record<string, string>; idempotencyKey: string };
export type RegisterAppInput = { type: string; displayName: string; publicUrl?: string; adminUrl?: string; capabilities: Capability[]; idempotencyKey: string };

export interface DdiRepository {
  provision(ownerId: InfrastructureRecord["ownerId"], input: ProvisionInput): Promise<InfrastructureRecord>;
  registerApplication(ownerId: InfrastructureRecord["ownerId"], infrastructureId: string, input: RegisterAppInput): Promise<RegisteredApplication>;
  findPersonal(ownerId: InfrastructureRecord["ownerId"]): Promise<InfrastructureRecord | null>;
  findApplicationByCredential(secret: string): Promise<ApplicationRecord | null>;
  requestConnection(applicationId: string, capabilities: Capability[], correlationId: string, idempotencyKey: string): Promise<PdiApplicationConnection>;
  requestCapabilityChange(applicationId: string, capabilities: Capability[], correlationId: string): Promise<PdiApplicationConnection>;
  approveConnection(ownerId: InfrastructureRecord["ownerId"], connectionId: string, capabilities: Capability[], correlationId: string, grants: AuthorityGrantPort, sessionToken?: string): Promise<PdiApplicationConnection>;
  revokeConnection(ownerId: InfrastructureRecord["ownerId"], connectionId: string, correlationId: string, grants: AuthorityGrantPort, sessionToken?: string): Promise<PdiApplicationConnection>;
  revokeCapabilities(ownerId: InfrastructureRecord["ownerId"], connectionId: string, capabilities: Capability[], correlationId: string, grants: AuthorityGrantPort, sessionToken?: string): Promise<PdiApplicationConnection>;
  getConnection(id: string): Promise<PdiApplicationConnection | null>;
  listConnections(infrastructureId: string): Promise<PdiApplicationConnection[]>;
  connectionAudits(): Promise<ConnectionAuditRecord[]>;
  grantCapabilities(ownerId: InfrastructureRecord["ownerId"], infrastructureId: string, applicationId: string, capabilities: Capability[]): Promise<ApplicationRecord>;
  bind(ownerId: InfrastructureRecord["ownerId"], infrastructureId: string, namespace: PrimitiveBinding["namespace"], provider: PrimitiveBinding["provider"], reference?: string): Promise<PrimitiveBinding>;
  getInfrastructure(id: string): Promise<InfrastructureRecord | null>;
  getApplication(id: string): Promise<ApplicationRecord | null>;
  findBinding(infrastructureId: string, namespace: PrimitiveBinding["namespace"]): Promise<PrimitiveBinding | null>;
  insertAudit(audit: AuditRecord): Promise<void>;
  snapshot(): Promise<PersistentState>;
  relationshipsFor(infrastructureId: string): Promise<Relationship[]>;
}
