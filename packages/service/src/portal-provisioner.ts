import type { CommercialProvisioner, ProvisioningRequest } from "./commercial.ts";
import { signServiceToken, type ServiceSigner } from "./service-token.ts";

export const PORTAL_PROVISIONING_CONTRACT = "ddi.portal.provisioning.v1";

/**
 * Real adapter for the Portal's `POST /internal/ddi/provisioning`.
 *
 * Enabled only by `DDI_COMMERCIAL_PROVISIONING_MODE=portal-local-integration`
 * outside production; production composition keeps the always-unavailable
 * provisioner. A timeout or network failure is an UNKNOWN outcome: it is
 * retried with the same idempotency key, and the Portal answers a retry with
 * its original result, so success is only ever recorded from the Portal's reply.
 */
export class HttpPortalProvisioner implements CommercialProvisioner {
  private options: { url: string; signer: ServiceSigner; audience?: string; timeoutMs?: number; fetch?: typeof fetch };
  constructor(options: { url: string; signer: ServiceSigner; audience?: string; timeoutMs?: number; fetch?: typeof fetch }) { this.options = options; }

  async provision(input: ProvisioningRequest): Promise<{ reference: string }> {
    if (!input.ownerSubject || input.externalSystem !== "lifeos" || !input.externalReference?.startsWith("portal-install:")) throw new Error("PROVISIONING_REJECTED");
    const url = new URL(this.options.url);
    const token = signServiceToken(this.options.signer, { audience: this.options.audience ?? "lifeos-portal", method: "POST", path: url.pathname });
    let response: Response;
    try {
      response = await (this.options.fetch ?? fetch)(url, {
        method: "POST",
        signal: AbortSignal.timeout(this.options.timeoutMs ?? 10_000),
        headers: { "content-type": "application/json", authorization: `Bearer ${token}`, "idempotency-key": input.idempotencyKey, "x-correlation-id": `ddi:${input.redemptionId}`, "x-ddi-contract": PORTAL_PROVISIONING_CONTRACT },
        body: JSON.stringify({ contractVersion: PORTAL_PROVISIONING_CONTRACT, redemptionId: input.redemptionId, licenseId: input.licenseId, entitlementId: input.entitlementId, productId: input.productId, planId: input.planId, ownerSubject: input.ownerSubject, externalReference: input.externalReference }),
      });
    } catch { throw new Error("PROVISIONING_UNAVAILABLE"); }
    if (response.status === 404 || response.status === 409 || response.status === 422) throw new Error("PROVISIONING_REJECTED");
    if (response.status === 423) throw new Error("PROVISIONING_INSTALL_LOCKED");
    if (response.status === 401 || response.status === 403) throw new Error("PROVISIONING_UNAUTHORIZED");
    if (!response.ok) throw new Error("PROVISIONING_UNAVAILABLE");
    let body: { contractVersion?: unknown; status?: unknown; reference?: unknown; redemptionId?: unknown; installId?: unknown };
    try { body = await response.json() as typeof body; }
    catch { throw new Error("PROVISIONING_UNAVAILABLE"); }
    const installId = input.externalReference.slice("portal-install:".length);
    // The reply must be about this redemption and this install; anything else is not evidence of success.
    if (body.contractVersion !== PORTAL_PROVISIONING_CONTRACT || (body.status !== "ACCEPTED" && body.status !== "PROVISIONED") || typeof body.reference !== "string" || !body.reference || body.redemptionId !== input.redemptionId || body.installId !== installId) throw new Error("PROVISIONING_REJECTED");
    return { reference: body.reference };
  }
}
