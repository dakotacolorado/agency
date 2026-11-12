import type { SocketOutbound } from "./schema.ts";
import type { Connection, Store } from "./store.ts";

/** Sends one message to one socket; `gone` when the socket has closed for good. */
export interface Poster {
  post(connectionId: string, message: SocketOutbound): Promise<"sent" | "gone">;
}

/** Where there is no socket, such as `npm run dev`: nothing reaches a host, and pages poll. */
export const NO_SOCKET: Poster = { post: async () => "sent" };

/**
 * The most one socket message carries, as API Gateway's limit was, which
 * the host's own cuts are sized for. Lines are split to stay under it; a
 * single message still over it is dropped, which a viewer can bear, since
 * the routes hold everything. `TEXT_LIMIT` keeps every command under it.
 */
export const MESSAGE_LIMIT = 120 * 1024;

/**
 * Best effort, always: the queue and the table are the truth, and a command
 * still queued is replayed to its host's next socket, so a post that fails is
 * logged and never fails the request that caused it. A socket found gone is
 * forgotten.
 */
export class Push {
  readonly #store: Store;
  readonly #poster: Poster;

  constructor(store: Store, poster: Poster) {
    this.#store = store;
    this.#poster = poster;
  }

  async toHost(hostId: string, messages: SocketOutbound[]): Promise<void> {
    if (!messages.length) return;
    await this.#send((c) => c.kind === "host" && c.hostId === hostId, messages);
  }

  async toViewers(messages: SocketOutbound[]): Promise<void> {
    if (!messages.length) return;
    await this.#send((c) => c.kind === "viewer", messages.flatMap(split));
  }

  /** In order, stopping at a socket found gone. */
  async toConnection(connectionId: string, ...messages: SocketOutbound[]): Promise<void> {
    for (const message of messages) {
      if ((await this.#post(connectionId, message)) === "gone") return;
    }
  }

  async #send(to: (c: Connection) => boolean, messages: SocketOutbound[]): Promise<void> {
    let connections: Connection[];
    try {
      connections = (await this.#store.connections()).filter(to);
    } catch (err) {
      console.error("Could not read socket connections:", err);
      return;
    }
    await Promise.all(
      connections.map(async ({ connectionId }) => {
        for (const message of messages) {
          if ((await this.#post(connectionId, message)) === "gone") return;
        }
      }),
    );
  }

  async #post(connectionId: string, message: SocketOutbound): Promise<"sent" | "gone"> {
    try {
      const result = await this.#poster.post(connectionId, message);
      if (result === "gone") await this.#store.deleteConnection(connectionId);
      return result;
    } catch (err) {
      console.error(`Could not push ${message.type} to ${connectionId}:`, err);
      return "sent";
    }
  }
}

const size = (message: unknown) => Buffer.byteLength(JSON.stringify(message));

function split(message: SocketOutbound): SocketOutbound[] {
  if (size(message) <= MESSAGE_LIMIT) return [message];
  if (message.type === "sent") {
    // A start's context is what makes it large; a viewer wanting it reads `listWorkerCommands`.
    const { context: _, documents: __, ...command } = message.sent.command as typeof message.sent.command & {
      context?: unknown;
      documents?: unknown;
    };
    return [{ ...message, sent: { ...message.sent, command: command as typeof message.sent.command } }];
  }
  if (message.type !== "lines") return [message];
  const parts: SocketOutbound[] = [];
  let lines: typeof message.lines = [];
  for (const line of message.lines) {
    if (lines.length && size({ ...message, lines: [...lines, line] }) > MESSAGE_LIMIT) {
      parts.push({ ...message, lines });
      lines = [];
    }
    lines.push(line);
  }
  if (lines.length) parts.push({ ...message, lines });
  return parts;
}
