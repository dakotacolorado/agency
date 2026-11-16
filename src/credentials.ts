import type { TokenSource } from "./api.ts";
import type { Command } from "./schema.ts";

/** A service an agent may be given: its address and token, by the variables a session reads them from. */
export interface Credential {
  /** Null for this service, whose address is the one a request came to. */
  url: string | null;
  /** Its address for a session on each of these hosts, by host id, in place of `url`. */
  urlByHost?: Readonly<Record<string, string>>;
  urlVar: string;
  tokenVar: string;
  token: TokenSource;
  /** Where on its address it serves MCP; null or absent for none. */
  mcp?: string | null;
  /** Older names of `urlVar` and `tokenVar`, set beside them so a session still reading those keeps working. */
  legacyVars?: { urlVar: string; tokenVar: string };
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

  /** `name`'s credential, by its name or a former one (ALIASES). */
  #get(name: string): Credential | undefined {
    return this.#known.get(name) ?? (ALIASES[name] ? this.#known.get(ALIASES[name]) : undefined);
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
    const unknown = names.filter((name) => !this.#get(name));
    if (!unknown.length) return null;
    const known = this.names;
    return `No credential is named ${unknown.join(", ")}; this stage has ${known.length ? known.join(", ") : "none"}.`;
  }

  /**
   * The addresses `names` are reached at by a session on host `hostId`, by
   * variable: a service's instance on that host when its `urlByHost` names
   * one, else its `url`. `self` is this service's own.
   */
  addresses(names: string[], self: string, hostId?: string): Record<string, string> {
    return Object.fromEntries(
      names.flatMap((name) => {
        const known = this.#get(name);
        if (!known) return [];
        const url = (hostId !== undefined && Object.hasOwn(known.urlByHost ?? {}, hostId) ? known.urlByHost![hostId] : known.url) ?? self;
        return [[known.urlVar, url], ...(known.legacyVars ? [[known.legacyVars.urlVar, url]] : [])];
      }),
    );
  }

  /**
   * The MCP servers of `names` that serve one, by name, their address and
   * token as references to the session's own variables, so no token is in them.
   * Each sends `x-actor` with `actor`, the agent's name, so a service that
   * records who wrote what (waypoint's history and comments) names the agent.
   */
  mcpServers(names: string[], actor: string): Record<string, McpServer> {
    return Object.fromEntries(
      names.flatMap((name) => {
        const known = this.#get(name);
        if (!known?.mcp) return [];
        const server: McpServer = { type: "http", url: `\${${known.urlVar}}${known.mcp}`, headers: { Authorization: `Bearer \${${known.tokenVar}}`, "x-actor": actor } };
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
        const known = this.#get(name);
        if (!known) return [];
        try {
          const value = await known.token.value();
          if (!value) return [];
          return [[known.tokenVar, value] as const, ...(known.legacyVars ? [[known.legacyVars.tokenVar, value] as const] : [])];
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

/** This service's name among the credentials a session is given. */
export const SELF = "agency";

/** Former names of credentials, still accepted: agency was called agent-service. */
export const ALIASES: Readonly<Record<string, string>> = { "agent-service": SELF };

/**
 * This service, which every stage has: the address a request came to, and the
 * stage's token, as AGENCY_URL and AGENCY_TOKEN, and as AG_URL and AG_TOKEN,
 * their names before agency was renamed, for sessions that still read those.
 */
export const selfCredential = (token: TokenSource): Credential => ({
  url: null,
  urlVar: "AGENCY_URL",
  tokenVar: "AGENCY_TOKEN",
  token,
  legacyVars: { urlVar: "AG_URL", tokenVar: "AG_TOKEN" },
});
