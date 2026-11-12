import type { Store } from "./store.ts";

/**
 * Credential values a caller gave one worker in place of the stage's: kept
 * apart from its record, so no read of the record or a command holds one.
 */
export interface WorkerSecrets {
  put(workerId: string, name: string, value: string): Promise<void>;
  get(workerId: string, name: string): Promise<string | null>;
  remove(workerId: string, names: string[]): Promise<void>;
}

/** Where none can be kept: a worker can then be given only the stage's own. */
export const NO_WORKER_SECRETS: WorkerSecrets = {
  put: async () => {
    throw new Error("this server keeps no credential of a worker's own");
  },
  get: async () => null,
  remove: async () => {},
};

/** In the service's own database, in a table no route reads. */
export const storeSecrets = (store: Store): WorkerSecrets => ({
  put: (workerId, name, value) => store.putSecret(workerId, name, value),
  get: (workerId, name) => store.getSecret(workerId, name),
  remove: (workerId, names) => store.removeSecrets(workerId, names),
});
