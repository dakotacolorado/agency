import type { TokenSource } from "./api.ts";
import type { Command } from "./schema.ts";
import { NO_AGENT_SECRETS, type AgentSecrets } from "./agent-secrets.ts";

/** A service an agent may be given: its address and token, by the variables a session reads them from. */
export interface Credential {
  /** Null for this service, whose address is the one a request came to. */
  url: string | null;
  urlVar: string;
  tokenVar: string;
  token: TokenSource;
}

/**
 * The services an agent may be given, by name. An agent's record and its
 * queued `start` hold only names and addresses; each token is read when its
 * `start` is pushed to the host, so none is stored, listed or logged here,
 * and a rotated secret reaches the next start.
 */
export class Credentials {
  readonly #known: ReadonlyMap<string, Credential>;
  /** Values callers gave one agent in place of a name's shared secret. */
  readonly own: AgentSecrets;

  constructor(known: Record<string, Credential>, own: AgentSecrets = NO_AGENT_SECRETS) {
    this.#known = new Map(Object.entries(known));
    this.own = own;
  }

  get names(): string[] {
    return [...this.#known.keys()];
  }

  /** What an agent made without naming any is given: every service this stage has. */
  get defaults(): string[] {
    return this.names;
  }

  /** Why an agent may not be given `names`; null when it may. */
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
   * agent was given; of the rest, the stage's. One that cannot be read is left out.
   */
  async secrets(names: string[], own: { agentId: string; names: string[] } | null = null): Promise<Record<string, string>> {
    const read = await Promise.all(
      names.map(async (name) => {
        const known = this.#known.get(name);
        if (!known) return [];
        try {
          const value = own?.names.includes(name) ? await this.own.get(own.agentId, name) : await known.token.value();
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
    const own = command.ownCredentials?.length ? { agentId: command.agentId, names: command.ownCredentials } : null;
    const secrets = await this.secrets(command.credentials, own);
    return Object.keys(secrets).length ? { ...command, secrets } : command;
  }
}

/** This service, which every stage has: the address a request came to, and the stage's token. */
export const selfCredential = (token: TokenSource): Credential => ({ url: null, urlVar: "AG_URL", tokenVar: "AG_TOKEN", token });
