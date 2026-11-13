import type { SocketOutbound } from "./schema.ts";
import type { Connection, Store } from "./store.ts";

/** Sends one message to one socket; `gone` when the socket has closed for good. */
export interface Poster {
  post(connectionId: string, message: SocketOutbound): Promise<"sent" | "gone">;
}

/** Where there is no socket, such as `npm run dev`: nothing reaches a host, and pages poll. */
export const NO_SOCKET: Poster = { post: async () => "sent" };


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
    await this.#send((c) => c.kind === "viewer", messages);
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
