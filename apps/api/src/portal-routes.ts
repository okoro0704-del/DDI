import type { FastifyInstance } from "fastify";
import { PORTAL_INSTALL_EVENT_TYPES, type PortalInstallEvent, type PostgresPortalInstallState } from "../../../packages/service/src/portal-install-state.ts";
import { bearer, ServiceReplayUnavailable, type ServiceTokenVerifier } from "../../../packages/service/src/service-token.ts";

export const PORTAL_INSTALL_EVENTS_CONTRACT = "portal.install-events.v1";
export const portalRouteInventory = [
  { method: "POST", url: "/internal/portal/install-events", access: "SERVICE_TOKEN:portal:install-events" },
] as const;

const ID = /^[A-Za-z0-9:_.-]{1,200}$/;

/**
 * Portal -> DDI install-state events. Idempotent by eventId, ordered by the
 * Portal's per-install sequence. The Portal supports no ownership transfer;
 * an event naming a different owner than the redeemer restricts the property.
 */
export function registerPortalRoutes(app: FastifyInstance, deps: { serviceAuth?: ServiceTokenVerifier; installState?: PostgresPortalInstallState; now?: () => Date }) {
  app.post("/internal/portal/install-events", async (request, reply) => {
    if (!deps.serviceAuth || !deps.installState) return reply.code(503).send({ code: "PORTAL_EVENTS_UNAVAILABLE" });
    let caller;
    try { caller = await deps.serviceAuth.verify(bearer(request.headers.authorization), { method: "POST", path: "/internal/portal/install-events" }); }
    catch (error) { if (error instanceof ServiceReplayUnavailable) return reply.code(503).send({ code: error.message }); throw error; }
    if (!caller) return reply.code(401).send({ code: "SERVICE_AUTHENTICATION_REQUIRED" });
    if (!caller.permissions.includes("portal:install-events")) return reply.code(403).send({ code: "FORBIDDEN" });
    const body = request.body as Record<string, unknown> | undefined;
    const state = body?.state as Record<string, unknown> | undefined;
    if (body?.contractVersion !== PORTAL_INSTALL_EVENTS_CONTRACT) return reply.code(422).send({ code: "CONTRACT_VERSION_UNSUPPORTED" });
    if (!PORTAL_INSTALL_EVENT_TYPES.includes(body.type as never)) return reply.code(422).send({ code: "EVENT_TYPE_UNSUPPORTED" });
    const valid = typeof body.eventId === "string" && ID.test(body.eventId) && typeof body.installId === "string" && ID.test(body.installId)
      && body.externalReference === `portal-install:${body.installId}` && typeof body.ownerSubject === "string" && body.ownerSubject.length > 0 && body.ownerSubject.length <= 512 && !body.ownerSubject.startsWith("local:")
      && Number.isSafeInteger(body.sequence) && (body.sequence as number) >= 0 && typeof body.correlationId === "string" && body.correlationId.length <= 200
      && typeof body.occurredAt === "string" && !Number.isNaN(Date.parse(body.occurredAt))
      && !!state && typeof state.installSuspended === "boolean" && typeof state.ownerSuspended === "boolean" && typeof state.retired === "boolean";
    if (!valid) return reply.code(400).send({ code: "INVALID_REQUEST" });
    const event: PortalInstallEvent = { eventId: body.eventId as string, type: body.type as PortalInstallEvent["type"], installId: body.installId as string, externalReference: body.externalReference as string, ownerSubject: body.ownerSubject as string, sequence: body.sequence as number, state: { installSuspended: state!.installSuspended as boolean, ownerSuspended: state!.ownerSuspended as boolean, retired: state!.retired as boolean }, correlationId: body.correlationId as string, occurredAt: body.occurredAt as string };
    try { return await deps.installState.applyEvent(event, caller.serviceId, deps.now?.() ?? new Date()); }
    catch { return reply.code(503).send({ code: "UNAVAILABLE" }); }
  });
}
