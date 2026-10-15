import { randomUUID, timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Actor, ApplicationRecord, InfrastructureRecord } from "../../../packages/contracts/src/index.ts";
import type { CommercialService } from "../../../packages/service/src/commercial.ts";
import type { LifecycleAction } from "../../../packages/service/src/commercial-repository.ts";

export type CommercialApi = Pick<CommercialService, "issueCode" | "revokeCode" | "getCode" | "redeem" | "getRedemption" | "listEntitlements" | "listLicenses" | "getLicense" | "verifyLicense" | "changeLicense" | "changeEntitlement" | "authorizeDownload" | "redeemDownload" | "runOutboxAsOperator" | "getRedemptionDetail" | "requeueRedemption">;

export const commercialRouteInventory = [
  { method: "POST", url: "/me/activations/redeem", access: "AUTHENTICATED_OWNER_COMMERCIAL" },
  { method: "GET", url: "/me/activations/:id", access: "AUTHENTICATED_OWNER_COMMERCIAL" },
  { method: "GET", url: "/me/entitlements", access: "AUTHENTICATED_OWNER_COMMERCIAL" },
  { method: "GET", url: "/me/licenses", access: "AUTHENTICATED_OWNER_COMMERCIAL" },
  { method: "GET", url: "/me/licenses/:id", access: "AUTHENTICATED_OWNER_COMMERCIAL" },
  { method: "POST", url: "/me/licenses/:id/downloads", access: "AUTHENTICATED_OWNER_COMMERCIAL" },
  { method: "POST", url: "/licenses/verify", access: "APPLICATION_AUTHENTICATED" },
  { method: "POST", url: "/internal/downloads/redeem", access: "DISTRIBUTOR_SERVICE_CREDENTIAL" },
  { method: "POST", url: "/admin/commercial/activation-codes", access: "COMMERCIAL_OPERATOR" },
  { method: "GET", url: "/admin/commercial/activation-codes/:id", access: "COMMERCIAL_OPERATOR" },
  { method: "POST", url: "/admin/commercial/activation-codes/:id/revoke", access: "COMMERCIAL_OPERATOR" },
  { method: "POST", url: "/admin/commercial/licenses/:id/:action", access: "COMMERCIAL_OPERATOR" },
  { method: "POST", url: "/admin/commercial/entitlements/:id/:action", access: "COMMERCIAL_OPERATOR" },
  { method: "POST", url: "/admin/commercial/outbox/run", access: "COMMERCIAL_OPERATOR" },
  { method: "GET", url: "/admin/commercial/redemptions/:id", access: "COMMERCIAL_OPERATOR" },
  { method: "POST", url: "/admin/commercial/redemptions/:id/requeue", access: "COMMERCIAL_OPERATOR" },
] as const;

const STATUS: Record<string, number> = {
  OWNER_REQUIRED: 401,
  OPERATOR_REQUIRED: 403, OWNERSHIP_NOT_VERIFIED: 403, TRUSTID_SUBJECT_REQUIRED: 403, DOWNLOAD_NOT_ENTITLED: 403, LICENSE_REVOKED: 403, LICENSE_SUSPENDED: 403, LICENSE_EXPIRED: 403, PROPERTY_NOT_ACTIVE: 403, PROPERTY_MISMATCH: 403, PRODUCT_MISMATCH: 403, DOWNLOAD_SCOPE_MISMATCH: 403, DOWNLOAD_GRANT_INVALID: 403, DOWNLOAD_GRANT_CONSUMED: 403, DOWNLOAD_GRANT_EXPIRED: 403, PROPERTY_TYPE_NOT_ENTITLED: 403,
  LICENSE_NOT_FOUND: 404, REDEMPTION_NOT_FOUND: 404, ACTIVATION_CODE_NOT_FOUND: 404, ENTITLEMENT_NOT_FOUND: 404, PLAN_NOT_FOUND: 404,
  ACTIVATION_CODE_ALREADY_REDEEMED: 409, IDEMPOTENCY_CONFLICT: 409, PROPERTY_REFERENCE_CONFLICT: 409, PROPERTY_TYPE_MISMATCH: 409, PROPERTY_NOT_ACTIVATABLE: 409, OWNERSHIP_VERIFICATION_PENDING: 409, LICENSE_NOT_MODIFIABLE: 409, ENTITLEMENT_NOT_MODIFIABLE: 409, ENTITLEMENT_EXPIRED: 409, OUTBOX_JOB_COMPLETE: 409, OUTBOX_JOB_IN_PROGRESS: 409, OUTBOX_REQUEUE_LIMIT: 409, OUTBOX_JOB_NOT_FOUND: 404,
  ACTIVATION_CODE_EXPIRED: 410, ACTIVATION_CODE_REVOKED: 410,
  ACTIVATION_RATE_LIMITED: 429,
  UNAVAILABLE: 503, OWNERSHIP_VERIFICATION_UNAVAILABLE: 503, COMMERCIAL_UNAVAILABLE: 503, DOWNLOAD_DELIVERY_UNAVAILABLE: 503,
};

function failure(reply: FastifyReply, error: unknown) {
  const message = error instanceof Error ? error.message : "UNAVAILABLE";
  const code = /^[A-Z0-9_]+$/.test(message) ? message : "UNAVAILABLE";
  return reply.code(STATUS[code] ?? 400).header("cache-control", "no-store").send({ code });
}

function sameSecret(actual: unknown, expected: string | undefined) {
  if (typeof actual !== "string" || !expected) return false;
  const left = Buffer.from(actual);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

const ACTIONS: Record<string, LifecycleAction> = { suspend: "SUSPEND", reinstate: "REINSTATE", revoke: "REVOKE" };

/**
 * Commercial activation routes. Owner routes require a canonical Digi session;
 * operator routes additionally require a server-side role binding. No route
 * accepts an owner id, role, or ownership claim from the request.
 */
export function registerCommercialRoutes(app: FastifyInstance, deps: {
  commercial?: CommercialApi;
  actorFrom(header: string | undefined): Promise<Actor | null>;
  applicationFrom(header: string | undefined): Promise<ApplicationRecord | null>;
  getInfrastructure(id: string): Promise<InfrastructureRecord | null>;
  distributorSecret?: string;
}) {
  const correlation = (request: FastifyRequest) => String(request.headers["x-correlation-id"] ?? randomUUID()).slice(0, 128);
  const owner = async (request: FastifyRequest, reply: FastifyReply) => {
    if (!deps.commercial) { await reply.code(503).send({ code: "COMMERCIAL_UNAVAILABLE" }); return null; }
    const actor = await deps.actorFrom(request.headers.authorization);
    if (!actor) { await reply.code(401).send({ code: "AUTHENTICATION_REQUIRED" }); return null; }
    return { actor, commercial: deps.commercial };
  };
  const id = (request: FastifyRequest) => (request.params as { id: string }).id;

  app.post("/me/activations/redeem", async (request, reply) => {
    const context = await owner(request, reply);
    if (!context) return reply;
    const body = request.body as { code?: unknown; property?: Record<string, unknown> } | undefined;
    const property = body?.property && typeof body.property === "object" ? { type: body.property.type as never, externalSystem: body.property.externalSystem as string, externalReference: body.property.externalReference as string, displayName: body.property.displayName as string } : undefined;
    try {
      const result = await context.commercial.redeem(context.actor, { code: body?.code, idempotencyKey: String(request.headers["idempotency-key"] ?? ""), property }, correlation(request));
      // 202 until provisioning and activation are both durably complete.
      return reply.code(result.redemption.status === "COMPLETED" ? 200 : 202).header("cache-control", "no-store").send(result);
    } catch (error) { return failure(reply, error); }
  });
  app.get("/me/activations/:id", async (request, reply) => {
    const context = await owner(request, reply);
    if (!context) return reply;
    try { return await context.commercial.getRedemption(context.actor, id(request)); }
    catch (error) { return failure(reply, error); }
  });
  app.get("/me/entitlements", async (request, reply) => {
    const context = await owner(request, reply);
    if (!context) return reply;
    try { return { entitlements: await context.commercial.listEntitlements(context.actor) }; }
    catch (error) { return failure(reply, error); }
  });
  app.get("/me/licenses", async (request, reply) => {
    const context = await owner(request, reply);
    if (!context) return reply;
    try { return { licenses: await context.commercial.listLicenses(context.actor) }; }
    catch (error) { return failure(reply, error); }
  });
  app.get("/me/licenses/:id", async (request, reply) => {
    const context = await owner(request, reply);
    if (!context) return reply;
    try {
      const license = await context.commercial.getLicense(context.actor, id(request));
      const verification = await context.commercial.verifyLicense(license.id, { ownerId: context.actor.ownerId });
      return { license, valid: verification.valid, reason: verification.valid ? undefined : verification.reason };
    } catch (error) { return failure(reply, error); }
  });
  app.post("/me/licenses/:id/downloads", async (request, reply) => {
    const context = await owner(request, reply);
    if (!context) return reply;
    try { return reply.header("cache-control", "no-store").send(await context.commercial.authorizeDownload(context.actor, id(request), (request.body as { artifactId?: unknown } | undefined)?.artifactId, correlation(request))); }
    catch (error) { return failure(reply, error); }
  });

  app.post("/licenses/verify", async (request, reply) => {
    if (!deps.commercial) return reply.code(503).send({ code: "COMMERCIAL_UNAVAILABLE" });
    const application = await deps.applicationFrom(request.headers.authorization);
    if (!application) return reply.code(401).send({ code: "AUTHENTICATION_REQUIRED" });
    const infrastructure = await deps.getInfrastructure(application.infrastructureId);
    if (!infrastructure) return reply.code(404).send({ code: "INFRASTRUCTURE_NOT_FOUND" });
    const body = request.body as { licenseId?: unknown; productId?: unknown } | undefined;
    if (typeof body?.licenseId !== "string") return reply.code(400).send({ code: "INVALID_REQUEST" });
    // An application sees only licenses of its own owner and its own property scope.
    const verification = await deps.commercial.verifyLicense(body.licenseId, { ownerId: infrastructure.ownerId, productId: typeof body.productId === "string" ? body.productId : undefined, propertyId: application.propertyId ?? null });
    return verification.valid ? { valid: true, licenseId: verification.license.id, productId: verification.license.productId, planId: verification.license.planId, propertyId: verification.license.propertyId, expiresAt: verification.license.expiresAt } : { valid: false, reason: verification.reason };
  });

  app.post("/internal/downloads/redeem", async (request, reply) => {
    if (!deps.commercial || !deps.distributorSecret) return reply.code(503).send({ code: "COMMERCIAL_UNAVAILABLE" });
    if (!sameSecret(request.headers["x-ddi-distributor-secret"], deps.distributorSecret)) return reply.code(403).send({ code: "FORBIDDEN" });
    const body = request.body as { token?: unknown; artifactId?: unknown; productId?: unknown; propertyId?: unknown } | undefined;
    try { return await deps.commercial.redeemDownload(body?.token, { artifactId: body?.artifactId, productId: body?.productId, propertyId: body?.propertyId }, correlation(request)); }
    catch (error) { return failure(reply, error); }
  });

  app.post("/admin/commercial/activation-codes", async (request, reply) => {
    const context = await owner(request, reply);
    if (!context) return reply;
    const body = request.body as { productId?: unknown; planId?: unknown; paymentReference?: unknown; expiresInHours?: unknown } | undefined;
    try {
      const result = await context.commercial.issueCode(context.actor, { productId: body?.productId, planId: body?.planId, paymentReference: body?.paymentReference, expiresInHours: body?.expiresInHours, idempotencyKey: String(request.headers["idempotency-key"] ?? "") }, correlation(request));
      return reply.code(result.created ? 201 : 200).header("cache-control", "no-store").send(result);
    } catch (error) { return failure(reply, error); }
  });
  app.get("/admin/commercial/activation-codes/:id", async (request, reply) => {
    const context = await owner(request, reply);
    if (!context) return reply;
    try { return await context.commercial.getCode(context.actor, id(request)); }
    catch (error) { return failure(reply, error); }
  });
  app.post("/admin/commercial/activation-codes/:id/revoke", async (request, reply) => {
    const context = await owner(request, reply);
    if (!context) return reply;
    try { return await context.commercial.revokeCode(context.actor, id(request), correlation(request)); }
    catch (error) { return failure(reply, error); }
  });
  app.post("/admin/commercial/licenses/:id/:action", async (request, reply) => {
    const context = await owner(request, reply);
    if (!context) return reply;
    const action = ACTIONS[(request.params as { action: string }).action];
    if (!action) return reply.code(404).send({ code: "NOT_FOUND" });
    try { return await context.commercial.changeLicense(context.actor, id(request), action, (request.body as { reason?: unknown } | undefined)?.reason, correlation(request)); }
    catch (error) { return failure(reply, error); }
  });
  app.post("/admin/commercial/entitlements/:id/:action", async (request, reply) => {
    const context = await owner(request, reply);
    if (!context) return reply;
    const action = ACTIONS[(request.params as { action: string }).action];
    if (!action) return reply.code(404).send({ code: "NOT_FOUND" });
    try { return await context.commercial.changeEntitlement(context.actor, id(request), action, (request.body as { reason?: unknown } | undefined)?.reason, correlation(request)); }
    catch (error) { return failure(reply, error); }
  });
  app.get("/admin/commercial/redemptions/:id", async (request, reply) => {
    const context = await owner(request, reply);
    if (!context) return reply;
    try { return await context.commercial.getRedemptionDetail(context.actor, id(request)); }
    catch (error) { return failure(reply, error); }
  });
  app.post("/admin/commercial/redemptions/:id/requeue", async (request, reply) => {
    const context = await owner(request, reply);
    if (!context) return reply;
    try { return await context.commercial.requeueRedemption(context.actor, id(request), (request.body as { reason?: unknown } | undefined)?.reason, correlation(request)); }
    catch (error) { return failure(reply, error); }
  });
  app.post("/admin/commercial/outbox/run", async (request, reply) => {
    const context = await owner(request, reply);
    if (!context) return reply;
    try { return await context.commercial.runOutboxAsOperator(context.actor); }
    catch (error) { return failure(reply, error); }
  });
}
