/** Applications consume DDI; DDI consumes primitive capabilities. */
export type OpaqueId<T extends string> = string & { readonly __brand: T };
export type InfrastructureId = OpaqueId<"InfrastructureId">;
export type ApplicationId = OpaqueId<"ApplicationId">;
export type PrimitiveBindingId = OpaqueId<"PrimitiveBindingId">;
export type RelationshipId = OpaqueId<"RelationshipId">;
export type ConnectedPropertyId = OpaqueId<"ConnectedPropertyId">;
/** Canonical Digiconomy owner. DDI references this id; Digi Core allocates it. */
export type DigiOwnerId = OpaqueId<"DigiOwnerId">;
export type Capability = `${"identity" | "communication" | "data" | "jobs" | "distribution" | "value" | "intelligence"}.${string}`;
export type ExecutionMode = "APP" | "SPACE";
export type ResultStatus = "COMPLETED" | "DENIED" | "CAPABILITY_UNAVAILABLE" | "PROVIDER_UNAVAILABLE" | "AUTHENTICATION_REQUIRED" | "STEP_UP_REQUIRED" | "INVALID_REQUEST" | "FAILED";
export type InfrastructureStatus = "PROVISIONING" | "ACTIVE" | "SUSPENDED" | "ARCHIVED";
export type ApplicationStatus = "REGISTERED" | "PROVISIONING" | "ACTIVE" | "PAUSED" | "RETIRED";
export type ConnectedPropertyType = "PERSONAL_BRAND" | "BUSINESS" | "SPACE" | "APPLICATION";
/** PENDING_ACTIVATION: ownership verified, Portal install not yet READY. It carries no capability, application, or download privilege. */
export type ConnectedPropertyStatus = "PENDING_ACTIVATION" | "ACTIVE" | "SUSPENDED" | "REVOKED" | "FAILED";
export type InfrastructureType = "PERSONAL" | "CREATOR" | "BUSINESS";
export type Provider = "TrustID" | "ElfCom" | "DataZone" | "PlatformJobs" | "MasterDistributor" | "FundzMan" | "DigiAI";
export type Actor = { ownerId: DigiOwnerId; subject?: string; kind: "HUMAN" | "TWIN" | "SERVICE"; verified: boolean; authorityActor?: string };
export type AuthorityDecision = { ok: true; grantId?: string } | { ok: false; reason: "MISSING" | "EXPIRED" | "REVOKED" | "WRONG_ACTION" | "WRONG_RESOURCE" | "WRONG_AUDIENCE" | "INVALID" };

export type InfrastructureRecord = { id: InfrastructureId; ownerId: DigiOwnerId; type: InfrastructureType; status: InfrastructureStatus; applicationIds: ApplicationId[]; primitiveBindingIds: PrimitiveBindingId[]; relationshipIds: RelationshipId[]; createdAt: string; updatedAt: string; metadata: Record<string, string> };
export type ApplicationRecord = { id: ApplicationId; infrastructureId: InfrastructureId; propertyId?: ConnectedPropertyId; displayName: string; type: string; publicUrl?: string; adminUrl?: string; status: ApplicationStatus; requestedCapabilities: Capability[]; grantedCapabilities: Capability[]; createdAt: string; updatedAt: string };
/** A PDI-owned property. It is not an owner, identity, session, or Authority grant. */
export type ConnectedProperty = { id: ConnectedPropertyId; infrastructureId: InfrastructureId; ownerId: DigiOwnerId; type: ConnectedPropertyType; externalSystem: string; externalReference: string; displayName: string; status: ConnectedPropertyStatus; ownershipEvidence: string; createdAt: string; updatedAt: string; revokedAt?: string };
export type PrimitiveBinding = { id: PrimitiveBindingId; infrastructureId: InfrastructureId; namespace: Capability extends `${infer N}.${string}` ? N : never; provider: Provider; configured: boolean; reference?: string; management?: "SYSTEM_MANAGED" };
export type Relationship = { id: RelationshipId; from: string; to: string; type: "OWNER" | "APPLICATION" | "PRIMITIVE_BINDING" | "ACTOR" | "INFRASTRUCTURE"; createdAt: string };
export type CapabilityRequest = { infrastructureId: InfrastructureId; applicationId: ApplicationId; propertyId?: ConnectedPropertyId; capability: Capability; action: string; resource: string; audience: string; actor?: Actor; authority?: { token?: string; grantId?: string }; executionMode?: ExecutionMode; correlationId: string; connectionId?: ConnectionId; payload?: unknown };
export type CapabilityResult = { status: ResultStatus; correlationId: string; reason?: string; provider?: Provider; data?: unknown };
export type AuditRecord = { timestamp: string; correlationId: string; infrastructureId: InfrastructureId; applicationId: ApplicationId; propertyId?: ConnectedPropertyId; ownerId?: DigiOwnerId; actor?: string; audience: string; capability: Capability; action: string; resource: string; provider?: Provider; grantId?: string; connectionId?: string; decision: "ALLOW" | "DENY" | "UNAVAILABLE" | "FAILED" | "AUTHENTICATION"; reason?: string; executionMode: ExecutionMode; result: ResultStatus };
export type ConnectionId = OpaqueId<"ConnectionId">;
export type ConnectionStatus = "REQUESTED" | "ACTIVE" | "REVOKED" | "REQUESTED_CHANGE";
export type AuthorityGrantRef = { capability: Capability; grantId: string; actor: string; action: string; resource: string; audience: string };
export type PdiApplicationConnection = { id: ConnectionId; infrastructureId: InfrastructureId; applicationId: ApplicationId; ownerId: DigiOwnerId; status: ConnectionStatus; requestedCapabilities: Capability[]; approvedCapabilities: Capability[]; pendingCapabilities: Capability[]; authorityGrantRefs: AuthorityGrantRef[]; revision: number; createdAt: string; updatedAt: string; approvedAt?: string; revokedAt?: string };
export type ConnectionEventType = "PDI_CREATED" | "PROPERTY_CONNECTED" | "PROPERTY_REVOKED" | "PROPERTY_SUSPENDED" | "PROPERTY_REINSTATED" | "CONNECTION_REQUESTED" | "CONNECTION_APPROVED" | "CONNECTION_ACTIVATED" | "CONNECTION_REVOKED" | "CAPABILITY_REQUESTED" | "CAPABILITY_APPROVED" | "CAPABILITY_REVOKED" | "CONNECTION_RECONNECTED";
export type ConnectionAuditRecord = { eventType: ConnectionEventType; correlationId: string; ownerId?: DigiOwnerId; infrastructureId: InfrastructureId; propertyId?: ConnectedPropertyId; applicationId?: ApplicationId; connectionId?: ConnectionId; capability?: Capability; grantId?: string; result: string; reason?: string; timestamp: string };
export type PrimitiveAdapter = { namespace: PrimitiveBinding["namespace"]; provider: Provider; resolve(binding: PrimitiveBinding): Promise<{ ok: boolean; reason?: string }>; execute(request: CapabilityRequest): Promise<CapabilityResult>; health(): Promise<"CONNECTED" | "NOT_CONFIGURED" | "UNAVAILABLE"> };

/* D3B commercial activation. Commercial records are separate from identity and property ownership. */
export type ActivationCodeId = OpaqueId<"ActivationCodeId">;
export type EntitlementId = OpaqueId<"EntitlementId">;
export type LicenseId = OpaqueId<"LicenseId">;
export type RedemptionId = OpaqueId<"RedemptionId">;
export type LicenseType = "PERPETUAL" | "TERM";
export type CommercialStatus = "ACTIVE" | "SUSPENDED" | "EXPIRED" | "REVOKED";
/** Configured plan definition. DDI carries no prices; payment is confirmed manually before issuance. */
export type CommercialPlan = { productId: string; planId: string; edition: string; licenseType: LicenseType; termDays?: number; renewable: boolean; requiresProperty: boolean; propertyTypes: ConnectedPropertyType[]; downloads: string[] };
export type CommercialOperatorRole = "COMMERCIAL_ISSUER" | "COMMERCIAL_ADMIN";
export type ActivationCodeStatus = "ISSUED" | "REDEEMED" | "REVOKED";
/** Never contains the code or its hash. */
export type ActivationCodeRecord = { id: ActivationCodeId; productId: string; planId: string; plan: CommercialPlan; catalogVersion: string; paymentReference: string; issuedBy: DigiOwnerId; status: ActivationCodeStatus; createdAt: string; expiresAt: string; redeemedByOwnerId?: DigiOwnerId; redeemedAt?: string; redemptionId?: RedemptionId; revokedAt?: string };
export type Entitlement = { id: EntitlementId; ownerId: DigiOwnerId; infrastructureId: InfrastructureId; productId: string; planId: string; edition: string; licenseType: LicenseType; propertyId?: ConnectedPropertyId; status: CommercialStatus; activatedAt: string; expiresAt?: string; renewable: boolean; downloads: string[]; sourceCodeId: ActivationCodeId; statusReason?: string; createdAt: string; updatedAt: string };
export type License = { id: LicenseId; entitlementId: EntitlementId; ownerId: DigiOwnerId; infrastructureId: InfrastructureId; productId: string; planId: string; propertyId?: ConnectedPropertyId; status: CommercialStatus; issuedAt: string; expiresAt?: string; restrictions: { propertyBound: boolean }; revision: number; statusReason?: string; createdAt: string; updatedAt: string };
export type RedemptionStatus = "PROVISIONING_PENDING" | "COMPLETED" | "ATTENTION_REQUIRED" | "CANCELLED";
export type Redemption = { id: RedemptionId; codeId: ActivationCodeId; ownerId: DigiOwnerId; infrastructureId: InfrastructureId; propertyId?: ConnectedPropertyId; entitlementId: EntitlementId; licenseId: LicenseId; status: RedemptionStatus; provisioningReference?: string; provisionedAt?: string; activatedAt?: string; lastError?: string; createdAt: string; updatedAt: string };
export type LicenseVerification = { valid: true; license: License; entitlement: Entitlement } | { valid: false; reason: "LICENSE_NOT_FOUND" | "LICENSE_REVOKED" | "LICENSE_SUSPENDED" | "LICENSE_EXPIRED" | "PRODUCT_MISMATCH" | "PROPERTY_MISMATCH" | "PROPERTY_NOT_ACTIVE" };
export type CommercialEventType = "OPERATOR_GRANTED" | "OPERATOR_REVOKED" | "ACTIVATION_CODE_ISSUED" | "ACTIVATION_CODE_REVOKED" | "REDEMPTION_ATTEMPTED" | "REDEMPTION_SUCCEEDED" | "REDEMPTION_FAILED" | "ENTITLEMENT_CREATED" | "LICENSE_ISSUED" | "PROVISIONING_REQUESTED" | "PROVISIONING_SUCCEEDED" | "PROVISIONING_FAILED" | "PROPERTY_ACTIVATED" | "PROPERTY_ACTIVATION_FAILED" | "DOWNLOAD_AUTHORIZED" | "DOWNLOAD_DENIED" | "DOWNLOAD_REDEEMED" | "LICENSE_SUSPENDED" | "LICENSE_REINSTATED" | "LICENSE_REVOKED" | "LICENSE_EXPIRED" | "ENTITLEMENT_SUSPENDED" | "ENTITLEMENT_REINSTATED" | "ENTITLEMENT_REVOKED" | "OUTBOX_REQUEUED";
/** Audit never stores activation codes, hashes, download tokens, or bearer sessions. */
export type CommercialAuditRecord = { eventType: CommercialEventType; correlationId: string; actor?: string; ownerId?: DigiOwnerId; codeId?: ActivationCodeId; entitlementId?: EntitlementId; licenseId?: LicenseId; propertyId?: ConnectedPropertyId; redemptionId?: RedemptionId; productId?: string; result: string; reason?: string; timestamp: string };
