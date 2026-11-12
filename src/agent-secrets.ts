import type { Store } from "./store.ts";

/**
 * Credential values a caller gave one agent in place of the stage's: kept
 * apart from its record, so no read of the record or a command holds one.
 */
export interface AgentSecrets {
  put(agentId: string, name: string, value: string): Promise<void>;
  get(agentId: string, name: string): Promise<string | null>;
  remove(agentId: string, names: string[]): Promise<void>;
}

/** Where none can be kept: an agent can then be given only the stage's own. */
export const NO_AGENT_SECRETS: AgentSecrets = {
  put: async () => {
    throw new Error("this server keeps no credential of an agent's own");
  },
  get: async () => null,
  remove: async () => {},
};

/** In the service's own database, in a table no route reads. */
export const storeSecrets = (store: Store): AgentSecrets => ({
  put: (agentId, name, value) => store.putSecret(agentId, name, value),
  get: (agentId, name) => store.getSecret(agentId, name),
  remove: (agentId, names) => store.removeSecrets(agentId, names),
});
