import type { AuthorityGrantRef, Capability, InfrastructureId } from "../../contracts/src/index.ts";

/** Consent copy stays in DDI. Digi Authority does not store this text. */
const descriptions: Record<string, string> = {
  "identity.currentActor": "Identify the current Digi owner of this Personal Digital Infrastructure.",
  "identity.read": "Read identity attributes the owner has made available to this application.",
  "communication.inbox": "Read the conversation list of the communication primitive connected to this PDI.",
  "communication.send": "Send a communication through the communication primitive connected to this PDI.",
  "data.read": "Read data the owner approves for this application.",
};

export function describeCapability(capability: string) {
  return descriptions[capability] ?? "Capability declared by the application.";
}

export function describeCapabilities(capabilities: Capability[]) {
  return capabilities.map(capability => ({ capability, description: describeCapability(capability) }));
}

/** Explicit Authority binding. The actor key is not the DDI ApplicationId. */
export function authorityBinding(applicationId: string, infrastructureId: InfrastructureId | string, capability: Capability): Omit<AuthorityGrantRef, "grantId"> {
  return {
    capability,
    actor: `app:${applicationId}`,
    action: capability,
    resource: `ddi:pdi:${infrastructureId}:${capability}`,
    audience: "ddi",
  };
}

export function sameCapabilities(left: Capability[], right: Capability[]) {
  const a = [...left].sort().join("\n");
  const b = [...right].sort().join("\n");
  return a === b;
}

export function assertCapabilitySubset(selected: Capability[], allowed: Capability[]) {
  for (const capability of selected) if (!allowed.includes(capability)) throw new Error("CAPABILITY_NOT_REQUESTED");
}
