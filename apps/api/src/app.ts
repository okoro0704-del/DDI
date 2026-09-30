import { randomUUID } from "node:crypto";
import Fastify, { type FastifyReply } from "fastify";
import type { Actor, Capability, CapabilityRequest, CapabilityResult, ExecutionMode, InfrastructureRecord, InfrastructureType } from "../../../packages/contracts/src/index.ts";
import type { DdiConfig } from "../../../packages/service/src/config.ts";

export type DdiApiService = {
  authenticate(token: string): Promise<Actor | null>;
  provision(actor: Actor, input: { type: InfrastructureType; metadata?: Record<string, string>; idempotencyKey: string }): Promise<InfrastructureRecord>;
  registerApp(actor: Actor, infrastructureId: string, input: { type: string; displayName: string; publicUrl?: string; adminUrl?: string; capabilities: Capability[]; idempotencyKey: string }): Promise<unknown>;
  grantCapabilities(actor: Actor, infrastructureId: string, applicationId: string, capabilities: Capability[]): Promise<unknown>;
  getInfrastructure(id: string): Promise<InfrastructureRecord | null>;
  view(infrastructureId: string): Promise<unknown>;
  execute(request: CapabilityRequest): Promise<CapabilityResult>;
};

/** Primitive execution is the only authority-enforced route. Administration is authenticated and is not consent. */
export const routeInventory = [
  { method: "GET", url: "/health", access: "PUBLIC_BY_DESIGN" },
  { method: "POST", url: "/infrastructures", access: "AUTHENTICATED_ADMINISTRATION" },
  { method: "GET", url: "/infrastructures/:id", access: "AUTHENTICATED_ADMINISTRATION" },
  { method: "POST", url: "/infrastructures/:id/apps", access: "AUTHENTICATED_ADMINISTRATION" },
  { method: "POST", url: "/infrastructures/:id/apps/:appId/grants", access: "AUTHENTICATED_ADMINISTRATION" },
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
  const status = code === "UNKNOWN_INFRASTRUCTURE" || code === "UNKNOWN_APPLICATION" ? 404 : code === "OWNER_REQUIRED" || code === "IDEMPOTENCY_OWNER_MISMATCH" || code === "PROVIDER_CONFLICT" || code === "INFRASTRUCTURE_NOT_ACTIVE" ? 403 : code === "UNAVAILABLE" || code === "STORAGE_UNAVAILABLE" ? 503 : 400;
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
  app.post("/infrastructures/:id/apps/:appId/grants", async (request, reply) => {
    const actor = await actorFrom(request.headers.authorization);
    if (!actor) return reply.code(401).send({ code: "AUTHENTICATION_REQUIRED" });
    const body = request.body as { capabilities?: Capability[] };
    try { return await service.grantCapabilities(actor, (request.params as { id: string }).id, (request.params as { appId: string }).appId, body?.capabilities ?? []); }
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
    const actor = await actorFrom(request.headers.authorization);
    if (!actor) return reply.code(401).send({ code: "AUTHENTICATION_REQUIRED" });
    const body = request.body as { infrastructureId?: CapabilityRequest["infrastructureId"]; applicationId?: CapabilityRequest["applicationId"]; capability?: Capability; action?: string; resource?: string; audience?: string; authorityToken?: string; authorityActor?: string; executionMode?: ExecutionMode; payload?: unknown };
    if (!body?.infrastructureId || !body.applicationId || !body.capability || !body.action || !body.resource) return reply.code(400).send({ code: "INVALID_REQUEST" });
    try {
      const result = await service.execute({
        infrastructureId: body.infrastructureId,
        applicationId: body.applicationId,
        capability: body.capability,
        action: body.action,
        resource: body.resource,
        audience: body.audience ?? "ddi",
        actor: { ...actor, authorityActor: body.authorityActor },
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
