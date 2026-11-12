import type { TokenSource } from "./api.ts";
import type { Command } from "./schema.ts";
import { NO_WORKER_SECRETS, type WorkerSecrets } from "./worker-secrets.ts";

/** A service a worker may be given: its address and token, by the variables a session reads them from. */
export interface Credential {
  /** Null for this service, whose address is the one a request came to. */
  url: string | null;
  urlVar: string;
  tokenVar: string;
  token: TokenSource;
}

/** What a worker made without `credentials` is given, of those this stage has. */
export const DEFAULT_CREDENTIALS = ["document-service", "work-tracker", "worker-service", "approval-service"];

/**
 * The services a worker may be given, by name. A worker's record and its
 * queued `start` hold only names and addresses; each token is read when its
 * `start` is pushed to the host, so none is stored, listed or logged here,
 * and a rotated secret reaches the next start.
 */
export class Credentials {
  readonly #known: ReadonlyMap<string, Credential>;
  /** Values callers gave one worker in place of a name's shared secret. */
  readonly own: WorkerSecrets;

  constructor(known: Record<string, Credential>, own: WorkerSecrets = NO_WORKER_SECRETS) {
    this.#known = new Map(Object.entries(known));
    this.own = own;
  }

  get names(): string[] {
    return [...this.#known.keys()];
  }

  /** What a worker made without naming any is given. */
  get defaults(): string[] {
    return DEFAULT_CREDENTIALS.filter((name) => this.#known.has(name));
  }

  /** Why a worker may not be given `names`; null when it may. */
  refuse(names: string[]): string | null {
    const unknown = names.filter((name) => !this.#known.has(name));
    if (!unknown.length) return null;
    const known = this.names;
    return `No credential is named ${unknown.join(", ")}; this stage has ${known.length ? known.join(", ") : "none"}.`;
  }

  /** The addresses `names` are reached at, by variable; `self` is this service's own. */
  addresses(names: string[], self: string): Record<string, string> {
    return Object.fromEntries(
      names.flatMap((name) => {
        const known = this.#known.get(name);
        return known ? [[known.urlVar, known.url ?? self]] : [];
      }),
    );
  }

  /**
   * The tokens of `names`, by variable: of those in `own`, the value the
   * worker was given; of the rest, the stage's. One that cannot be read is left out.
   */
  async secrets(names: string[], own: { workerId: string; names: string[] } | null = null): Promise<Record<string, string>> {
    const read = await Promise.all(
      names.map(async (name) => {
        const known = this.#known.get(name);
        if (!known) return [];
        try {
          const value = own?.names.includes(name) ? await this.own.get(own.workerId, name) : await known.token.value();
          return value ? [[known.tokenVar, value] as const] : [];
        } catch (err) {
          console.error(`Could not read the ${name} credential:`, (err as Error).name);
          return [];
        }
      }),
    );
    return Object.fromEntries(read.flat());
  }

  /** A command as it goes to its host: a `start` with its tokens. */
  async seal(command: Command): Promise<Command> {
    if (command.kind !== "start" || !command.credentials?.length) return command;
    const own = command.ownCredentials?.length ? { workerId: command.workerId, names: command.ownCredentials } : null;
    const secrets = await this.secrets(command.credentials, own);
    return Object.keys(secrets).length ? { ...command, secrets } : command;
  }
}

/** This service, which every stage has: the address a request came to, and the stage's token. */
export const selfCredential = (token: TokenSource): Credential => ({ url: null, urlVar: "WS_URL", tokenVar: "WS_TOKEN", token });
