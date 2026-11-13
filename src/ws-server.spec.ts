import { serve, type ServerType } from "@hono/node-server";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import type { SocketOutbound } from "./schema.ts";
import { start, type Running } from "./server.ts";

const TOKEN = "t";
let running: Running;
let server: ServerType;
let url: string;
const open: WebSocket[] = [];

beforeEach(async () => {
  running = start({ db: ":memory:", token: TOKEN, services: {} });
  server = await new Promise<ServerType>((ready) => {
    const s = serve({ fetch: running.api.fetch, hostname: "127.0.0.1", port: 0 }, () => ready(s));
  });
  running.listen(server as Server);
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  for (const ws of open.splice(0)) ws.terminate();
  running.close();
  await new Promise((done) => server.close(done));
});

const call = async (method: string, path: string, body?: unknown) => {
  const res = await fetch(`${url}${path}`, {
    method,
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });
  return { status: res.status, body: (await res.json()) as any };
};

/** A socket and every message it was sent, once it is open; or the status it was refused with. */
const connect = (socketUrl: string, headers: Record<string, string> = {}) =>
  new Promise<{ ws: WebSocket; got: SocketOutbound[] } | { refused: number }>((done) => {
    const ws = new WebSocket(socketUrl, { headers });
    open.push(ws);
    const got: SocketOutbound[] = [];
    ws.on("message", (data) => got.push(JSON.parse(data.toString()) as SocketOutbound));
    ws.on("open", () => done({ ws, got }));
    ws.on("error", () => {});
    ws.on("unexpected-response", (_req, res) => done({ refused: res.statusCode ?? 0 }));
  });

const until = async (check: () => boolean, what: string) => {
  for (let i = 0; i < 100 && !check(); i++) await new Promise((r) => setTimeout(r, 20));
  expect(check(), what).toBe(true);
};

const beat = async () => {
  const res = await call("POST", "/hosts/laptop/heartbeat", { version: "test", labels: [], capacity: 2 });
  expect(res.status).toBe(200);
  return res.body.socketUrl as string;
};

describe("the socket", () => {
  it("is served on the API's own address, as the heartbeat says", async () => {
    expect(await beat()).toBe(`${url.replace("http", "ws")}/socket`);
  });

  it("refuses a host without the token, and a page without a ticket, before it opens", async () => {
    const socketUrl = await beat();
    expect(await connect(`${socketUrl}?hostId=laptop`, { authorization: "Bearer wrong" })).toEqual({ refused: 401 });
    expect(await connect(`${socketUrl}?ticket=never-issued`)).toEqual({ refused: 401 });
    expect(await connect(socketUrl)).toEqual({ refused: 401 });
    expect(await connect(`${url.replace("http", "ws")}/elsewhere?hostId=laptop`, { authorization: `Bearer ${TOKEN}` })).toEqual({ refused: 404 });
  });

  it("delivers a command written while its host was offline once it reconnects, and the report back reaches the agent", async () => {
    const socketUrl = await beat();
    const made = await call("POST", "/agents", { name: "ana", hostId: "laptop", brief: "Go." });
    expect(made.status).toBe(201);
    const host = await connect(`${socketUrl}?hostId=laptop`, { authorization: `Bearer ${TOKEN}` });
    if (!("ws" in host)) throw new Error(`refused ${host.refused}`);
    // Nothing is replayed until the host's first message, its full report.
    host.ws.send(JSON.stringify({ type: "report", agents: [], lines: [], commandResults: [] }));
    await until(() => host.got.length === 2, "both commands replayed");
    const [create, begin] = host.got.map((m) => (m.type === "command" ? m.command : null));
    expect([create?.kind, begin?.kind]).toEqual(["create", "start"]);
    expect(begin).toMatchObject({ agentId: made.body.id, text: "Go." });
    if (begin?.kind !== "start") throw new Error("no start");
    host.ws.send(
      JSON.stringify({
        type: "report",
        agents: [{ id: made.body.id, state: "waiting", sessionId: begin.sessionId }],
        lines: [{ agentId: made.body.id, seq: 0, at: new Date().toISOString(), sessionId: begin.sessionId, from: "agent", text: "Done." }],
        commandResults: [
          { commandId: create!.id, ok: true },
          { commandId: begin.id, ok: true },
        ],
      }),
    );
    let agent = await call("GET", `/agents/${made.body.id}`);
    for (let i = 0; i < 50 && agent.body.state !== "waiting"; i++) agent = await call("GET", `/agents/${made.body.id}`);
    expect(agent.body).toMatchObject({ state: "waiting", hostStatus: "connected", activity: { text: "Done." } });
    const commands = await call("GET", `/agents/${made.body.id}/commands`);
    expect(commands.body.commands.map((c: { delivery: string }) => c.delivery)).toEqual(["done", "done"]);
    // A command written now goes down the open socket at once.
    expect((await call("POST", `/agents/${made.body.id}/messages`, { text: "And then?" })).status).toBe(202);
    await until(() => host.got.length === 3, "the message pushed");
    expect(host.got[2]).toMatchObject({ type: "command", command: { kind: "message", text: "And then?" } });
  });

  it("pushes an agent's change to a page holding a ticket, without polling", async () => {
    await beat();
    const made = await call("POST", "/agents", { name: "ana", hostId: "laptop" });
    const ticket = await call("POST", "/socket-tickets");
    expect(ticket.status).toBe(201);
    const page = await connect(`${ticket.body.socketUrl}?ticket=${ticket.body.ticket}`);
    if (!("ws" in page)) throw new Error(`refused ${page.refused}`);
    expect((await call("PATCH", `/agents/${made.body.id}`, { label: "renamed" })).status).toBe(200);
    await until(() => page.got.some((m) => m.type === "agent" && m.agent.label === "renamed"), "the agent pushed");
    // A ticket is good once.
    expect(await connect(`${ticket.body.socketUrl}?ticket=${ticket.body.ticket}`)).toEqual({ refused: 401 });
  });

  it("forgets a socket once it closes", async () => {
    const socketUrl = await beat();
    const host = await connect(`${socketUrl}?hostId=laptop`, { authorization: `Bearer ${TOKEN}` });
    if (!("ws" in host)) throw new Error(`refused ${host.refused}`);
    expect((await running.store.connections()).map((c) => c.hostId)).toEqual(["laptop"]);
    host.ws.close();
    for (let i = 0; i < 50 && (await running.store.connections()).length; i++) await new Promise((r) => setTimeout(r, 20));
    expect(await running.store.connections()).toEqual([]);
  });
});
