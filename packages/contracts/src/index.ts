/** Applications consume DDI; DDI consumes primitive capabilities. */
export type OpaqueId<T extends string> = string & { readonly __brand: T };
export type InfrastructureId = OpaqueId<"InfrastructureId">;
export type ApplicationId = OpaqueId<"ApplicationId">;
export type PrimitiveBindingId = OpaqueId<"PrimitiveBindingId">;
export type RelationshipId = OpaqueId<"RelationshipId">;
/** Canonical Digiconomy owner. DDI references this id; Digi Core allocates it. */
export type DigiOwnerId = OpaqueId<"DigiOwnerId">;
export type Capability = `${"identity" | "communication" | "data" | "jobs" | "distribution" | "value" | "intelligence"}.${string}`;
export type ExecutionMode = "APP" | "SPACE";
export type ResultStatus = "COMPLETED" | "DENIED" | "CAPABILITY_UNAVAILABLE" | "PROVIDER_UNAVAILABLE" | "AUTHENTICATION_REQUIRED" | "STEP_UP_REQUIRED" | "INVALID_REQUEST" | "FAILED";
export type InfrastructureStatus = "PROVISIONING" | "ACTIVE" | "SUSPENDED" | "ARCHIVED";
export type ApplicationStatus = "REGISTERED" | "PROVISIONING" | "ACTIVE" | "PAUSED" | "RETIRED";
export type InfrastructureType = "PERSONAL" | "CREATOR" | "BUSINESS";
export type Provider = "TrustID" | "ElfCom" | "DataZone" | "PlatformJobs" | "MasterDistributor" | "FundzMan" | "DigiAI";
export type Actor = { ownerId: DigiOwnerId; subject?: string; kind: "HUMAN" | "TWIN" | "SERVICE"; verified: boolean; authorityActor?: string };
export type AuthorityDecision = { ok: true; grantId?: string } | { ok: false; reason: "MISSING" | "EXPIRED" | "REVOKED" | "WRONG_ACTION" | "WRONG_RESOURCE" | "WRONG_AUDIENCE" | "INVALID" };

export type InfrastructureRecord = { id: InfrastructureId; ownerId: DigiOwnerId; type: InfrastructureType; status: InfrastructureStatus; applicationIds: ApplicationId[]; primitiveBindingIds: PrimitiveBindingId[]; relationshipIds: RelationshipId[]; createdAt: string; updatedAt: string; metadata: Record<string, string> };
export type ApplicationRecord = { id: ApplicationId; infrastructureId: InfrastructureId; displayName: string; type: string; publicUrl?: string; adminUrl?: string; status: ApplicationStatus; requestedCapabilities: Capability[]; grantedCapabilities: Capability[]; createdAt: string; updatedAt: string };
export type PrimitiveBinding = { id: PrimitiveBindingId; infrastructureId: InfrastructureId; namespace: Capability extends `${infer N}.${string}` ? N : never; provider: Provider; configured: boolean; reference?: string; management?: "SYSTEM_MANAGED" };
export type Relationship = { id: RelationshipId; from: string; to: string; type: "OWNER" | "APPLICATION" | "PRIMITIVE_BINDING" | "ACTOR" | "INFRASTRUCTURE"; createdAt: string };
export type CapabilityRequest = { infrastructureId: InfrastructureId; applicationId: ApplicationId; capability: Capability; action: string; resource: string; audience: string; actor?: Actor; authority?: { token?: string; grantId?: string }; executionMode?: ExecutionMode; correlationId: string; connectionId?: ConnectionId; payload?: unknown };
export type CapabilityResult = { status: ResultStatus; correlationId: string; reason?: string; provider?: Provider; data?: unknown };
export type AuditRecord = { timestamp: string; correlationId: string; infrastructureId: InfrastructureId; applicationId: ApplicationId; ownerId?: DigiOwnerId; actor?: string; audience: string; capability: Capability; action: string; resource: string; provider?: Provider; grantId?: string; connectionId?: string; decision: "ALLOW" | "DENY" | "UNAVAILABLE" | "FAILED" | "AUTHENTICATION"; reason?: string; executionMode: ExecutionMode; result: ResultStatus };
export type ConnectionId = OpaqueId<"ConnectionId">;
export type ConnectionStatus = "REQUESTED" | "ACTIVE" | "REVOKED" | "REQUESTED_CHANGE";
export type AuthorityGrantRef = { capability: Capability; grantId: string; actor: string; action: string; resource: string; audience: string };
export type PdiApplicationConnection = { id: ConnectionId; infrastructureId: InfrastructureId; applicationId: ApplicationId; ownerId: DigiOwnerId; status: ConnectionStatus; requestedCapabilities: Capability[]; approvedCapabilities: Capability[]; pendingCapabilities: Capability[]; authorityGrantRefs: AuthorityGrantRef[]; revision: number; createdAt: string; updatedAt: string; approvedAt?: string; revokedAt?: string };
export type ConnectionEventType = "PDI_CREATED" | "CONNECTION_REQUESTED" | "CONNECTION_APPROVED" | "CONNECTION_ACTIVATED" | "CONNECTION_REVOKED" | "CAPABILITY_REQUESTED" | "CAPABILITY_APPROVED" | "CAPABILITY_REVOKED" | "CONNECTION_RECONNECTED";
export type ConnectionAuditRecord = { eventType: ConnectionEventType; correlationId: string; ownerId?: DigiOwnerId; infrastructureId: InfrastructureId; applicationId?: ApplicationId; connectionId?: ConnectionId; capability?: Capability; grantId?: string; result: string; reason?: string; timestamp: string };
export type PrimitiveAdapter = { namespace: PrimitiveBinding["namespace"]; provider: Provider; resolve(binding: PrimitiveBinding): Promise<{ ok: boolean; reason?: string }>; execute(request: CapabilityRequest): Promise<CapabilityResult>; health(): Promise<"CONNECTED" | "NOT_CONFIGURED" | "UNAVAILABLE"> };
