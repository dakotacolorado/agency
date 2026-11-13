import { randomUUID } from "node:crypto";
import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocket, WebSocketServer } from "ws";
import type { Poster } from "./push.ts";
import type { SocketOutbound } from "./schema.ts";
import type { SocketHandler } from "./socket.ts";

/** Where the socket is served, on the API's own address. */
export const SOCKET_PATH = "/socket";

/**
 * The most a message up may be: a host's full report on reconnecting, its
 * lines cut to fit the 128 KB a message once could be, well inside it.
 */
export const MAX_PAYLOAD = 1024 * 1024;

/** Seconds between the server's pings: a socket that misses one is closed, so a host's dropped link is found. */
export const PING_SECONDS = 30;

/**
 * The sockets this process holds, by connection id: posts to them, as the
 * API and the socket handler both push, and nothing else.
 */
export class Sockets implements Poster {
  readonly #open = new Map<string, WebSocket>();

  add(connectionId: string, socket: WebSocket): void {
    this.#open.set(connectionId, socket);
  }

  delete(connectionId: string): void {
    this.#open.delete(connectionId);
  }

  get size(): number {
    return this.#open.size;
  }

  async post(connectionId: string, message: SocketOutbound): Promise<"sent" | "gone"> {
    const socket = this.#open.get(connectionId);
    if (!socket || socket.readyState !== WebSocket.OPEN) return "gone";
    await new Promise<void>((done, fail) => socket.send(JSON.stringify(message), (err) => (err ? fail(err) : done())));
    return "sent";
  }

  closeAll(): void {
    for (const socket of this.#open.values()) socket.terminate();
    this.#open.clear();
  }
}

/**
 * Serves `handler` as a WebSocket at `SOCKET_PATH` on `server`. A socket is
 * accepted only once the handler's connect says so, so one refused is
 * answered with its status and never opened. Each socket's messages are
 * handled one at a time, in the order they came, as a host sends them.
 */
export function serveSockets(server: Server, handler: SocketHandler, sockets: Sockets, log: (line: string) => void = console.error): () => void {
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD });
  const alive = new WeakSet<WebSocket>();

  const upgrade = async (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const url = new URL(req.url ?? "/", "http://socket");
    if (url.pathname !== SOCKET_PATH) return refuse(socket, 404, "Not found.");
    const connectionId = randomUUID();
    const headers = Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k, Array.isArray(v) ? v.join(", ") : v]));
    let connected;
    try {
      connected = await handler.handle({
        requestContext: { connectionId, eventType: "CONNECT" },
        headers,
        queryStringParameters: Object.fromEntries(url.searchParams),
      });
    } catch (err) {
      log(`socket connect failed: ${(err as Error).message}`);
      return refuse(socket, 500, "Internal error.");
    }
    if (connected.statusCode !== 200) return refuse(socket, connected.statusCode, connected.body ?? "Refused.");
    wss.handleUpgrade(req, socket, head, (ws) => {
      sockets.add(connectionId, ws);
      alive.add(ws);
      let turn = Promise.resolve();
      const handle = (eventType: "MESSAGE" | "DISCONNECT", body?: string) => {
        turn = turn
          .then(() => handler.handle({ requestContext: { connectionId, eventType }, body: body ?? null }))
          .then(
            () => {},
            (err) => log(`socket ${eventType.toLowerCase()} failed: ${(err as Error).message}`),
          );
      };
      ws.on("pong", () => alive.add(ws));
      ws.on("message", (data) => handle("MESSAGE", data.toString()));
      ws.on("close", () => {
        sockets.delete(connectionId);
        handle("DISCONNECT");
      });
      ws.on("error", (err) => log(`socket ${connectionId}: ${err.message}`));
    });
  };

  const onUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer) => void upgrade(req, socket, head);
  server.on("upgrade", onUpgrade);

  const pinging = setInterval(() => {
    for (const ws of wss.clients) {
      if (!alive.has(ws)) {
        ws.terminate();
        continue;
      }
      alive.delete(ws);
      ws.ping();
    }
  }, PING_SECONDS * 1000);
  pinging.unref();

  return () => {
    clearInterval(pinging);
    server.off("upgrade", onUpgrade);
    sockets.closeAll();
    wss.close();
  };
}

const REASONS: Record<number, string> = { 400: "Bad Request", 401: "Unauthorized", 404: "Not Found", 500: "Internal Server Error", 503: "Service Unavailable" };

function refuse(socket: Duplex, status: number, body: string): void {
  socket.end(`HTTP/1.1 ${status} ${REASONS[status] ?? "Refused"}\r\nContent-Type: text/plain\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`);
}
