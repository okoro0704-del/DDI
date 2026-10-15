import { generateKeyPairSync } from "node:crypto";
import { signServiceToken, type ServiceSigner, type TrustedService } from "../../packages/service/src/service-token.ts";

/** Isolated, per-run Ed25519 test identities. Key ids are always `test-*`, which production verifiers refuse. */
export function testServiceIdentity(serviceId: string) {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const keyId = `test-${serviceId}`;
  const signer: ServiceSigner = { serviceId, keyId, privateKey };
  return {
    serviceId,
    keyId,
    signer,
    privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
    trusted(permissions: string[]): TrustedService { return { keys: { [keyId]: publicKey }, permissions }; },
    token(audience: string, method: string, path: string) { return signServiceToken(signer, { audience, method, path }); },
  };
}
