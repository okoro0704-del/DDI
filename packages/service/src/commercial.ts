import { randomUUID } from "node:crypto";
import type { Actor, CommercialOperatorRole, ConnectedPropertyType, DigiOwnerId, License, LicenseVerification, Redemption } from "../../contracts/src/index.ts";
import { MIN_PEPPER_LENGTH, generateActivationCode, generateDownloadToken, hashActivationSecret, hashDownloadToken, parseActivationCode, sameDigest } from "./activation-code.ts";
import { resolvePlan, type CommercialCatalog } from "./commercial-catalog.ts";
import type { LifecycleAction, OutboxJob, PostgresCommercialRepository } from "./commercial-repository.ts";
import { ownershipReceipt, type OwnershipVerifier } from "./ownership.ts";
import type { DdiRepository } from "./repository.ts";

/**
 * Cross-service provisioning port (Portal / Master Distributor). It must be
 * idempotent by idempotencyKey. Throw PROVISIONING_UNAVAILABLE to retry and
 * PROVISIONING_REJECTED for a terminal refusal. It conveys commercial
 * authorization only; it never grants a DDI capability.
 */
export type ProvisioningRequest = { idempotencyKey: string; redemptionId: string; ownerId: string; infrastructureId: string; propertyId?: string; externalSystem?: string; externalReference?: string; productId: string; planId: string; entitlementId: string; licenseId: string; ownerSubject?: string };
export type CommercialProvisioner = { provision(input: ProvisioningRequest): Promise<{ reference: string }> };

/** No verified provisioning endpoint exists yet. Jobs remain durably pending rather than reporting success. */
export class UnavailableCommercialProvisioner implements CommercialProvisioner {
  async provision(): Promise<{ reference: string }> { throw new Error("PROVISIONING_UNAVAILABLE"); }
}

export type RedeemPropertyInput = { type: ConnectedPropertyType; externalSystem: string; externalReference: string; displayName: string };

export type CommercialServiceOptions = {
  repository: PostgresCommercialRepository;
  pdi: Pick<DdiRepository, "provision" | "findPersonal">;
  ownership?: OwnershipVerifier;
  provisioner: CommercialProvisioner;
  catalog: CommercialCatalog;
  pepper: string;
  clock?: () => Date;
  downloadTtlSeconds?: number;
  failedAttemptLimit?: number;
  outbox?: { maxAttempts?: number; baseDelayMs?: number; maxDelayMs?: number; leaseMs?: number };
};

const PROPERTY_TYPES: ConnectedPropertyType[] = ["PERSONAL_BRAND", "BUSINESS", "SPACE", "APPLICATION"];
const FAILURE_WINDOW_MS = 15 * 60_000;
const code = (error: unknown) => {
  const message = error instanceof Error ? error.message : "";
  return /^[A-Z0-9_]+$/.test(message) ? message : "UNAVAILABLE";
};
const text = (value: unknown, max: number) => typeof value === "string" && value.trim().length > 0 && value.length <= max && !/[\u0000-\u001f]/.test(value) ? value : null;

export class CommercialService {
  private options: CommercialServiceOptions;
  private repository: PostgresCommercialRepository;
  constructor(options: CommercialServiceOptions) {
    if (!options.pepper || options.pepper.length < MIN_PEPPER_LENGTH) throw new Error("COMMERCIAL_CONFIGURATION_INVALID");
    this.options = options;
    this.repository = options.repository;
  }

  private now() { return this.options.clock?.() ?? new Date(); }
  private owner(actor: Actor | null | undefined): DigiOwnerId {
    if (!actor?.verified || !actor.ownerId) throw new Error("OWNER_REQUIRED");
    return actor.ownerId;
  }

  /** Real authorization: a verified Digi session plus an ACTIVE server-side role binding. Request headers carry no role. */
  async requireOperator(actor: Actor | null | undefined, roles: CommercialOperatorRole[]) {
    const ownerId = this.owner(actor);
    const role = await this.repository.operatorRole(ownerId);
    if (!role || !roles.includes(role)) throw new Error("OPERATOR_REQUIRED");
    return { ownerId, role };
  }

  async issueCode(actor: Actor | null | undefined, input: { productId: unknown; planId: unknown; paymentReference: unknown; expiresInHours: unknown; idempotencyKey: string }, correlationId: string) {
    const operator = await this.requireOperator(actor, ["COMMERCIAL_ISSUER", "COMMERCIAL_ADMIN"]);
    const idempotencyKey = text(input.idempotencyKey, 200);
    const paymentReference = text(input.paymentReference, 200);
    const hours = input.expiresInHours;
    if (!idempotencyKey) throw new Error("IDEMPOTENCY_KEY_REQUIRED");
    if (!paymentReference || typeof input.productId !== "string" || typeof input.planId !== "string" || !Number.isInteger(hours) || (hours as number) < 1 || (hours as number) > 2160) throw new Error("INVALID_REQUEST");
    const plan = resolvePlan(this.options.catalog, input.productId, input.planId);
    if (!plan) throw new Error("PLAN_NOT_FOUND");
    const at = this.now();
    for (let attempt = 0; attempt < 5; attempt++) {
      const generated = generateActivationCode();
      try {
        const result = await this.repository.insertCode({ lookupId: generated.lookupId, secretHash: hashActivationSecret(this.options.pepper, generated.lookupId, generated.secret), plan, catalogVersion: this.options.catalog.version, paymentReference, issuedBy: operator.ownerId, idempotencyKey, at, expiresAt: new Date(at.getTime() + (hours as number) * 3_600_000), correlationId });
        // The plaintext code exists only in this response. A replay cannot recover it.
        return { activationCode: result.record, code: result.created ? generated.code : undefined, created: result.created };
      } catch (error) {
        if (code(error) !== "ACTIVATION_LOOKUP_COLLISION") throw error;
      }
    }
    throw new Error("UNAVAILABLE");
  }

  async revokeCode(actor: Actor | null | undefined, id: string, correlationId: string) {
    const operator = await this.requireOperator(actor, ["COMMERCIAL_ADMIN"]);
    return this.repository.revokeCode(id, operator.ownerId, this.now(), correlationId);
  }
  async getCode(actor: Actor | null | undefined, id: string) {
    await this.requireOperator(actor, ["COMMERCIAL_ISSUER", "COMMERCIAL_ADMIN"]);
    const record = await this.repository.getCode(id);
    if (!record) throw new Error("ACTIVATION_CODE_NOT_FOUND");
    return record;
  }

  /**
   * Requires an authenticated owner. The code authorizes a purchase; it never
   * identifies the redeemer. Ownership is verified against the Portal before
   * the code is consumed, so a failed verification leaves the code ISSUED.
   */
  async redeem(actor: Actor | null | undefined, input: { code: unknown; idempotencyKey: string; property?: Partial<RedeemPropertyInput> }, correlationId: string): Promise<{ redemption: Redemption; replayed: boolean }> {
    const ownerId = this.owner(actor);
    const at = this.now();
    let codeId: string | undefined;
    const fail = async (reason: string): Promise<never> => {
      await this.repository.audit({ eventType: "REDEMPTION_FAILED", correlationId, actor: `owner:${ownerId}`, ownerId, codeId: codeId as never, result: "DENIED", reason, timestamp: at.toISOString() }).catch(() => undefined);
      throw new Error(reason);
    };
    await this.repository.audit({ eventType: "REDEMPTION_ATTEMPTED", correlationId, actor: `owner:${ownerId}`, ownerId, result: "ATTEMPTED", timestamp: at.toISOString() });
    const idempotencyKey = text(input.idempotencyKey, 200);
    if (!idempotencyKey) return fail("IDEMPOTENCY_KEY_REQUIRED");
    if (await this.repository.recentFailedRedemptions(ownerId, new Date(at.getTime() - FAILURE_WINDOW_MS)) >= (this.options.failedAttemptLimit ?? 10)) return fail("ACTIVATION_RATE_LIMITED");
    const parsed = parseActivationCode(input.code);
    if (!parsed) return fail("ACTIVATION_CODE_INVALID");
    const presentedHash = hashActivationSecret(this.options.pepper, parsed.lookupId, parsed.secret);
    // Fail fast before consulting the Portal for a code that cannot succeed.
    const peek = await this.repository.findCodeByLookup(parsed.lookupId);
    if (!peek || !sameDigest(peek.secretHash, presentedHash)) return fail("ACTIVATION_CODE_INVALID");
    codeId = peek.record.id;
    const base = { ownerId, trustSubject: actor?.subject, lookupId: parsed.lookupId, presentedHash, idempotencyKey, correlationId, at, maxAttempts: this.options.outbox?.maxAttempts ?? 25 };
    if (peek.record.status === "REDEEMED") {
      if (peek.record.redeemedByOwnerId !== ownerId) return fail("ACTIVATION_CODE_ALREADY_REDEEMED");
      // Only an idempotent replay can succeed; it never re-verifies or re-provisions.
      try { return await this.repository.redeem({ ...base, infrastructureId: "" }); }
      catch (error) { return fail(code(error)); }
    }
    if (peek.record.status === "REVOKED") return fail("ACTIVATION_CODE_REVOKED");
    if (Date.parse(peek.record.expiresAt) <= at.getTime()) return fail("ACTIVATION_CODE_EXPIRED");
    let property: (RedeemPropertyInput & { ownershipEvidence: string }) | undefined;
    if (input.property) {
      const type = input.property.type;
      const externalSystem = text(input.property.externalSystem, 64);
      const externalReference = text(input.property.externalReference, 256);
      const displayName = text(input.property.displayName, 200);
      if (!type || !PROPERTY_TYPES.includes(type) || !externalSystem || !externalReference || !displayName) return fail("INVALID_REQUEST");
      if (!peek.record.plan.requiresProperty) return fail("PROPERTY_NOT_APPLICABLE");
      if (!peek.record.plan.propertyTypes.includes(type)) return fail("PROPERTY_TYPE_NOT_ENTITLED");
      if (!actor?.subject) return fail("TRUSTID_SUBJECT_REQUIRED");
      if (!this.options.ownership) return fail("OWNERSHIP_VERIFICATION_UNAVAILABLE");
      let receipt: string;
      try {
        // BOOTSTRAP: the owner must match the authoritative install; readiness may still be pending.
        receipt = ownershipReceipt(await this.options.ownership.verify({ trustIdSubject: actor.subject, externalSystem, externalReference, type, purpose: "BOOTSTRAP" }));
      } catch (error) { return fail(code(error)); }
      property = { type, externalSystem, externalReference, displayName, ownershipEvidence: receipt };
    } else if (peek.record.plan.requiresProperty) return fail("PROPERTY_REQUIRED");
    let result: { redemption: Redemption; replayed: boolean };
    try {
      // Reuse the owner's existing PERSONAL PDI. Only an owner with none gets their first one, through the
      // canonical race-safe provisioner; the unique index forbids a second. The key is random because
      // idempotency keys are global and client-chosen elsewhere: a predictable key could be pre-claimed.
      const pdi = await this.options.pdi.findPersonal(ownerId, actor?.subject) ?? await this.options.pdi.provision(ownerId, { type: "PERSONAL", idempotencyKey: `commercial-pdi:${randomUUID()}`, ownerTrustId: actor?.subject });
      result = await this.repository.redeem({ ...base, infrastructureId: pdi.id, property });
    } catch (error) { return fail(code(error)); }
    if (!result.replayed) await this.runOutbox({ aggregateId: result.redemption.id, limit: 1 }).catch(() => undefined);
    const current = await this.repository.getRedemption(result.redemption.id);
    return { redemption: current?.redemption ?? result.redemption, replayed: result.replayed };
  }

  async getRedemption(actor: Actor | null | undefined, id: string) {
    const ownerId = this.owner(actor);
    const found = await this.repository.getRedemption(id);
    if (!found || found.redemption.ownerId !== ownerId) throw new Error("REDEMPTION_NOT_FOUND");
    return found.redemption;
  }
  async listEntitlements(actor: Actor | null | undefined) { return this.repository.listEntitlements(this.owner(actor)); }
  async listLicenses(actor: Actor | null | undefined) { return this.repository.listLicenses(this.owner(actor)); }
  async getLicense(actor: Actor | null | undefined, id: string) {
    const ownerId = this.owner(actor);
    const license = await this.repository.getLicense(id);
    // Another owner's license is indistinguishable from a missing one.
    if (!license || license.ownerId !== ownerId) throw new Error("LICENSE_NOT_FOUND");
    return license;
  }

  /** Fails closed on any missing, revoked, suspended, expired, or mismatched record. */
  async verifyLicense(licenseId: string, expect: { ownerId?: string; productId?: string; propertyId?: string | null } = {}): Promise<LicenseVerification> {
    const at = this.now();
    const license = await this.repository.getLicense(licenseId);
    if (!license || (expect.ownerId !== undefined && license.ownerId !== expect.ownerId)) return { valid: false, reason: "LICENSE_NOT_FOUND" };
    if (expect.productId !== undefined && license.productId !== expect.productId) return { valid: false, reason: "PRODUCT_MISMATCH" };
    if (expect.propertyId !== undefined && (license.propertyId ?? null) !== expect.propertyId) return { valid: false, reason: "PROPERTY_MISMATCH" };
    const entitlement = await this.repository.getEntitlement(license.entitlementId);
    if (!entitlement || entitlement.ownerId !== license.ownerId || entitlement.productId !== license.productId) return { valid: false, reason: "LICENSE_NOT_FOUND" };
    if (license.status === "REVOKED" || entitlement.status === "REVOKED") return { valid: false, reason: "LICENSE_REVOKED" };
    const elapsed = [license.expiresAt, entitlement.expiresAt].some(value => value !== undefined && Date.parse(value) <= at.getTime());
    if (license.status === "EXPIRED" || entitlement.status === "EXPIRED" || elapsed) {
      if (elapsed) await this.repository.markExpired(license.id, at, randomUUID()).catch(() => undefined);
      return { valid: false, reason: "LICENSE_EXPIRED" };
    }
    if (license.status !== "ACTIVE" || entitlement.status !== "ACTIVE") return { valid: false, reason: "LICENSE_SUSPENDED" };
    if (license.propertyId) {
      const property = await this.repository.getProperty(license.propertyId);
      if (!property || property.ownerId !== license.ownerId || property.infrastructureId !== license.infrastructureId) return { valid: false, reason: "PROPERTY_MISMATCH" };
      if (property.status !== "ACTIVE") return { valid: false, reason: "PROPERTY_NOT_ACTIVE" };
    }
    return { valid: true, license, entitlement };
  }

  async changeLicense(actor: Actor | null | undefined, id: string, action: LifecycleAction, reason: unknown, correlationId: string) {
    const operator = await this.requireOperator(actor, ["COMMERCIAL_ADMIN"]);
    return this.repository.changeLicense(id, action, { actor: `operator:${operator.ownerId}`, reason: text(reason, 200) ?? undefined, at: this.now(), correlationId });
  }
  async changeEntitlement(actor: Actor | null | undefined, id: string, action: LifecycleAction, reason: unknown, correlationId: string) {
    const operator = await this.requireOperator(actor, ["COMMERCIAL_ADMIN"]);
    return this.repository.changeEntitlement(id, action, { actor: `operator:${operator.ownerId}`, reason: text(reason, 200) ?? undefined, at: this.now(), correlationId });
  }

  /** Short-lived, single-use, artifact-scoped authorization. No storage URL is ever issued here. */
  /** `version` binds the grant to one exact release; the distributor can only fulfil that version. */
  async authorizeDownload(actor: Actor | null | undefined, licenseId: string, artifactId: unknown, correlationId: string, version?: unknown) {
    const ownerId = this.owner(actor);
    const at = this.now();
    const deny = async (reason: string, license?: License): Promise<never> => {
      await this.repository.audit({ eventType: "DOWNLOAD_DENIED", correlationId, actor: `owner:${ownerId}`, ownerId, licenseId: license?.id, productId: license?.productId, result: "DENIED", reason, timestamp: at.toISOString() }).catch(() => undefined);
      throw new Error(reason);
    };
    if (typeof artifactId !== "string" || !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(artifactId)) return deny("INVALID_REQUEST");
    if (version !== undefined && (typeof version !== "string" || !/^\d{1,6}\.\d{1,6}\.\d{1,6}$/.test(version))) return deny("INVALID_REQUEST");
    const verification = await this.verifyLicense(licenseId, { ownerId });
    if (!verification.valid) return deny(verification.reason);
    if (!verification.entitlement.downloads.includes(artifactId)) return deny("DOWNLOAD_NOT_ENTITLED", verification.license);
    const ttl = Math.min(Math.max(this.options.downloadTtlSeconds ?? 300, 30), 900);
    const expiresAt = new Date(at.getTime() + ttl * 1000);
    const { token, hash } = generateDownloadToken();
    const grantId = await this.repository.insertDownloadGrant({ tokenHash: hash, ownerId, license: verification.license, artifactId, version: version as string | undefined, expiresAt, at, correlationId });
    return { grantId, token, artifactId, version: version as string | undefined, productId: verification.license.productId, licenseId: verification.license.id, expiresAt: expiresAt.toISOString() };
  }

  /** Called by the authenticated distributor at delivery time. Revocation or expiry after issuance still denies. */
  async redeemDownload(token: unknown, expected: { artifactId: unknown; productId?: unknown; propertyId?: unknown; version?: unknown }, correlationId: string) {
    const at = this.now();
    if (typeof token !== "string" || !token.startsWith("ddidl_") || token.length > 100 || typeof expected.artifactId !== "string") throw new Error("DOWNLOAD_GRANT_INVALID");
    const outcome = await this.repository.consumeDownloadGrant(hashDownloadToken(token), at, async grant => {
      // A distributor fulfilling for one property cannot spend a grant scoped to another (or to none).
      if (grant.artifact_id !== expected.artifactId || (expected.productId !== undefined && grant.product_id !== expected.productId) || (expected.propertyId !== undefined && grant.property_id !== expected.propertyId)) return "DOWNLOAD_SCOPE_MISMATCH";
      // Exact version binding: a pinned grant needs the same version; an unpinned (legacy) grant cannot be fulfilled for any version.
      if ((grant.artifact_version ?? undefined) !== (expected.version ?? undefined)) return "DOWNLOAD_SCOPE_MISMATCH";
      const verification = await this.verifyLicense(grant.license_id, { ownerId: grant.owner_id, productId: grant.product_id, propertyId: grant.property_id });
      if (!verification.valid) return verification.reason;
      return verification.entitlement.downloads.includes(grant.artifact_id) ? null : "DOWNLOAD_NOT_ENTITLED";
    });
    const grant = outcome.grant;
    await this.repository.audit({ eventType: outcome.ok ? "DOWNLOAD_REDEEMED" : "DOWNLOAD_DENIED", correlationId, actor: "service:distributor", ownerId: grant?.owner_id as DigiOwnerId | undefined, licenseId: grant?.license_id as License["id"] | undefined, entitlementId: grant?.entitlement_id as License["entitlementId"] | undefined, propertyId: (grant?.property_id ?? undefined) as License["propertyId"], productId: grant?.product_id, result: outcome.ok ? "CONSUMED" : "DENIED", reason: outcome.ok ? `artifact:${grant!.artifact_id}` : outcome.reason, timestamp: at.toISOString() }).catch(() => undefined);
    if (!outcome.ok) throw new Error(outcome.reason);
    return { ownerId: outcome.grant.owner_id, licenseId: outcome.grant.license_id, productId: outcome.grant.product_id, artifactId: outcome.grant.artifact_id, version: outcome.grant.artifact_version ?? undefined, propertyId: outcome.grant.property_id ?? undefined };
  }

  async getRedemptionDetail(actor: Actor | null | undefined, id: string) {
    await this.requireOperator(actor, ["COMMERCIAL_ADMIN"]);
    const detail = await this.repository.redemptionDetail(id);
    if (!detail) throw new Error("REDEMPTION_NOT_FOUND");
    return detail;
  }

  /** Operator recovery: ADMIN only, reason required, bounded, audited, then processed immediately. */
  async requeueRedemption(actor: Actor | null | undefined, id: string, reason: unknown, correlationId: string) {
    const operator = await this.requireOperator(actor, ["COMMERCIAL_ADMIN"]);
    const why = text(reason, 200);
    if (!why) throw new Error("REASON_REQUIRED");
    const requeued = await this.repository.requeueOutbox(id, { actor: `operator:${operator.ownerId}`, reason: why, at: this.now(), correlationId });
    const run = await this.runOutbox({ aggregateId: id, limit: 1 });
    const detail = await this.repository.redemptionDetail(id);
    return { ...requeued, run, redemption: detail?.redemption, outbox: detail?.outbox };
  }

  async runOutboxAsOperator(actor: Actor | null | undefined, limit = 20) {
    await this.requireOperator(actor, ["COMMERCIAL_ADMIN"]);
    return this.runOutbox({ limit });
  }

  /** Processes due jobs and jobs whose worker lease expired (crash/restart recovery). */
  async runOutbox(options: { aggregateId?: string; limit?: number } = {}) {
    const jobs = await this.repository.claimOutbox({ now: this.now(), limit: Math.min(options.limit ?? 20, 100), leaseMs: this.options.outbox?.leaseMs ?? 60_000, aggregateId: options.aggregateId });
    const summary = { processed: 0, completed: 0, retried: 0, dead: 0, superseded: 0 };
    for (const job of jobs) {
      const outcome = await this.process(job).catch(error => ({ status: "PENDING" as const, error: code(error), nextAttemptAt: this.backoff(job) }));
      const settled = await this.repository.settleOutbox(job, { ...outcome, at: this.now() });
      summary.processed++;
      if (!settled) summary.superseded++;
      else if (outcome.status === "DONE") summary.completed++;
      else if (outcome.status === "DEAD") summary.dead++;
      else summary.retried++;
    }
    return summary;
  }

  private backoff(job: OutboxJob) {
    const base = this.options.outbox?.baseDelayMs ?? 5_000;
    const max = this.options.outbox?.maxDelayMs ?? 15 * 60_000;
    return new Date(this.now().getTime() + Math.min(base * 2 ** Math.max(job.attempts - 1, 0), max));
  }

  /**
   * Two independent idempotent steps, so neither waits on the other:
   * 1. external provisioning (commercial authorization only, no DDI privilege);
   * 2. property activation, only after the Portal reports the install READY.
   * This breaks the PortalInstall READY <-> DDI provisioning cycle without ever
   * granting an unverified or not-ready property a privilege.
   */
  private async process(job: OutboxJob): Promise<{ status: "DONE" | "DEAD" | "PENDING"; error?: string; nextAttemptAt?: Date }> {
    const correlationId = `outbox:${job.id}:${job.attempts}`;
    const loaded = await this.repository.getRedemption(job.payload.redemptionId);
    if (!loaded) return { status: "DEAD", error: "REDEMPTION_NOT_FOUND" };
    const { redemption, trustSubject } = loaded;
    if (redemption.status === "COMPLETED" || redemption.status === "CANCELLED") return { status: "DONE" };
    const license = await this.repository.getLicense(redemption.licenseId);
    if (!license || license.status === "REVOKED") {
      await this.repository.setRedemptionStatus(redemption.id, "CANCELLED", this.now(), "LICENSE_REVOKED");
      return { status: "DONE" };
    }
    const property = redemption.propertyId ? await this.repository.getProperty(redemption.propertyId) : null;
    const retryable: string[] = [];
    let terminal: string | undefined;
    if (!redemption.provisionedAt) {
      try {
        const provisioned = await this.options.provisioner.provision({ idempotencyKey: `ddi-provision:${redemption.id}`, redemptionId: redemption.id, ownerId: redemption.ownerId, infrastructureId: redemption.infrastructureId, propertyId: redemption.propertyId, externalSystem: property?.externalSystem, externalReference: property?.externalReference, productId: license.productId, planId: license.planId, entitlementId: license.entitlementId, licenseId: license.id, ownerSubject: trustSubject });
        if (typeof provisioned?.reference !== "string" || !provisioned.reference) throw new Error("PROVISIONING_UNAVAILABLE");
        await this.repository.markProvisioned(redemption.id, provisioned.reference, this.now(), correlationId);
      } catch (error) {
        const reason = code(error);
        if (reason === "PROVISIONING_REJECTED") terminal = reason; else retryable.push(reason === "UNAVAILABLE" ? "PROVISIONING_UNAVAILABLE" : reason);
        await this.repository.audit({ eventType: "PROVISIONING_FAILED", correlationId, actor: "system:outbox", ownerId: redemption.ownerId, redemptionId: redemption.id, licenseId: license.id, propertyId: redemption.propertyId, productId: license.productId, result: terminal ? "REJECTED" : "RETRY", reason, timestamp: this.now().toISOString() });
      }
    }
    if (property && !terminal) {
      if (property.status === "PENDING_ACTIVATION") {
        if (!this.options.ownership) retryable.push("OWNERSHIP_VERIFICATION_UNAVAILABLE");
        else if (!trustSubject) terminal = "TRUSTID_SUBJECT_REQUIRED";
        else {
          try {
            // Final authoritative re-check: READY now, for the same owner who redeemed.
            const verification = await this.options.ownership.verify({ trustIdSubject: trustSubject, externalSystem: property.externalSystem, externalReference: property.externalReference, type: property.type, purpose: "ACTIVATE" });
            if (!await this.repository.activateProperty(redemption.id, this.now(), correlationId, ownershipReceipt(verification))) terminal = "PROPERTY_NOT_ACTIVATABLE";
          } catch (error) {
            const reason = code(error);
            if (reason === "OWNERSHIP_NOT_VERIFIED") {
              await this.repository.failPropertyActivation(redemption.id, reason, this.now(), correlationId);
              return { status: "DEAD", error: reason };
            }
            retryable.push(reason);
          }
        }
      } else if (property.status === "ACTIVE") await this.repository.activateProperty(redemption.id, this.now(), correlationId);
      // Suspended by the Portal: wait (bounded) for a sequenced reinstatement; never activate meanwhile.
      else if (property.status === "SUSPENDED") retryable.push("PROPERTY_SUSPENDED");
      else terminal = "PROPERTY_NOT_ACTIVATABLE";
    }
    if (terminal) {
      await this.repository.setRedemptionStatus(redemption.id, "ATTENTION_REQUIRED", this.now(), terminal);
      return { status: "DEAD", error: terminal };
    }
    if (retryable.length) {
      const error = [...new Set(retryable)].join(",");
      if (job.attempts >= job.maxAttempts) {
        await this.repository.setRedemptionStatus(redemption.id, "ATTENTION_REQUIRED", this.now(), error);
        return { status: "DEAD", error };
      }
      await this.repository.setRedemptionStatus(redemption.id, "PROVISIONING_PENDING", this.now(), error);
      return { status: "PENDING", error, nextAttemptAt: this.backoff(job) };
    }
    await this.repository.setRedemptionStatus(redemption.id, "COMPLETED", this.now());
    return { status: "DONE" };
  }
}
