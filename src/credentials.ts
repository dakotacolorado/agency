import type { TokenSource } from "./api.ts";
import type { Command } from "./schema.ts";

/** A service an agent may be given: its address and token, by the variables a session reads them from. */
export interface Credential {
  /** Null for this service, whose address is the one a request came to. */
  url: string | null;
  urlVar: string;
  tokenVar: string;
  token: TokenSource;
  /** Where on its address it serves MCP; null or absent for none. */
  mcp?: string | null;
}

/** One MCP server as Claude Code's `mcpServers` takes it. */
export interface McpServer {
  type: "http";
  url: string;
  headers: Record<string, string>;
}

/**
 * The services an agent may be given, by name. An agent's record and its
 * queued `start` hold only names and addresses; each token is read when its
 * `start` is pushed to the host, so none is stored, listed or logged here,
 * and a rotated secret reaches the next start.
 */
export class Credentials {
  readonly #known: ReadonlyMap<string, Credential>;

  constructor(known: Record<string, Credential>) {
    this.#known = new Map(Object.entries(known));
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
   * The MCP servers of `names` that serve one, by name, their address and
   * token as references to the session's own variables, so no token is in them.
   */
  mcpServers(names: string[]): Record<string, McpServer> {
    return Object.fromEntries(
      names.flatMap((name) => {
        const known = this.#known.get(name);
        if (!known?.mcp) return [];
        const server: McpServer = { type: "http", url: `\${${known.urlVar}}${known.mcp}`, headers: { Authorization: `Bearer \${${known.tokenVar}}` } };
        return [[name, server]];
      }),
    );
  }

  /**
   * The tokens of `names`, by variable, as the stage has them. One that cannot be read is left out.
   */
  async secrets(names: string[]): Promise<Record<string, string>> {
    const read = await Promise.all(
      names.map(async (name) => {
        const known = this.#known.get(name);
        if (!known) return [];
        try {
          const value = await known.token.value();
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
    const secrets = await this.secrets(command.credentials);
    return Object.keys(secrets).length ? { ...command, secrets } : command;
  }
}

/** This service, which every stage has: the address a request came to, and the stage's token. */
export const selfCredential = (token: TokenSource): Credential => ({ url: null, urlVar: "AG_URL", tokenVar: "AG_TOKEN", token });
