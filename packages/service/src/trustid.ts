import { pathToFileURL } from "node:url";
export type TrustIdAssertionVerifier = { verify(assertion: string): Promise<{ subject: string } | null>; health(): Promise<"CONNECTED" | "DEGRADED" | "UNAVAILABLE"> };
type DigiBridge = { createJwksCache(input: { jwksUrl: string }): unknown; verifyDigiAssertion(input: { assertion: string; expectedIssuer: string; expectedAudience: string; jwks: unknown }): Promise<{ ok: boolean; subject?: string }> };
/** Uses TrustID's canonical @trustid/digi-bridge verification implementation. */
export class CanonicalTrustIdVerifier implements TrustIdAssertionVerifier {
  private bridge: Promise<DigiBridge> | undefined;
  private options: { issuer: string; audience: string; jwksUrl: string; bridgeModuleUrl: string };
  constructor(options: { issuer: string; audience: string; jwksUrl: string; bridgeModuleUrl: string }) { this.options = options; }
  private load() { return this.bridge ??= import(this.options.bridgeModuleUrl) as Promise<DigiBridge>; }
  async verify(assertion: string): Promise<{ subject: string } | null> {
    try { const bridge = await this.load(); const jwks = bridge.createJwksCache({ jwksUrl: this.options.jwksUrl }); const result = await bridge.verifyDigiAssertion({ assertion, expectedIssuer: this.options.issuer, expectedAudience: this.options.audience, jwks }); return result.ok && result.subject ? { subject: result.subject } : null; } catch { return null; }
  }
  async health() { try { const response = await fetch(this.options.jwksUrl, { headers: { accept: "application/json" } }); return response.ok ? "CONNECTED" as const : "DEGRADED" as const; } catch { return "UNAVAILABLE" as const; } }
}
export function defaultTrustBridgeUrl() { return pathToFileURL("C:/Users/Hp/Desktop/TRUST ID/packages/digi-bridge/dist/index.js").href; }
