import { pathToFileURL } from "node:url"; import { join } from "node:path";
import type { AuthorityDecision, DigiOwnerId } from "../../contracts/src/index.ts";

export type DigiSession = { ownerId: DigiOwnerId; sessionId: string; subject?: string };

/** Consumes Digi RP session resolution. DDI does not read Digi tables. */
export type DigiSessionClient = { resolve(token: string): Promise<DigiSession | null> };

export class HttpDigiSessionClient implements DigiSessionClient {
  private baseUrl: string;
  constructor(baseUrl: string) { this.baseUrl = baseUrl; }
  async resolve(token: string): Promise<DigiSession | null> {
    let response: Response;
    try { response = await fetch(new URL("/me", this.baseUrl), { headers: { authorization: `Bearer ${token}` } }); }
    catch { return null; }
    if (!response.ok) return null;
    const body = await response.json() as { ownerId?: string; sessionId?: string; subject?: string };
    if (!body.ownerId || !body.sessionId) return null;
    return { ownerId: body.ownerId as DigiOwnerId, sessionId: body.sessionId, subject: typeof body.subject === "string" ? body.subject : undefined };
  }
}

export type AuthorityConsumeInput = { token: string; audience: string; actor: string; action: string; resource: string; ownerId: string };

/** Stateful Digi Authority consumption. Verification of owner/action/resource happens before consume. */
export type DigiAuthorityClient = { consume(input: AuthorityConsumeInput): Promise<AuthorityDecision> };

type DenyReason = Extract<AuthorityDecision, { ok: false }>["reason"];
const reasonMap = (reason: string): DenyReason => {
  if (reason === "missing_token" || reason === "MISSING") return "MISSING";
  if (reason === "expired") return "EXPIRED";
  if (reason === "revoked" || reason === "replay") return "REVOKED";
  if (reason === "wrong_action") return "WRONG_ACTION";
  if (reason === "wrong_resource" || reason === "wrong_owner") return "WRONG_RESOURCE";
  if (reason === "wrong_audience") return "WRONG_AUDIENCE";
  if (reason === "wrong_actor") return "INVALID";
  return "INVALID";
};

export function mapAuthorityReason(reason: string): AuthorityDecision {
  return { ok: false, reason: reason === "MISSING" ? "MISSING" : reasonMap(reason) };
}

export class HttpDigiAuthorityClient implements DigiAuthorityClient {
  private options: { consumeUrl: string; jwksUrl: string; verifierModuleUrl: string };
  constructor(options: { consumeUrl: string; jwksUrl: string; verifierModuleUrl: string }) { this.options = options; }
  async consume(input: AuthorityConsumeInput): Promise<AuthorityDecision> {
    const verifier = await import(this.options.verifierModuleUrl) as { verifyAuthority(input: Record<string, unknown>): Promise<{ ok: boolean; reason?: string }> };
    const verified = await verifier.verifyAuthority({ token: input.token, audience: input.audience, actor: input.actor, action: input.action, resource: input.resource, ownerId: input.ownerId, jwksUrl: this.options.jwksUrl });
    if (!verified.ok) return mapAuthorityReason(verified.reason ?? "INVALID");
    let response: Response;
    try {
      response = await fetch(this.options.consumeUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: input.token, audience: input.audience, actor: input.actor, action: input.action, resource: input.resource }) });
    } catch { throw new Error("AUTHORITY_UNAVAILABLE"); }
    if (response.status >= 500) throw new Error("AUTHORITY_UNAVAILABLE");
    const body = await response.json() as { decision?: string; grantId?: string; reason?: string };
    if (body.decision === "ALLOW" && body.grantId) return { ok: true, grantId: body.grantId };
    return mapAuthorityReason(body.reason ?? "INVALID");
  }
}

type ListedGrant = { id: string; actorType: string; actorId: string; actions: string[]; resources: string[]; audience: string; status: string; oneTime?: boolean };

/** PDI connection approval uses the public Authority routes and explicitly requests a reusable grant. */
export class HttpDigiAuthorityGrantClient {
  private baseUrl: string;
  constructor(baseUrl: string) { this.baseUrl = baseUrl; }
  async ensureGrant(input: { ownerId: string; actor: string; action: string; resource: string; audience: string; sessionToken?: string }) {
    if (!input.sessionToken) throw new Error("AUTHORITY_GRANT_UNAVAILABLE");
    const headers = { authorization: `Bearer ${input.sessionToken}`, "content-type": "application/json" };
    let listed: Response;
    try { listed = await fetch(new URL("/authority/grants/active", this.baseUrl), { headers }); }
    catch { throw new Error("AUTHORITY_GRANT_UNAVAILABLE"); }
    if (listed.ok) {
      const body = await readJson<{ grants?: ListedGrant[] }>(listed);
      const found = body.grants?.find(grant => reusableMatch(grant, input));
      if (found) return { grantId: found.id };
    } else if (listed.status >= 500) throw new Error("AUTHORITY_GRANT_UNAVAILABLE");
    let checked: Response;
    try { checked = await fetch(new URL("/authority/check", this.baseUrl), { method: "POST", headers, body: JSON.stringify({ actor: input.actor, action: input.action, resource: input.resource, audience: input.audience, ownerId: input.ownerId }) }); }
    catch { throw new Error("AUTHORITY_GRANT_UNAVAILABLE"); }
    if (checked.status >= 500) throw new Error("AUTHORITY_GRANT_UNAVAILABLE");
    const decision = await readJson<{ decision?: string; grantId?: string; requestId?: string }>(checked);
    if ((decision.decision === "ALLOW" || decision.decision === "ALLOW_WITH_LIMITS") && decision.grantId) {
      await this.requireReusable(decision.grantId, headers);
      return { grantId: decision.grantId };
    }
    if (decision.decision === "ASK_OWNER" && decision.requestId) {
      let approved: Response;
      try { approved = await fetch(new URL(`/authority/requests/${decision.requestId}/approve`, this.baseUrl), { method: "POST", headers, body: JSON.stringify({ oneTime: false }) }); }
      catch { throw new Error("AUTHORITY_GRANT_UNAVAILABLE"); }
      if (approved.status >= 500) throw new Error("AUTHORITY_GRANT_UNAVAILABLE");
      if (!approved.ok) throw new Error("AUTHORITY_GRANT_UNAVAILABLE");
      const body = await readJson<{ grantId?: string; oneTime?: boolean }>(approved);
      if (!body.grantId || body.oneTime === undefined) throw new Error("AUTHORITY_GRANT_UNAVAILABLE");
      if (body.oneTime !== false) throw new Error("AUTHORITY_GRANT_NOT_REUSABLE");
      return { grantId: body.grantId };
    }
    throw new Error("AUTHORITY_GRANT_UNAVAILABLE");
  }
  private async requireReusable(grantId: string, headers: { authorization: string; "content-type": string }) {
    let response: Response;
    try { response = await fetch(new URL(`/authority/grants/${grantId}`, this.baseUrl), { headers }); }
    catch { throw new Error("AUTHORITY_GRANT_UNAVAILABLE"); }
    if (!response.ok) throw new Error("AUTHORITY_GRANT_UNAVAILABLE");
    const body = await readJson<{ grant?: { status?: string; oneTime?: boolean } }>(response);
    if (body.grant?.status !== "ACTIVE" || body.grant.oneTime !== false) throw new Error("AUTHORITY_GRANT_NOT_REUSABLE");
  }
  async revokeGrant(input: { ownerId: string; grantId: string; sessionToken?: string }) {
    if (!input.sessionToken) throw new Error("AUTHORITY_GRANT_UNAVAILABLE");
    const response = await fetch(new URL(`/authority/grants/${input.grantId}/revoke`, this.baseUrl), { method: "POST", headers: { authorization: `Bearer ${input.sessionToken}` } });
    if (!response.ok) throw new Error("AUTHORITY_GRANT_UNAVAILABLE");
  }
}

function reusableMatch(grant: ListedGrant, input: { actor: string; action: string; resource: string; audience: string }) {
  const split = input.actor.indexOf(":");
  return grant.status === "ACTIVE" && grant.oneTime === false && grant.actorType === input.actor.slice(0, split) && grant.actorId === input.actor.slice(split + 1) && grant.audience === input.audience && grant.actions.includes(input.action) && grant.resources.includes(input.resource);
}

async function readJson<T>(response: Response): Promise<T> {
  try { return await response.json() as T; }
  catch { throw new Error("AUTHORITY_GRANT_UNAVAILABLE"); }
}

export function defaultAuthorityVerifierUrl() {
  return pathToFileURL(join(process.env.DDI_TRUSTID_ROOT ?? "C:/Users/Hp/Desktop/TRUST ID", "packages", "authority-verifier", "dist", "index.js")).href;
}
