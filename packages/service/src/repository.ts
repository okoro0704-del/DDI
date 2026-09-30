import type { ApplicationRecord, AuditRecord, Capability, InfrastructureId, InfrastructureRecord, InfrastructureType, PrimitiveBinding, Relationship } from "../../contracts/src/index.ts";
import type { PersistentState } from "./store.ts";

export type ProvisionInput = { type: InfrastructureType; metadata?: Record<string, string>; idempotencyKey: string };
export type RegisterAppInput = { type: string; displayName: string; publicUrl?: string; adminUrl?: string; capabilities: Capability[]; idempotencyKey: string };

export interface DdiRepository {
  provision(ownerId: InfrastructureRecord["ownerId"], input: ProvisionInput): Promise<InfrastructureRecord>;
  registerApplication(ownerId: InfrastructureRecord["ownerId"], infrastructureId: string, input: RegisterAppInput): Promise<ApplicationRecord>;
  grantCapabilities(ownerId: InfrastructureRecord["ownerId"], infrastructureId: string, applicationId: string, capabilities: Capability[]): Promise<ApplicationRecord>;
  bind(ownerId: InfrastructureRecord["ownerId"], infrastructureId: string, namespace: PrimitiveBinding["namespace"], provider: PrimitiveBinding["provider"], reference?: string): Promise<PrimitiveBinding>;
  getInfrastructure(id: string): Promise<InfrastructureRecord | null>;
  getApplication(id: string): Promise<ApplicationRecord | null>;
  findBinding(infrastructureId: string, namespace: PrimitiveBinding["namespace"]): Promise<PrimitiveBinding | null>;
  insertAudit(audit: AuditRecord): Promise<void>;
  snapshot(): Promise<PersistentState>;
  relationshipsFor(infrastructureId: string): Promise<Relationship[]>;
}
