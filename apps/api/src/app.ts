import { randomUUID } from "node:crypto";
import Fastify, { type FastifyReply } from "fastify";
import type { Actor, ApplicationRecord, Capability, CapabilityRequest, CapabilityResult, ExecutionMode, InfrastructureRecord, InfrastructureType, PdiApplicationConnection } from "../../../packages/contracts/src/index.ts";
import { authorityBinding, describeCapabilities } from "../../../packages/core/src/connection.ts";
import type { DdiConfig } from "../../../packages/service/src/config.ts";

export type DdiApiService = {
  authenticate(token: string): Promise<Actor | null>;
  authenticateApplication(secret: string): Promise<ApplicationRecord | null>;
  provision(actor: Actor, input: { type: InfrastructureType; metadata?: Record<string, string>; idempotencyKey: string }): Promise<InfrastructureRecord>;
  findPersonal(actor: Actor): Promise<InfrastructureRecord | null>;
  registerApp(actor: Actor, infrastructureId: string, input: { type: string; displayName: string; publicUrl?: string; adminUrl?: string; capabilities: Capability[]; idempotencyKey: string }): Promise<unknown>;
  getInfrastructure(id: string): Promise<InfrastructureRecord | null>;
  view(infrastructureId: string): Promise<unknown>;
  requestConnection(applicationId: string, capabilities: Capability[], correlationId: string, idempotencyKey: string): Promise<PdiApplicationConnection>;
  requestCapabilityChange(applicationId: string, capabilities: Capability[], correlationId: string): Promise<PdiApplicationConnection>;
  approveConnection(actor: Actor, connectionId: string, capabilities: Capability[], correlationId: string, sessionToken?: string): Promise<PdiApplicationConnection>;
  revokeConnection(actor: Actor, connectionId: string, correlationId: string, sessionToken?: string): Promise<PdiApplicationConnection>;
  revokeCapabilities(actor: Actor, connectionId: string, capabilities: Capability[], correlationId: string, sessionToken?: string): Promise<PdiApplicationConnection>;
  getConnection(id: string): Promise<PdiApplicationConnection | null>;
  listConnections(infrastructureId: string): Promise<PdiApplicationConnection[]>;
  execute(request: CapabilityRequest): Promise<CapabilityResult>;
};

/** Primitive execution is the only authority-enforced route. Administration is authenticated and is not consent. */
export const routeInventory = [
  { method: "GET", url: "/health", access: "PUBLIC_BY_DESIGN" },
  { method: "POST", url: "/infrastructures", access: "AUTHENTICATED_ADMINISTRATION" },
  { method: "GET", url: "/infrastructures/:id", access: "AUTHENTICATED_ADMINISTRATION" },
  { method: "POST", url: "/infrastructures/:id/apps", access: "AUTHENTICATED_ADMINISTRATION" },
  { method: "POST", url: "/infrastructures/:id/apps/:appId/grants", access: "RETIRED_CONSENT_BYPASS" },
  { method: "GET", url: "/me/pdi", access: "AUTHENTICATED_ADMINISTRATION" },
  { method: "POST", url: "/me/pdi", access: "AUTHENTICATED_ADMINISTRATION" },
  { method: "POST", url: "/infrastructures/:id/connections", access: "APPLICATION_AUTHENTICATED" },
  { method: "GET", url: "/infrastructures/:id/connections", access: "AUTHENTICATED_ADMINISTRATION" },
  { method: "GET", url: "/connections/:id", access: "AUTHENTICATED_PARTY" },
  { method: "POST", url: "/connections/:id/approve", access: "OWNER_CONSENT" },
  { method: "POST", url: "/connections/:id/revoke", access: "OWNER_CONSENT" },
  { method: "POST", url: "/connections/:id/capabilities/request", access: "APPLICATION_AUTHENTICATED" },
  { method: "POST", url: "/connections/:id/capabilities/revoke", access: "OWNER_CONSENT" },
  { method: "GET", url: "/infrastructures/:id/infrastructure", access: "AUTHENTICATED_ADMINISTRATION" },
  { method: "POST", url: "/capabilities/execute", access: "AUTHORITY_ENFORCED" },
] as const;

type Deps = {
  service: DdiApiService;
  config: DdiConfig;
  database?: () => Promise<"UP" | "DOWN" | "UNCONFIGURED">;
  identity?: () => Promise<"CONNECTED" | "DEGRADED" | "UNAVAILABLE">;
};

function safeCode(error: unknown) {
  const message = error instanceof Error ? error.message : "UNAVAILABLE";
  if (/postgres(ql)?:\/\//i.test(message) || !/^[A-Z0-9_]+$/.test(message)) return "UNAVAILABLE";
  return message;
}

function sendFailure(reply: FastifyReply, error: unknown) {
  const code = safeCode(error);
  const status = code === "UNKNOWN_INFRASTRUCTURE" || code === "UNKNOWN_APPLICATION" || code === "CONNECTION_NOT_FOUND" ? 404 : code === "OWNER_REQUIRED" || code === "IDEMPOTENCY_OWNER_MISMATCH" || code === "PROVIDER_CONFLICT" || code === "INFRASTRUCTURE_NOT_ACTIVE" || code === "CONSENT_ROUTE_RETIRED" ? 403 : code === "CONNECTION_ALREADY_ACTIVE" || code === "CONNECTION_NOT_APPROVABLE" || code === "CONNECTION_NOT_REVOCABLE" || code === "CAPABILITY_ALREADY_APPROVED" ? 409 : code === "UNAVAILABLE" || code === "STORAGE_UNAVAILABLE" || code === "AUTHORITY_GRANT_UNAVAILABLE" || code === "AUTHORITY_GRANT_NOT_REUSABLE" ? 503 : 400;
  return reply.code(status).send({ code });
}

export function resultStatus(status: CapabilityResult["status"]) {
  if (status === "COMPLETED") return 200;
  if (status === "AUTHENTICATION_REQUIRED") return 401;
  if (status === "DENIED") return 403;
  if (status === "CAPABILITY_UNAVAILABLE" || status === "PROVIDER_UNAVAILABLE" || status === "FAILED") return 503;
  return 400;
}

export function buildApi({ service, config, database = async () => "UNCONFIGURED", identity = async () => "CONNECTED" }: Deps) {
  const app = Fastify({ logger: false });
  const actorFrom = async (header: string | undefined) => header?.startsWith("Bearer ") ? service.authenticate(header.slice(7)) : null;
  const applicationFrom = async (header: string | undefined) => header?.startsWith("Application ") ? service.authenticateApplication(header.slice("Application ".length)) : null;
  const present = (connection: PdiApplicationConnection) => ({ ...connection, requested: describeCapabilities(connection.requestedCapabilities), approved: describeCapabilities(connection.approvedCapabilities), pending: describeCapabilities(connection.pendingCapabilities), authority: connection.authorityGrantRefs.map(ref => ({ capability: ref.capability, grantId: ref.grantId, actor: ref.actor, action: ref.action, resource: ref.resource, audience: ref.audience })) });
  app.addHook("onRequest", async (request, reply) => {
    const origin = request.headers.origin;
    if (origin) {
      if (!config.allowedOrigins.includes(origin)) return reply.code(403).send({ code: "ORIGIN_DENIED" });
      reply.header("access-control-allow-origin", origin).header("vary", "Origin").header("access-control-allow-credentials", "true");
    }
    if (request.method === "OPTIONS") return reply.header("access-control-allow-methods", "GET,POST,OPTIONS").header("access-control-allow-headers", "Authorization,Content-Type,Idempotency-Key,X-Correlation-Id").code(204).send();
  });
  app.get("/health", async () => {
    const databaseStatus = await database();
    const identityStatus = await identity();
    return {
      status: databaseStatus === "UP" && identityStatus !== "UNAVAILABLE" ? "HEALTHY" : "UNHEALTHY",
      ddi: "UP",
      database: { status: databaseStatus },
      identity: { provider: "TrustID", status: identityStatus },
      capabilities: { identity: identityStatus === "CONNECTED" ? "CONNECTED" : "NOT_CONNECTED", communication: "NOT_CONNECTED", data: "NOT_CONNECTED", jobs: "NOT_CONNECTED", distribution: "NOT_CONNECTED", value: "NOT_CONNECTED", intelligence: "NOT_CONNECTED" },
    };
  });
  app.post("/infrastructures", async (request, reply) => {
    const actor = await actorFrom(request.headers.authorization);
    if (!actor) return reply.code(401).send({ code: "AUTHENTICATION_REQUIRED" });
    const body = request.body as { type?: InfrastructureType; metadata?: Record<string, string> };
    try { return await service.provision(actor, { type: body?.type as InfrastructureType, metadata: body?.metadata, idempotencyKey: String(request.headers["idempotency-key"] ?? "") }); }
    catch (error) { return sendFailure(reply, error); }
  });
  app.get("/infrastructures/:id", async (request, reply) => {
    const actor = await actorFrom(request.headers.authorization);
    if (!actor) return reply.code(401).send({ code: "AUTHENTICATION_REQUIRED" });
    const infra = await service.getInfrastructure((request.params as { id: string }).id);
    if (!infra) return reply.code(404).send({ code: "INFRASTRUCTURE_NOT_FOUND" });
    return infra.ownerId === actor.ownerId ? infra : reply.code(403).send({ code: "DENIED" });
  });
  app.post("/infrastructures/:id/apps", async (request, reply) => {
    const actor = await actorFrom(request.headers.authorization);
    if (!actor) return reply.code(401).send({ code: "AUTHENTICATION_REQUIRED" });
    const body = request.body as { type?: string; displayName?: string; publicUrl?: string; adminUrl?: string; capabilities?: Capability[] };
    try {
      return await service.registerApp(actor, (request.params as { id: string }).id, { type: String(body?.type ?? ""), displayName: String(body?.displayName ?? ""), publicUrl: body?.publicUrl, adminUrl: body?.adminUrl, capabilities: body?.capabilities ?? [], idempotencyKey: String(request.headers["idempotency-key"] ?? "") });
    } catch (error) { return sendFailure(reply, error); }
  });
  app.post("/infrastructures/:id/apps/:appId/grants", async (_request, reply) => reply.code(403).send({ code: "CONSENT_ROUTE_RETIRED" }));
  app.get("/me/pdi", async (request, reply) => {
    const actor = await actorFrom(request.headers.authorization);
    if (!actor) return reply.code(401).send({ code: "AUTHENTICATION_REQUIRED" });
    const infrastructure = await service.findPersonal(actor);
    return infrastructure ? { state: "ACTIVE", infrastructure } : { state: "NOT_PROVISIONED" };
  });
  app.post("/me/pdi", async (request, reply) => {
    const actor = await actorFrom(request.headers.authorization);
    if (!actor) return reply.code(401).send({ code: "AUTHENTICATION_REQUIRED" });
    try { return await service.provision(actor, { type: "PERSONAL", metadata: (request.body as { metadata?: Record<string, string> } | undefined)?.metadata, idempotencyKey: String(request.headers["idempotency-key"] ?? "") }); }
    catch (error) { return sendFailure(reply, error); }
  });
  app.post("/infrastructures/:id/connections", async (request, reply) => {
    const application = await applicationFrom(request.headers.authorization);
    if (!application) return reply.code(401).send({ code: "AUTHENTICATION_REQUIRED" });
    if (application.infrastructureId !== (request.params as { id: string }).id) return reply.code(403).send({ code: "DENIED" });
    const body = request.body as { capabilities?: Capability[] };
    try { return present(await service.requestConnection(application.id, body?.capabilities ?? [], String(request.headers["x-correlation-id"] ?? randomUUID()), String(request.headers["idempotency-key"] ?? ""))); }
    catch (error) { return sendFailure(reply, error); }
  });
  app.get("/infrastructures/:id/connections", async (request, reply) => {
    const actor = await actorFrom(request.headers.authorization);
    if (!actor) return reply.code(401).send({ code: "AUTHENTICATION_REQUIRED" });
    const infra = await service.getInfrastructure((request.params as { id: string }).id);
    if (!infra) return reply.code(404).send({ code: "INFRASTRUCTURE_NOT_FOUND" });
    if (infra.ownerId !== actor.ownerId) return reply.code(403).send({ code: "DENIED" });
    return { connections: (await service.listConnections(infra.id)).map(present) };
  });
  app.get("/connections/:id", async (request, reply) => {
    const connection = await service.getConnection((request.params as { id: string }).id);
    if (!connection) return reply.code(404).send({ code: "CONNECTION_NOT_FOUND" });
    const actor = await actorFrom(request.headers.authorization);
    const application = await applicationFrom(request.headers.authorization);
    if (actor?.ownerId === connection.ownerId || application?.id === connection.applicationId) return present(connection);
    return reply.code(401).send({ code: "AUTHENTICATION_REQUIRED" });
  });
  app.post("/connections/:id/approve", async (request, reply) => {
    const header = request.headers.authorization;
    const actor = await actorFrom(header);
    if (!actor) return reply.code(401).send({ code: "AUTHENTICATION_REQUIRED" });
    const body = request.body as { capabilities?: Capability[] };
    try { return present(await service.approveConnection(actor, (request.params as { id: string }).id, body?.capabilities ?? [], String(request.headers["x-correlation-id"] ?? randomUUID()), header?.startsWith("Bearer ") ? header.slice(7) : undefined)); }
    catch (error) { return sendFailure(reply, error); }
  });
  app.post("/connections/:id/revoke", async (request, reply) => {
    const header = request.headers.authorization;
    const actor = await actorFrom(header);
    if (!actor) return reply.code(401).send({ code: "AUTHENTICATION_REQUIRED" });
    try { return present(await service.revokeConnection(actor, (request.params as { id: string }).id, String(request.headers["x-correlation-id"] ?? randomUUID()), header?.startsWith("Bearer ") ? header.slice(7) : undefined)); }
    catch (error) { return sendFailure(reply, error); }
  });
  app.post("/connections/:id/capabilities/request", async (request, reply) => {
    const application = await applicationFrom(request.headers.authorization);
    if (!application) return reply.code(401).send({ code: "AUTHENTICATION_REQUIRED" });
    const connection = await service.getConnection((request.params as { id: string }).id);
    if (!connection) return reply.code(404).send({ code: "CONNECTION_NOT_FOUND" });
    if (connection.applicationId !== application.id) return reply.code(403).send({ code: "DENIED" });
    const body = request.body as { capabilities?: Capability[] };
    try { return present(await service.requestCapabilityChange(application.id, body?.capabilities ?? [], String(request.headers["x-correlation-id"] ?? randomUUID()))); }
    catch (error) { return sendFailure(reply, error); }
  });
  app.post("/connections/:id/capabilities/revoke", async (request, reply) => {
    const header = request.headers.authorization;
    const actor = await actorFrom(header);
    if (!actor) return reply.code(401).send({ code: "AUTHENTICATION_REQUIRED" });
    const body = request.body as { capabilities?: Capability[] };
    try { return present(await service.revokeCapabilities(actor, (request.params as { id: string }).id, body?.capabilities ?? [], String(request.headers["x-correlation-id"] ?? randomUUID()), header?.startsWith("Bearer ") ? header.slice(7) : undefined)); }
    catch (error) { return sendFailure(reply, error); }
  });
  app.get("/infrastructures/:id/infrastructure", async (request, reply) => {
    const actor = await actorFrom(request.headers.authorization);
    if (!actor) return reply.code(401).send({ code: "AUTHENTICATION_REQUIRED" });
    const infra = await service.getInfrastructure((request.params as { id: string }).id);
    if (!infra) return reply.code(404).send({ code: "INFRASTRUCTURE_NOT_FOUND" });
    if (infra.ownerId !== actor.ownerId) return reply.code(403).send({ code: "DENIED" });
    return service.view(infra.id);
  });
  app.post("/capabilities/execute", async (request, reply) => {
    const application = await applicationFrom(request.headers.authorization);
    if (!application) return reply.code(401).send({ code: "AUTHENTICATION_REQUIRED" });
    const infrastructure = await service.getInfrastructure(application.infrastructureId);
    if (!infrastructure) return reply.code(404).send({ code: "INFRASTRUCTURE_NOT_FOUND" });
    const body = request.body as { capability?: Capability; authorityToken?: string; executionMode?: ExecutionMode; payload?: unknown };
    if (!body?.capability) return reply.code(400).send({ code: "INVALID_REQUEST" });
    const binding = authorityBinding(application.id, infrastructure.id, body.capability);
    try {
      const result = await service.execute({
        infrastructureId: infrastructure.id,
        applicationId: application.id,
        capability: body.capability,
        action: binding.action,
        resource: binding.resource,
        audience: binding.audience,
        actor: { ownerId: infrastructure.ownerId, kind: "SERVICE", verified: true, authorityActor: binding.actor },
        authority: body.authorityToken ? { token: body.authorityToken } : undefined,
        executionMode: body.executionMode === "SPACE" ? "SPACE" : "APP",
        correlationId: String(request.headers["x-correlation-id"] ?? randomUUID()),
        payload: body.payload,
      });
      return reply.code(resultStatus(result.status)).send(result);
    } catch { return reply.code(503).send({ code: "UNAVAILABLE" }); }
  });
  return app;
}
