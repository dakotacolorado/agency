import type { TokenSource } from "./api.ts";
import { withdrawn } from "./domain.ts";
import { hash, same } from "./secret.ts";
import { Credentials, selfCredential, type Credential } from "./credentials.ts";
import { Fleet } from "./fleet.ts";
import { Push, type Poster } from "./push.ts";
import { SocketInboundSchema, type SocketInbound } from "./schema.ts";
import type { Connection, Store } from "./store.ts";

/** A socket's connecting, closing or message, as `ws-server.ts` hands it over. */
export interface SocketEvent {
  requestContext: {
    connectionId: string;
    eventType: "CONNECT" | "DISCONNECT" | "MESSAGE";
    domainName?: string;
    stage?: string;
  };
  headers?: Record<string, string | undefined> | null;
  queryStringParameters?: Record<string, string | undefined> | null;
  body?: string | null;
}

export interface SocketResult {
  statusCode: number;
  body?: string;
}

const HOST_ID = /^[A-Za-z0-9._-]{1,64}$/;

/**
 * One handler for every event: connecting decides who a socket is, closing
 * forgets it, and anything else is a message, told apart by its `type`. What
 * a message's handling says back goes as a post to its socket.
 */
export class SocketHandler {
  private readonly store: Store;
  private readonly token: TokenSource;
  private readonly now: () => Date;
  private readonly fleet: Fleet;

  constructor(
    store: Store,
    token: TokenSource,
    poster: Poster,
    now: () => Date = () => new Date(),
    credentials: Record<string, Credential> = { "agent-service": selfCredential(token) },
  ) {
    this.store = store;
    this.token = token;
    this.now = now;
    this.fleet = new Fleet(store, new Push(store, poster), now, new Credentials(credentials));
  }

  async handle(event: SocketEvent): Promise<SocketResult> {
    const { connectionId, eventType } = event.requestContext;
    if (eventType === "CONNECT") return this.connect(connectionId, event);
    if (eventType === "DISCONNECT") {
      await this.store.deleteConnection(connectionId);
      return { statusCode: 200 };
    }
    return this.message(connectionId, event.body ?? "");
  }

  /**
   * A host by the stage's token in its header, as on its heartbeat; a page by
   * a ticket, since a browser cannot set one. Refused before anything is
   * stored. Nothing is posted here; see `replay`.
   */
  private async connect(connectionId: string, event: SocketEvent): Promise<SocketResult> {
    const query = event.queryStringParameters ?? {};
    const connectedAt = this.now().toISOString();
    if (query.hostId !== undefined) {
      const token = await this.token.value();
      if (!token) return { statusCode: 503, body: "API token is not configured." };
      const presented = header(event, "authorization") ?? "";
      if (!same(presented, `Bearer ${token}`)) return { statusCode: 401, body: "Unauthorized." };
      if (!HOST_ID.test(query.hostId)) return { statusCode: 400, body: "hostId: not a host id." };
      await this.store.putConnection({ connectionId, kind: "host", hostId: query.hostId, connectedAt });
      return { statusCode: 200 };
    }
    if (query.ticket !== undefined) {
      const validUntil = await this.store.takeTicket(hash(query.ticket));
      if (!validUntil || Date.parse(validUntil) < this.now().getTime()) {
        return { statusCode: 401, body: "This ticket is spent, expired, or was never issued." };
      }
      await this.store.putConnection({ connectionId, kind: "viewer", connectedAt });
      return { statusCode: 200 };
    }
    return { statusCode: 401, body: "Connect with ?hostId= and a bearer token, or with ?ticket=." };
  }

  private async message(connectionId: string, body: string): Promise<SocketResult> {
    const refuse = async (error: string) => {
      await this.fleet.push.toConnection(connectionId, { type: "error", error });
      return { statusCode: 200 };
    };
    const connection = await this.store.getConnection(connectionId);
    if (!connection) return refuse("This socket is not on record; reconnect.");
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      return refuse("A message is JSON.");
    }
    const result = SocketInboundSchema.safeParse(parsed);
    if (!result.success) {
      return refuse(
        result.error.issues
          .map((i) => (i.path.length ? `${i.path.join(".")}: ${i.message}` : i.message))
          .join("; "),
      );
    }
    const message = result.data;
    if (connection.kind === "host") await this.replay(connection, message);
    if (message.type === "ping") return { statusCode: 200 };
    if (connection.kind !== "host") return refuse("Only a host's socket reports.");
    const { agents = [], lines = [], commandResults = [], tokens = [], usage } = message;
    await this.fleet.report(connection.hostId!, { agents, lines, commandResults, tokens });
    if (usage) await this.fleet.reportUsage(connection.hostId!, usage);
    return { statusCode: 200 };
  }

  /**
   * Every command still pending for the host, oldest first, once per socket.
   * Sent on the first message the host sends, which on connecting is its full
   * report, rather than on connecting, so that report can say what it already
   * did, and a host that connects and says nothing is sent nothing. Commands
   * that message reports are left out, as done; it is replayed before the
   * report is applied, so what applying it queues is pushed once, not twice.
   */
  private async replay(connection: Connection, first: SocketInbound): Promise<void> {
    if (!(await this.store.claimReplay(connection.connectionId, this.now().toISOString()))) return;
    const reported = new Set(first.type === "report" ? (first.commandResults ?? []).map((r) => r.commandId) : []);
    const now = this.now();
    const pending = (await this.store.pending(connection.hostId!)).filter(
      (queued) => !withdrawn(queued, now) && !reported.has(queued.command.id),
    );
    const commands = await Promise.all(
      pending.map(async ({ command }) => ({ type: "command" as const, command: await this.fleet.credentials.seal(command) })),
    );
    await this.fleet.push.toConnection(connection.connectionId, ...commands);
  }
}

function header(event: SocketEvent, name: string): string | undefined {
  const found = Object.entries(event.headers ?? {}).find(([key]) => key.toLowerCase() === name);
  return found?.[1];
}
