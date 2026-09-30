import { pathToFileURL } from "node:url";
import type { AuthorityDecision, DigiOwnerId } from "../../contracts/src/index.ts";

export type DigiSession = { ownerId: DigiOwnerId; sessionId: string };

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
    const body = await response.json() as { ownerId?: string; sessionId?: string };
    if (!body.ownerId || !body.sessionId) return null;
    return { ownerId: body.ownerId as DigiOwnerId, sessionId: body.sessionId };
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

export function defaultAuthorityVerifierUrl() {
  return pathToFileURL("C:/Users/Hp/Desktop/TRUST ID/packages/authority-verifier/dist/index.js").href;
}
