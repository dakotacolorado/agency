import { beforeEach, describe, expect, it } from "vitest";
import { AgencyApi } from "./api.ts";
import { LOST_AFTER } from "./domain.ts";
import { FakeStore } from "./fake-store.ts";
import type { Poster } from "./push.ts";
import type { Command, SocketOutbound } from "./schema.ts";
import { SocketHandler, type SocketEvent } from "./socket.ts";
import { Conflict } from "./store.ts";
import { sentView } from "./fleet.ts";

const NOW = new Date("2026-10-27T12:00:00.000Z");
const TOKEN = { value: async () => "secret" };

class FakePoster implements Poster {
  posts: { connectionId: string; message: SocketOutbound }[] = [];
  async post(connectionId: string, message: SocketOutbound) {
    this.posts.push({ connectionId, message });
    return "sent" as const;
  }
  to(connectionId: string) {
    return this.posts.filter((p) => p.connectionId === connectionId).map((p) => p.message);
  }
}

let store: FakeStore;
let poster: FakePoster;
let socket: SocketHandler;
let api: AgencyApi;
let now: Date;

beforeEach(() => {
  store = new FakeStore();
  poster = new FakePoster();
  now = NOW;
  api = new AgencyApi(store, TOKEN, { now: () => now, poster, socketUrl: "wss://socket.example/live" });
  socket = new SocketHandler(store, TOKEN, poster, () => now, undefined, (hostId, heartbeat) => api.beat(hostId, heartbeat));
});

const connect = (connectionId: string, query: Record<string, string>, headers: Record<string, string> = {}) =>
  socket.handle({
    requestContext: { connectionId, eventType: "CONNECT" },
    queryStringParameters: query,
    headers,
  });

const send = (connectionId: string, body: unknown) =>
  socket.handle({
    requestContext: { connectionId, eventType: "MESSAGE" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  } satisfies SocketEvent);

const http = (method: string, path: string, body?: unknown) =>
  api.fetch(
    new Request(`http://local${path}`, {
      method,
      headers: { Authorization: "Bearer secret", "Content-Type": "application/json" },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    }),
  );

const beat = (hostId = "laptop") => api.beat(hostId, { version: "0.1.0", labels: [] });

const asHost = (connectionId: string) => connect(connectionId, { hostId: "laptop" }, { Authorization: "Bearer secret" });

const ticket = async () => ((await (await http("POST", "/socket-tickets")).json()) as { ticket: string }).ticket;

describe("connecting", () => {
  it("takes a host by the stage's token and its id", async () => {
    expect(await connect("h1", { hostId: "laptop" }, { Authorization: "Bearer secret" })).toEqual({ statusCode: 200 });
    expect(await connect("h2", { hostId: "laptop" }, { authorization: "Bearer secret" })).toEqual({ statusCode: 200 });
    expect([...store.sockets.values()]).toEqual([
      { connectionId: "h1", kind: "host", hostId: "laptop", connectedAt: NOW.toISOString() },
      { connectionId: "h2", kind: "host", hostId: "laptop", connectedAt: NOW.toISOString() },
    ]);
  });

  it("refuses a host with the wrong token, a token in place of a ticket, or a bad id", async () => {
    expect((await connect("a", { hostId: "laptop" }, { Authorization: "Bearer wrong" })).statusCode).toBe(401);
    expect((await connect("b", { hostId: "laptop" })).statusCode).toBe(401);
    expect((await connect("c", { hostId: "not/a/host" }, { Authorization: "Bearer secret" })).statusCode).toBe(400);
    expect((await connect("d", {}, { Authorization: "Bearer secret" })).statusCode).toBe(401);
    expect(store.sockets.size).toBe(0);
  });

  it("takes a page by a ticket, once, within its minute", async () => {
    const first = await ticket();
    expect(await connect("page", { ticket: first })).toEqual({ statusCode: 200 });
    expect(store.sockets.get("page")).toEqual({ connectionId: "page", kind: "viewer", connectedAt: NOW.toISOString() });
    expect((await connect("again", { ticket: first })).statusCode).toBe(401);

    const late = await ticket();
    now = new Date(NOW.getTime() + 61_000);
    expect((await connect("late", { ticket: late })).statusCode).toBe(401);
    expect((await connect("forged", { ticket: "forged" })).statusCode).toBe(401);
    expect([...store.sockets.keys()]).toEqual(["page"]);
  });

  it("forgets a socket on disconnect", async () => {
    await connect("h1", { hostId: "laptop" }, { Authorization: "Bearer secret" });
    await socket.handle({ requestContext: { connectionId: "h1", eventType: "DISCONNECT" } });
    expect(store.sockets.size).toBe(0);
  });
});

describe("a host's report on its socket", () => {
  let id: string;
  let sessionId: string;

  beforeEach(async () => {
    await beat();
    const made = (await (
      await http("POST", "/agents", { name: "a", hostId: "laptop", brief: "Go." })
    ).json()) as { id: string; session: { id: string } };
    id = made.id;
    sessionId = made.session.id;
    await asHost("host");
    await connect("page", { ticket: await ticket() });
    await send("host", { type: "ping" });
    poster.posts = [];
  });

  it("reads again and is applied when it loses a race to another write", async () => {
    const commit = store.commit.bind(store);
    let lost = 0;
    store.commit = async (change) => {
      if (change.agents?.some((w) => w.id === id) && lost++ === 0) {
        throw new Conflict(id);
      }
      return commit(change);
    };
    const res = await send("host", { type: "report", agents: [{ id, state: "waiting", sessionId }], lines: [], commandResults: [] });
    expect(res.statusCode).toBe(200);
    expect(lost).toBe(2);
    expect(store.agents.get(id)!.state).toBe("waiting");
  });

  it("is applied, and pushed to viewers", async () => {
    const line = { agentId: id, sessionId, seq: 0, at: NOW.toISOString(), from: "agent", text: "On it." };
    const commands = store.commands.get("laptop")!.map((q) => q.command);
    await send("host", {
      type: "report",
      agents: [{ id, state: "waiting", sessionId }],
      lines: [line],
      commandResults: commands.map((c) => ({ commandId: c.id, ok: true })),
    });
    expect(store.agents.get(id)!.state).toBe("waiting");
    expect(store.commands.get("laptop")).toEqual([]);
    expect(poster.to("page")).toEqual([
      { type: "agent", agent: expect.objectContaining({ id, state: "waiting" }) },
      // The start carried its brief, so a conversation hears it was taken.
      { type: "sent", agentId: id, sent: expect.objectContaining({ command: expect.objectContaining({ kind: "start" }), delivery: "done" }) },
      { type: "lines", agentId: id, lines: [{ seq: 0, at: NOW.toISOString(), sessionId, from: "agent", text: "On it." }] },
    ]);
    expect(poster.to("host")).toEqual([]);
  });

  it("takes only what changed, and does not count as a heartbeat", async () => {
    const before = store.hosts.get("laptop")!.heartbeatAt;
    now = new Date(NOW.getTime() + 600_000);
    expect(await send("host", { type: "report", agents: [{ id, state: "waiting", sessionId }] })).toEqual({ statusCode: 200 });
    expect(store.agents.get(id)!.state).toBe("waiting");
    expect(store.hosts.get("laptop")!.heartbeatAt).toBe(before);
  });

  it("is refused from a page, and anything unreadable is answered with why", async () => {
    await send("page", { type: "report", agents: [{ id, state: "idle", sessionId }] });
    await send("host", "not json");
    await send("host", { type: "shout" });
    await send("host", { type: "report", agents: [{ id, state: "asleep", sessionId }] });
    expect(poster.to("page")).toEqual([{ type: "error", error: "Only a host's socket reports." }]);
    expect(poster.to("host").map((m) => m.type)).toEqual(["error", "error", "error"]);
    expect(store.agents.get(id)!.state).toBe("working");
  });

  it("takes a ping and says nothing back", async () => {
    expect(await send("host", { type: "ping" })).toEqual({ statusCode: 200 });
    expect(await send("page", { type: "ping" })).toEqual({ statusCode: 200 });
    expect(poster.posts).toEqual([]);
  });

  it("refuses a socket it has no record of", async () => {
    await send("stranger", { type: "ping" });
    expect(poster.to("stranger")).toEqual([{ type: "error", error: "This socket is not on record; reconnect." }]);
  });
});

describe("a report and a status said at once", () => {
  let id: string;
  let sessionId: string;

  const make = async (whenDone: string) => {
    await beat();
    const made = (await (
      await http("POST", "/agents", { name: "judge-1", hostId: "laptop", brief: "Rule.", whenDone })
    ).json()) as { id: string; session: { id: string } };
    id = made.id;
    sessionId = made.session.id;
    await asHost("host");
    await send("host", { type: "ping" });
    const commands = store.commands.get("laptop")!.map((q) => q.command);
    await send("host", {
      type: "report",
      agents: [{ id, state: "working", sessionId }],
      commandResults: commands.map((c) => ({ commandId: c.id, ok: true })),
    });
  };
  const line = (seq: number) => ({ agentId: id, sessionId, seq, at: NOW.toISOString(), from: "agent", text: "Posting the decision." });
  const done = () => http("PUT", `/agents/${id}/status`, { status: "done", summary: "Ruled merge.", headline: "Ruled" });
  /** Runs `between` once, after the next read of every agent and before what was read is written. */
  const afterListing = (between: () => Promise<unknown>) => {
    const list = store.listAgents.bind(store);
    let ran = false;
    store.listAgents = async () => {
      const read = await list();
      if (!ran) {
        ran = true;
        await between();
      }
      return read;
    };
  };
  const afterGetting = (between: () => Promise<unknown>) => {
    const get = store.getAgent.bind(store);
    let ran = false;
    store.getAgent = async (agentId) => {
      const read = await get(agentId);
      if (!ran && agentId === id) {
        ran = true;
        await between();
      }
      return read;
    };
  };

  it("keeps what was said between the report's read and its write", async () => {
    await make("keep");
    afterListing(async () => expect((await done()).status).toBe(200));
    await send("host", { type: "report", agents: [{ id, state: "working", sessionId, tasks: 1 }], lines: [line(0)] });
    expect(store.agents.get(id)).toMatchObject({
      state: "working",
      tasks: 1,
      status: "done",
      summary: "Ruled merge.",
      headline: "Ruled",
      saidAt: NOW.toISOString(),
      activity: { text: "Posting the decision." },
    });
  });

  it("deletes an agent made to delete when done is said mid-turn, as its turn ends", async () => {
    await make("delete");
    afterListing(async () => expect((await done()).status).toBe(200));
    await send("host", { type: "report", agents: [{ id, state: "working", sessionId }], lines: [line(0)] });
    expect(store.agents.get(id)).toMatchObject({ state: "working", status: "done" });
    await send("host", { type: "report", agents: [{ id, state: "waiting", sessionId }] });
    expect(store.agents.get(id)).toMatchObject({ state: "deleted", status: "done" });
  });

  it("deletes it when done is said while the report of its turn's end is being written", async () => {
    await make("delete");
    afterListing(async () => expect((await done()).status).toBe(200));
    await send("host", { type: "report", agents: [{ id, state: "waiting", sessionId }] });
    expect(store.agents.get(id)).toMatchObject({ state: "deleted", status: "done" });
  });

  it("deletes it when its turn's end is reported while done is being written", async () => {
    await make("delete");
    afterGetting(() => send("host", { type: "report", agents: [{ id, state: "waiting", sessionId }] }));
    expect((await done()).status).toBe(200);
    expect(store.agents.get(id)).toMatchObject({ state: "deleted", status: "done" });
  });

  it("deletes it when its session ends while it reads done", async () => {
    await make("delete");
    expect((await done()).status).toBe(200);
    await send("host", { type: "report", agents: [{ id, state: "interrupted", sessionId }] });
    expect(store.agents.get(id)).toMatchObject({ state: "deleted", status: "done" });
  });
});

describe("replaying a host's queue to a socket that connects", () => {
  let id: string;
  let sessionId: string;

  beforeEach(async () => {
    await beat();
    const made = (await (
      await http("POST", "/agents", { name: "a", hostId: "laptop", brief: "Go." })
    ).json()) as { id: string; session: { id: string } };
    id = made.id;
    sessionId = made.session.id;
    await http("POST", `/agents/${id}/messages`, { text: "And this." });
    await beat("desktop");
    await http("POST", "/agents", { name: "b", hostId: "desktop" });
    poster.posts = [];
  });

  const kinds = (connectionId: string) =>
    poster.to(connectionId).map((m) => (m.type === "command" ? m.command.kind : m.type));

  it("posts nothing in $connect, which API Gateway would refuse, and replays on the first message", async () => {
    await asHost("host");
    expect(poster.posts).toEqual([]);
    await send("host", { type: "ping" });
    // A start goes with the tokens its record leaves out.
    const sealed = (command: Command) => (command.kind === "start" ? { ...command, secrets: { AGENCY_TOKEN: "secret", AG_TOKEN: "secret" } } : command);
    expect(poster.to("host")).toEqual(store.commands.get("laptop")!.map((q) => ({ type: "command", command: sealed(q.command) })));
    expect(kinds("host")).toEqual(["create", "start", "message"]);
  });

  it("replays once per socket, to that socket alone, and again to a socket that reconnects", async () => {
    await asHost("old");
    await send("old", { type: "ping" });
    await asHost("new");
    await send("new", { type: "report", agents: [] });
    await send("new", { type: "ping" });
    await send("old", { type: "ping" });
    expect(kinds("old")).toEqual(["create", "start", "message"]);
    expect(kinds("new")).toEqual(["create", "start", "message"]);
  });

  it("leaves out what the first report names", async () => {
    const [home] = store.commands.get("laptop")!;
    poster.posts = [];
    await asHost("host");
    await send("host", {
      type: "report",
      agents: [{ id, state: "working", sessionId }],
      commandResults: [{ commandId: home!.command.id, ok: true }],
    });
    expect(kinds("host")).toEqual(["start", "message"]);
  });

  it("leaves out what was withdrawn, and keeps a create however late", async () => {
    now = new Date(NOW.getTime() + (LOST_AFTER + 1) * 1000);
    await asHost("host");
    await send("host", { type: "ping" });
    expect(kinds("host")).toEqual(["create"]);
  });

  it("replays nothing to a page, or to a socket whose first message is unreadable", async () => {
    await connect("page", { ticket: await ticket() });
    await send("page", { type: "ping" });
    await asHost("host");
    await send("host", "not json");
    expect(poster.to("page")).toEqual([]);
    expect(kinds("host")).toEqual(["error"]);
    await send("host", { type: "ping" });
    expect(kinds("host")).toEqual(["error", "create", "start", "message"]);
  });
});

describe("a message to a live session", () => {
  let id: string;
  let sessionId: string;
  let messageId: string;

  const commands = async () =>
    (await store.sentTo(id)).map((sent) => sentView(sent, now));
  const message = async () => (await commands()).find((c) => c.command.id === messageId)!;
  const sentPushes = () => poster.to("page").filter((m) => m.type === "sent");

  beforeEach(async () => {
    await beat();
    const made = (await (await http("POST", "/agents", { name: "a", hostId: "laptop", brief: "Go." })).json()) as {
      id: string;
      session: { id: string };
    };
    id = made.id;
    sessionId = made.session.id;
    await asHost("host");
    await connect("page", { ticket: await ticket() });
    await connect("other", { ticket: await ticket() });
    await send("host", { type: "ping" });
    const started = store.commands.get("laptop")!.map((q) => q.command);
    await send("host", {
      type: "report",
      agents: [{ id, state: "working", sessionId }],
      commandResults: started.map((c) => ({ commandId: c.id, ok: true })),
    });
    poster.posts = [];
    const res = await http("POST", `/agents/${id}/messages`, { text: "use main" });
    messageId = ((await res.json()) as { commandId: string }).commandId;
  });

  it("is pushed to every viewer the moment it is queued", async () => {
    for (const viewer of ["page", "other"]) {
      expect(poster.to(viewer).filter((m) => m.type === "sent")).toEqual([
        {
          type: "sent",
          agentId: id,
          sent: expect.objectContaining({ command: expect.objectContaining({ id: messageId, text: "use main" }), delivery: "queued" }),
        },
      ]);
    }
  });

  it("is done once its host reports it delivered, and rejected when its host could not", async () => {
    expect((await message()).delivery).toBe("queued");
    await send("host", { type: "report", commandResults: [{ commandId: messageId, ok: true }] });
    expect(await message()).toMatchObject({ delivery: "done", error: null });
    expect(sentPushes().at(-1)).toMatchObject({ sent: { delivery: "done" } });
    const again = ((await (await http("POST", `/agents/${id}/messages`, { text: "and this" })).json()) as { commandId: string }).commandId;
    await send("host", { type: "report", commandResults: [{ commandId: again, ok: false, error: "no live session" }] });
    expect((await commands()).find((c) => c.command.id === again)).toMatchObject({ delivery: "rejected", error: "no live session" });
  });
});

describe("a heartbeat up a host's socket", () => {
  it("registers the host and keeps it connected, and is refused from a page", async () => {
    await asHost("host");
    await send("host", { type: "report", agents: [], commandResults: [], lines: [] });
    expect((await send("host", { type: "heartbeat", version: "0.2.0", labels: ["linux"], capacity: 2 })).statusCode).toBe(200);
    expect(store.hosts.get("laptop")).toMatchObject({ version: "0.2.0", labels: ["linux"], capacity: 2, heartbeatAt: NOW.toISOString() });
    await connect("page", { ticket: await ticket() });
    await send("page", { type: "heartbeat", version: "0.2.0" });
    expect(poster.to("page").at(-1)).toEqual({ type: "error", error: "Only a host's socket reports." });
  });
});

describe("the account's usage, as hosts report it", () => {
  const reading = (readAt: string, fiveHour?: number, sevenDay?: number) => ({
    readAt,
    ...(fiveHour !== undefined && { fiveHour: { utilization: fiveHour, resetsAt: "2026-10-27T15:00:00.000Z" } }),
    ...(sevenDay !== undefined && { sevenDay: { utilization: sevenDay, resetsAt: "2026-11-01T00:00:00.000Z" } }),
  });
  const usage = async () => (await http("GET", "/usage")).json();
  const asOtherHost = (connectionId: string) =>
    connect(connectionId, { hostId: "desktop" }, { Authorization: "Bearer secret" });

  beforeEach(async () => {
    await beat();
    await asHost("h1");
    await asOtherHost("h2");
  });

  it("reads empty, every field null, before any host reports it", async () => {
    const res = await http("GET", "/usage");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ readAt: null, fiveHour: null, sevenDay: null, limitOn: true });
  });

  it("serves the newest reading with when it was read and by whom", async () => {
    await send("h1", { type: "report", usage: reading("2026-10-27T11:59:00Z", 0.35, 0.31) });
    expect(await usage()).toEqual({
      readAt: "2026-10-27T11:59:00.000Z",
      fiveHour: { utilization: 0.35, resetsAt: "2026-10-27T15:00:00.000Z", readAt: "2026-10-27T11:59:00.000Z", hostId: "laptop" },
      sevenDay: { utilization: 0.31, resetsAt: "2026-11-01T00:00:00.000Z", readAt: "2026-10-27T11:59:00.000Z", hostId: "laptop" },
      limitOn: true,
    });
  });

  it("never lets an older reading replace a newer one, whichever host sends it", async () => {
    await send("h2", { type: "report", usage: reading("2026-10-27T11:59:00.000Z", 0.4, 0.3) });
    await send("h1", { type: "report", usage: reading("2026-10-27T11:58:00.000Z", 0.1, 0.1) });
    await send("h2", { type: "report", usage: reading("2026-10-27T11:59:00.000Z", 0.2, 0.2) });
    const read = (await usage()) as { fiveHour: { utilization: number; hostId: string }; sevenDay: { utilization: number } };
    expect(read.fiveHour).toMatchObject({ utilization: 0.4, hostId: "desktop" });
    expect(read.sevenDay.utilization).toBe(0.3);

    await send("h1", { type: "report", usage: reading("2026-10-27T12:00:00.000Z", 0.5, 0.35) });
    expect(await usage()).toMatchObject({
      readAt: "2026-10-27T12:00:00.000Z",
      fiveHour: { utilization: 0.5, hostId: "laptop" },
      sevenDay: { utilization: 0.35, hostId: "laptop" },
    });
  });

  it("keeps a window a reading leaves out as it was", async () => {
    await send("h1", { type: "report", usage: reading("2026-10-27T11:00:00.000Z", 0.3, 0.2) });
    await send("h2", { type: "report", usage: reading("2026-10-27T11:30:00.000Z", 0.4) });
    expect(await usage()).toMatchObject({
      readAt: "2026-10-27T11:30:00.000Z",
      fiveHour: { utilization: 0.4, readAt: "2026-10-27T11:30:00.000Z" },
      sevenDay: { utilization: 0.2, readAt: "2026-10-27T11:00:00.000Z" },
    });
  });

  it("is pushed to viewers when a reading is kept, and not when it is ignored", async () => {
    await connect("page", { ticket: await ticket() });
    await send("h1", { type: "report", usage: reading("2026-10-27T11:59:00.000Z", 0.35, 0.31) });
    await send("h2", { type: "report", usage: reading("2026-10-27T11:00:00.000Z", 0.1, 0.1) });
    const pushed = poster.to("page").filter((m) => m.type === "usage");
    expect(pushed).toEqual([{ type: "usage", usage: await usage() }]);
  });

  it("refuses a report whose reading is malformed, with why", async () => {
    await send("h1", { type: "report", usage: { readAt: "yesterday", fiveHour: { utilization: -1, resetsAt: "2026-10-27T15:00:00.000Z" } } });
    expect(poster.to("h1").at(-1)).toMatchObject({ type: "error" });
    expect(await usage()).toEqual({ readAt: null, fiveHour: null, sevenDay: null, limitOn: true });
  });
});

describe("the tokens an agent's sessions used, as its host reports them", () => {
  let id: string;
  let sessionId: string;
  const totals = (input: number, output: number, write: number, read: number) => ({
    inputTokens: input,
    outputTokens: output,
    cacheCreationInputTokens: write,
    cacheReadInputTokens: read,
  });
  const tokensOf = async (agentId = id) =>
    ((await (await http("GET", `/agents/${agentId}`)).json()) as { tokens: unknown }).tokens;
  const report = (session: string, counts: ReturnType<typeof totals>, agentId = id) =>
    send("host", { type: "report", tokens: [{ agentId, sessionId: session, ...counts }] });

  beforeEach(async () => {
    await beat();
    const made = (await (
      await http("POST", "/agents", { name: "a", hostId: "laptop", brief: "Go.", item: "ca147da6" })
    ).json()) as { id: string; session: { id: string } };
    id = made.id;
    sessionId = made.session.id;
    await asHost("host");
    await send("host", { type: "ping" });
  });

  it("reads every count 0 before anything is reported", async () => {
    expect(await tokensOf()).toEqual(totals(0, 0, 0, 0));
  });

  it("sums the running totals of every session", async () => {
    await report(sessionId, totals(10, 200, 3000, 40000));
    await report(sessionId, totals(12, 250, 3100, 50000));
    const other = "7c3e1d2a-5b6f-4a8e-9c0d-1e2f3a4b5c6d";
    await report(other, totals(1, 2, 3, 4));
    expect(await tokensOf()).toEqual(totals(13, 252, 3103, 50004));
  });

  it("does not add a total sent again, nor one lower than the one held", async () => {
    await report(sessionId, totals(12, 250, 3100, 50000));
    await report(sessionId, totals(12, 250, 3100, 50000));
    await report(sessionId, totals(10, 200, 3000, 40000));
    expect(await tokensOf()).toEqual(totals(12, 250, 3100, 50000));
  });

  it("is kept on a deleted agent, and listed with it by item", async () => {
    await report(sessionId, totals(5, 6, 7, 8));
    expect((await http("DELETE", `/agents/${id}`)).status).toBe(202);
    await report(sessionId, totals(9, 10, 11, 12));
    const listed = (await (await http("GET", "/agents?item=ca147da6")).json()) as {
      agents: { id: string; state: string; tokens: unknown }[];
    };
    expect(listed.agents).toMatchObject([{ id, state: "deleted", tokens: totals(9, 10, 11, 12) }]);
  });

  it("ignores totals for an agent on another host", async () => {
    await beat("desktop");
    const other = (await (await http("POST", "/agents", { name: "b", hostId: "desktop" })).json()) as { id: string };
    await report(sessionId, totals(1, 1, 1, 1), other.id);
    expect(await tokensOf(other.id)).toEqual(totals(0, 0, 0, 0));
  });

  it("refuses a negative count, with why", async () => {
    await report(sessionId, totals(-1, 0, 0, 0));
    expect(poster.to("host").at(-1)).toMatchObject({ type: "error" });
    expect(await tokensOf()).toEqual(totals(0, 0, 0, 0));
  });
});
