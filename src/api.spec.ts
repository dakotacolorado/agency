import { beforeEach, describe, expect, it } from "vitest";
import { AgentServiceApi, type TokenSource } from "./api.ts";
import {
  HEADLINE_LIMIT,
  HEARTBEAT_INTERVAL,
  KEPT_FOR,
  LABEL_LIMIT,
  LINE_LIMIT,
  LOST_AFTER,
  SUMMARY_LIMIT,
  TEXT_LIMIT,
  TITLE_LIMIT,
} from "./domain.ts";
import { hash } from "./secret.ts";
import { FakeStore } from "./fake-store.ts";
import type { Poster } from "./push.ts";
import type { Command, SocketOutbound } from "./schema.ts";
import { SocketHandler } from "./socket.ts";
import { CONTEXT_LIMIT, FETCH_LIMIT, type ContextSource, type Read } from "./context.ts";
import type { Credential } from "./credentials.ts";
import type { AgentSecrets } from "./agent-secrets.ts";
import { SEEDED_ROLES, type Role } from "./roles.ts";

const TOKEN = { value: async () => "secret" } satisfies TokenSource;
const NOW = new Date("2026-10-27T12:00:00.000Z");
const SOCKET = "wss://socket.example/live";

/** Records every post, by connection; a connection in `gone` answers as closed. */
class FakePoster implements Poster {
  posts: { connectionId: string; message: SocketOutbound }[] = [];
  gone = new Set<string>();

  async post(connectionId: string, message: SocketOutbound) {
    if (this.gone.has(connectionId)) return "gone" as const;
    this.posts.push({ connectionId, message });
    return "sent" as const;
  }

  to(connectionId: string) {
    return this.posts.filter((p) => p.connectionId === connectionId).map((p) => p.message);
  }
}

let store: FakeStore;
let poster: FakePoster;
let api: AgentServiceApi;
let now: Date;

beforeEach(() => {
  store = new FakeStore();
  poster = new FakePoster();
  now = NOW;
  api = new AgentServiceApi(store, TOKEN, { now: () => now, poster, socketUrl: SOCKET });
});

const later = (seconds: number) => {
  now = new Date(now.getTime() + seconds * 1000);
};

/** A response whose body the test reads as it expects it. */
type Res = Omit<Response, "json" | "clone"> & { json(): Promise<any>; clone(): Response };

const call = async (method: string, path: string, body?: unknown, bearer = "secret"): Promise<Res> =>
  api.fetch(
    new Request(`http://local${path}`, {
      method,
      headers: { Authorization: `Bearer ${bearer}`, "Content-Type": "application/json" },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    }),
  );

const read = async (path: string, bearer = "secret"): Promise<any> => (await call("GET", path, undefined, bearer)).json();

const EMPTY = { version: "0.1.0", labels: [] };

const heartbeat = async (id: string, body: object = {}, headers: Record<string, string> = {}): Promise<Res> =>
  api.fetch(
    new Request(`http://local/hosts/${id}/heartbeat`, {
      method: "POST",
      headers: {
        Authorization: "Bearer secret",
        "Content-Type": "application/json",
        ...headers,
      },
      body: JSON.stringify({ ...EMPTY, ...body }),
    }),
  );

const beat = async (id: string, body: object = {}) => {
  const res = await heartbeat(id, body);
  expect(res.status, await res.clone().text()).toBe(200);
  return (await res.json()) as { heartbeatInterval: number; socketUrl: string | null };
};

/** A host's report, on a socket of its own kept for reporting. */
const report = async (hostId: string, body: object) => {
  const connectionId = `reports-${hostId}`;
  if (!store.sockets.has(connectionId)) {
    await store.putConnection({ connectionId, kind: "host", hostId, connectedAt: now.toISOString() });
  }
  await new SocketHandler(store, TOKEN, poster, () => now).handle({
    requestContext: { connectionId, eventType: "MESSAGE" },
    body: JSON.stringify({ type: "report", ...body }),
  });
  expect(poster.to(connectionId).filter((m) => m.type === "error")).toEqual([]);
};

/** What a newly connected socket of the host is replayed. */
const replayed = async (hostId = "laptop") => {
  const connectionId = `fresh-${hostId}-${poster.posts.length}`;
  await store.putConnection({ connectionId, kind: "host", hostId, connectedAt: now.toISOString() });
  await new SocketHandler(store, TOKEN, poster, () => now).handle({
    requestContext: { connectionId, eventType: "MESSAGE" },
    body: JSON.stringify({ type: "ping" }),
  });
  return poster.to(connectionId).flatMap((m) => (m.type === "command" ? [m.command] : []));
};

const create = async (body: object = {}, bearer = "secret") => {
  const res = await call("POST", "/agents", { name: "frontend-1", hostId: "laptop", ...body }, bearer);
  expect(res.status, await res.clone().text()).toBe(201);
  return (await res.json()) as { id: string; name: string; state: string; item?: string | null; session: { id: string } | null };
};

const queued = (hostId = "laptop") => (store.commands.get(hostId) ?? []).map((q) => q.command);

const ack = (commands: Command[], ok = true, error?: string) =>
  commands.map((c) => ({ commandId: c.id, ok, ...(error && { error }) }));

const agent = (id: string) => read(`/agents/${id}`);

const host = async (id: string) => (await read("/hosts")).hosts.find((h: { id: string }) => h.id === id);

/** What a start is queued with to reach this service: its address and the name of its token, never the token. */
const SELF = { env: { AG_URL: "http://local" }, credentials: ["agent-service"] };

describe("auth", () => {
  it("serves health without a token", async () => {
    expect((await api.fetch(new Request("http://local/health"))).status).toBe(200);
  });

  it("refuses a read without the token, or with the wrong one", async () => {
    expect((await api.fetch(new Request("http://local/hosts"))).status).toBe(401);
    expect((await call("GET", "/hosts", undefined, "wrong")).status).toBe(401);
  });

  it("says plainly when no token is configured", async () => {
    const unconfigured = new AgentServiceApi(store, { value: async () => null });
    const res = await unconfigured.fetch(new Request("http://local/hosts"));
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "API token is not configured." });
  });

  it("refuses a heartbeat with the wrong token", async () => {
    expect((await heartbeat("laptop", {}, { Authorization: "Bearer wrong" })).status).toBe(401);
  });
});

describe("heartbeat", () => {
  it("registers a host, and says when to come back and where its socket is", async () => {
    const res = await heartbeat("laptop");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      heartbeatInterval: HEARTBEAT_INTERVAL,
      socketUrl: SOCKET,
    });
    expect(await host("laptop")).toEqual({
      id: "laptop",
      heartbeatAt: NOW.toISOString(),
      version: "0.1.0",
      labels: [],
      capacity: null,
      status: "connected",
      available: null,
    });
  });

  it("keeps a host's last labels when a heartbeat leaves them out, and none for a new host", async () => {
    expect((await heartbeat("bare", { labels: undefined })).status).toBe(200);
    expect((await host("bare")).labels).toEqual([]);
    await beat("laptop", { labels: ["macos", "gpu"] });
    await beat("laptop", { labels: undefined });
    expect((await host("laptop")).labels).toEqual(["macos", "gpu"]);
  });

  it("gives a null socketUrl where there is no socket", async () => {
    api = new AgentServiceApi(store, TOKEN, { now: () => now });
    expect((await beat("laptop")).socketUrl).toBeNull();
  });

  it("refuses a report, which goes by the socket alone, rather than dropping it", async () => {
    await beat("laptop");
    await create({ brief: "Go." });
    const [home] = queued();
    const res = await heartbeat("laptop", { commandResults: ack([home!]) });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/commandResults/);
    expect(queued()).toHaveLength(2);
  });

  it("goes disconnected after two missed heartbeats and lost after ten", async () => {
    await beat("laptop");
    later(2 * HEARTBEAT_INTERVAL + 1);
    expect((await host("laptop")).status).toBe("disconnected");
    later(LOST_AFTER);
    expect((await read("/hosts?status=lost")).hosts.map((h: { id: string }) => h.id)).toEqual(["laptop"]);
    expect((await read("/hosts?status=connected")).hosts).toEqual([]);
  });

  it("pushes the host to every viewer, and nothing to a host's socket", async () => {
    await store.putConnection({ connectionId: "page", kind: "viewer", connectedAt: NOW.toISOString() });
    await store.putConnection({ connectionId: "host", kind: "host", hostId: "laptop", connectedAt: NOW.toISOString() });
    await beat("laptop", { capacity: 2 });
    expect(poster.to("page")).toEqual([{ type: "host", host: expect.objectContaining({ id: "laptop", available: 2 }) }]);
    expect(poster.to("host")).toEqual([]);
  });
});

describe("hosts", () => {
  it("deregisters a host with the stage's token, and 404s one never seen", async () => {
    await beat("laptop");
    expect((await call("DELETE", "/hosts/laptop")).status).toBe(204);
    expect((await read("/hosts")).hosts).toEqual([]);
    expect((await call("DELETE", "/hosts/laptop")).status).toBe(404);
  });

  it("has no route to read one host: the list is the way", async () => {
    await beat("laptop");
    const res = await call("GET", "/hosts/laptop");
    expect(res.status).toBe(404);
    expect(await res.text()).toBe("404 Not Found");
  });

  it("counts a host's places by its agents' live sessions", async () => {
    await beat("laptop", { capacity: 2 });
    await create({ name: "a", brief: "Go." });
    await create({ name: "b" });
    expect((await host("laptop")).available).toBe(1);
  });
});

describe("creating an agent", () => {
  beforeEach(async () => {
    await beat("laptop", { capacity: 2 });
    await store.putConnection({ connectionId: "host", kind: "host", hostId: "laptop", connectedAt: NOW.toISOString() });
    await store.putConnection({ connectionId: "other", kind: "host", hostId: "desktop", connectedAt: NOW.toISOString() });
    await store.putConnection({ connectionId: "page", kind: "viewer", connectedAt: NOW.toISOString() });
    poster.posts = [];
  });

  it("records it idle and queues its home for its host alone", async () => {
    const made = await create();
    expect(made).toEqual({
      id: made.id,
      name: "frontend-1",
      hostId: "laptop",
      state: "idle",
      session: null,
      createdAt: NOW.toISOString(),
      reportedAt: null,
      title: null,
      label: null,
      item: null,
      role: null,
      tokens: { inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 },
      createdBy: null,
      whenDone: "keep",
      documents: [],
      credentials: null,
      status: null,
      summary: null,
      headline: null,
      saidAt: null,
      activity: null,
      tasks: 0,
      told: null,
      hostStatus: "connected",
    });
    const [command] = queued();
    expect(command).toEqual({
      kind: "create",
      id: expect.any(String),
      agentId: made.id,
      name: "frontend-1",
    });
    expect(poster.to("host")).toEqual([{ type: "command", command }]);
    expect(poster.to("other")).toEqual([]);
    expect(poster.to("page")).toEqual([{ type: "agent", agent: made }]);
  });

  it("with a brief, starts its first session at once, after its create", async () => {
    const made = await create({ brief: "Fix the board." });
    expect(made.state).toBe("working");
    expect(made.session).toEqual({ id: expect.any(String), startedAt: NOW.toISOString() });
    const [home, start] = queued();
    expect(home!.kind).toBe("create");
    expect(start).toEqual({
      kind: "start",
      id: expect.any(String),
      agentId: made.id,
      sessionId: made.session!.id,
      resume: false,
      text: "Fix the board.",
      ...SELF,
    });
    expect(await read(`/agents/${made.id}/sessions`)).toEqual({
      sessions: [
        {
          id: made.session!.id,
          agentId: made.id,
          startedAt: NOW.toISOString(),
          endedAt: null,
          ended: null,
          context: null,
          documents: [],
          skills: [],
          contextNote: "no context is configured",
        },
      ],
    });
  });

  it("refuses a name an agent not retired has, and frees it on retirement", async () => {
    const first = await create();
    const res = await call("POST", "/agents", { name: "frontend-1", hostId: "laptop" });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "An agent not retired is already named frontend-1." });
    expect((await call("DELETE", `/agents/${first.id}`)).status).toBe(202);
    await create();
  });

  it("refuses a bad name, an unknown host, a lost one, and a brief on a full one", async () => {
    const bad = await call("POST", "/agents", { name: "Front End", hostId: "laptop" });
    expect(bad.status).toBe(400);
    const unknown = await call("POST", "/agents", { name: "a", hostId: "nowhere" });
    expect(unknown.status).toBe(404);

    await beat("laptop", { capacity: 1 });
    await create({ name: "a", brief: "Go." });
    const full = await call("POST", "/agents", { name: "b", hostId: "laptop", brief: "Go." });
    expect(full.status).toBe(409);
    expect(await full.json()).toEqual({ error: "laptop is running all 1 sessions it will." });
    await create({ name: "c" });

    later(LOST_AFTER + 1);
    const lost = await call("POST", "/agents", { name: "d", hostId: "laptop" });
    expect(lost.status).toBe(409);
    expect((await lost.json()).error).toMatch(/^laptop has not sent a heartbeat since/);
  });

  it("refuses a brief longer than a message may be, rather than cutting it", async () => {
    const res = await call("POST", "/agents", { name: "a", hostId: "laptop", brief: "x".repeat(TEXT_LIMIT + 1) });
    expect(res.status).toBe(400);
    expect(store.agents.size).toBe(0);
  });
});

describe("listing agents", () => {
  it("leaves out the retired unless asked, and takes no host or state filter", async () => {
    await beat("laptop");
    await beat("desktop");
    const a = await create({ name: "a" });
    const b = await create({ name: "b", hostId: "desktop", brief: "Go." });
    const c = await create({ name: "c" });
    await call("DELETE", `/agents/${c.id}`);
    const names = async (query: string) =>
      (await read(`/agents${query}`)).agents.map((w: { name: string }) => w.name);
    expect(await names("")).toEqual(["a", "b"]);
    expect(await names("?all=true")).toEqual(["a", "b", "c"]);
    expect(await names("?hostId=desktop")).toEqual(["a", "b"]);
    expect(await names("?state=retired")).toEqual(["a", "b"]);
    expect((await call("GET", `/agents/${a.id}`)).status).toBe(200);
    expect((await call("GET", "/agents/3b0f6c1e-9a52-4c1d-8f43-2a6e1c7d9b10")).status).toBe(404);
    expect(b.state).toBe("working");
  });
});

describe("the item an agent was started on", () => {
  it("is kept as given, and null without one", async () => {
    await beat("laptop");
    const on = await create({ name: "a", item: "ca147da6-9a30-4d59-b508-e404d21b9dfd" });
    const off = await create({ name: "b" });
    expect(on.item).toBe("ca147da6-9a30-4d59-b508-e404d21b9dfd");
    expect((await read(`/agents/${on.id}`)).item).toBe("ca147da6-9a30-4d59-b508-e404d21b9dfd");
    expect((await read(`/agents/${off.id}`)).item).toBeNull();
  });

  it("lists every agent started on it, retired ones included, and no other", async () => {
    await beat("laptop");
    await create({ name: "a", item: "epic-1" });
    await create({ name: "b", item: "story-2" });
    const c = await create({ name: "c", item: "epic-1" });
    await create({ name: "d" });
    await call("DELETE", `/agents/${c.id}`);
    const names = async (query: string) =>
      (await read(`/agents${query}`)).agents.map((w: { name: string }) => w.name);
    expect(await names("?item=epic-1")).toEqual(["a", "c"]);
    expect(await names("?item=story-2")).toEqual(["b"]);
    expect(await names("?item=none")).toEqual([]);
  });

  it("refuses an item id longer than one can be", async () => {
    await beat("laptop");
    expect((await call("POST", "/agents", { name: "a", hostId: "laptop", item: "x".repeat(65) })).status).toBe(400);
  });
});

describe("a session's life, as its host reports it", () => {
  let id: string;
  let sessionId: string;

  beforeEach(async () => {
    await beat("laptop", { capacity: 2 });
    const made = await create({ brief: "Go." });
    id = made.id;
    sessionId = made.session!.id;
  });

  const reports = (agents: object[], more: object = {}) => report("laptop", { agents, ...more });

  it("delivers each command once it is reported, and keeps it queued until then", async () => {
    const commands = queued();
    expect(commands).toHaveLength(2);
    await report("laptop", { agents: [] });
    expect(queued()).toEqual(commands);
    await report("laptop", { commandResults: ack(commands) });
    expect(queued()).toEqual([]);
    const sent = (await read(`/agents/${id}/commands`)).commands;
    expect(sent.map((s: { delivery: string }) => s.delivery)).toEqual(["done", "done"]);
  });

  it("takes the state its host reports for the live session", async () => {
    await reports([{ id, state: "waiting", sessionId }]);
    expect(await agent(id)).toMatchObject({ state: "waiting", reportedAt: NOW.toISOString() });
    later(30);
    await reports([{ id, state: "working", sessionId }]);
    expect(await agent(id)).toMatchObject({ state: "working", reportedAt: now.toISOString() });
  });

  it("keeps the background tasks and whether a message began the turn, as its host reports them", async () => {
    await reports([{ id, state: "working", sessionId, tasks: 2, told: true }]);
    expect(store.agents.get(id)).toMatchObject({ state: "working", tasks: 2, told: true });
    later(30);
    await reports([{ id, state: "working", sessionId, tasks: 1, told: true }]);
    expect(store.agents.get(id)).toMatchObject({ tasks: 1, reportedAt: now.toISOString() });
    await reports([{ id, state: "waiting", sessionId }]);
    expect(store.agents.get(id)).toMatchObject({ state: "waiting", tasks: 0, told: null });
    expect(await agent(id)).toMatchObject({ tasks: 0, told: null });
    await reports([{ id, state: "idle", sessionId }]);
    expect(store.agents.get(id)).toMatchObject({ state: "idle", tasks: 0, told: null });
  });

  it("ends the session stopped when its host says it went idle, and interrupted when it died", async () => {
    await reports([{ id, state: "idle", sessionId }]);
    expect(await agent(id)).toMatchObject({ state: "idle", session: null });
    const [first] = (await read(`/agents/${id}/sessions`)).sessions;
    expect(first).toMatchObject({ id: sessionId, ended: "stopped", endedAt: NOW.toISOString() });

    const res = await call("POST", `/agents/${id}/resume`);
    expect(res.status).toBe(202);
    const again = (await agent(id)).session.id;
    await reports([{ id, state: "interrupted", sessionId: again }]);
    expect(await agent(id)).toMatchObject({ state: "interrupted", session: null });
    expect((await read(`/agents/${id}/sessions`)).sessions[1]).toMatchObject({ id: again, ended: "interrupted" });
  });

  it("does not take a session not yet begun for a missing one", async () => {
    await reports([{ id, state: "idle", sessionId: null }]);
    expect((await agent(id)).session?.id).toBe(sessionId);
    await report("laptop", { commandResults: ack(queued()), agents: [{ id, state: "idle", sessionId: null }] });
    expect(await agent(id)).toMatchObject({ state: "interrupted", session: null });
  });

  it("keeps a session begun when a report from before its start arrives after it", async () => {
    const [home, start] = queued();
    await report("laptop", { commandResults: ack([start!]), agents: [{ id, state: "working", sessionId }] });
    await report("laptop", { commandResults: ack([home!]), agents: [{ id, state: "idle", sessionId: null }] });
    expect(await agent(id)).toMatchObject({ state: "working", session: { id: sessionId } });
    expect(queued()).toEqual([]);
    expect((await agent(id)).begun).toBeUndefined();
    await reports([{ id, state: "interrupted", sessionId }]);
    expect(await agent(id)).toMatchObject({ state: "interrupted", session: null });
  });

  it.each([1, 2])("keeps a new session when a report from before its start is held at read %i while its start is reported", async (at) => {
    const [home, start] = queued();
    let reads = 0;
    let reached!: () => void;
    let release!: () => void;
    const there = new Promise<void>((resolve) => (reached = resolve));
    const gate = new Promise<void>((resolve) => (release = resolve));
    const hold =
      <A extends unknown[], T>(read: (...args: A) => Promise<T>) =>
      async (...args: A) => {
        const got = await read(...args);
        if (++reads === at) {
          reached();
          await gate;
        }
        return got;
      };
    store.listAgents = hold(store.listAgents.bind(store));
    store.pending = hold(store.pending.bind(store));
    const stale = report("laptop", { agents: [{ id, state: "idle", sessionId: null }] });
    await there;
    await report("laptop", { commandResults: ack([home!, start!]), agents: [{ id, state: "working", sessionId }] });
    release();
    await stale;
    expect(await agent(id)).toMatchObject({ state: "working", session: { id: sessionId } });
    expect(queued()).toEqual([]);
  });

  it("interrupts an agent whose start its host could not do, in the host's words", async () => {
    const [home, start] = queued();
    await report("laptop", { commandResults: [...ack([home!]), ...ack([start!], false, "tmux failed")] });
    expect(await agent(id)).toMatchObject({ state: "interrupted", session: null });
    const sent = (await read(`/agents/${id}/commands`)).commands;
    expect(sent[1]).toMatchObject({ delivery: "rejected", error: "tmux failed" });
  });

  it("ignores what a host reports of an agent that is not its own", async () => {
    await report("desktop", {
      agents: [{ id, state: "waiting", sessionId }],
      lines: [{ agentId: id, sessionId, seq: 0, at: NOW.toISOString(), from: "agent", text: "Not mine." }],
    });
    expect((await agent(id)).state).toBe("working");
    expect((await read(`/agents/${id}/transcript`)).lines).toEqual([]);
  });

  it("keeps lines by seq across sessions, idempotently, and pushes them to viewers", async () => {
    await store.putConnection({ connectionId: "page", kind: "viewer", connectedAt: NOW.toISOString() });
    const line = (seq: number, text: string) => ({ agentId: id, sessionId, seq, at: NOW.toISOString(), from: "agent", text });
    await report("laptop", { lines: [line(1, "second"), line(0, "first")] });
    await report("laptop", { lines: [line(1, "second")] });
    const { lines, next } = await read(`/agents/${id}/transcript?limit=1`);
    expect(lines).toEqual([{ seq: 0, at: NOW.toISOString(), sessionId, from: "agent", text: "first" }]);
    expect((await read(`/agents/${id}/transcript?after=${next}`)).lines.map((l: { text: string }) => l.text)).toEqual(["second"]);
    const pushed = poster.to("page").filter((m) => m.type === "lines");
    expect(pushed[0]).toEqual({
      type: "lines",
      agentId: id,
      lines: [
        { seq: 0, at: NOW.toISOString(), sessionId, from: "agent", text: "first" },
        { seq: 1, at: NOW.toISOString(), sessionId, from: "agent", text: "second" },
      ],
    });
    expect((await call("GET", `/agents/${id}/transcript?after=bogus`)).status).toBe(400);
  });

  /** One line reported, as the transcript reads it and as viewers were pushed it. */
  const carried = async (from: string, text: string) => {
    await report("laptop", { lines: [{ agentId: id, sessionId, seq: 0, at: NOW.toISOString(), from, text }] });
    const [line] = (await read(`/agents/${id}/transcript`)).lines;
    const [pushed] = poster.to("page").filter((m) => m.type === "lines").slice(-1);
    return { read: line.text as string, pushed: pushed?.type === "lines" ? pushed.lines[0]!.text : undefined };
  };

  it("keeps a reply of 20,000 characters whole, as read and as pushed to viewers", async () => {
    await store.putConnection({ connectionId: "page", kind: "viewer", connectedAt: NOW.toISOString() });
    const reply = "Here is what I make of it, point by point, «at length».\n".repeat(358).slice(0, 20_000);
    expect(reply).toHaveLength(20_000);
    expect(await carried("agent", reply)).toEqual({ read: reply, pushed: reply });
  });

  it("keeps a message told to the agent whole, however long a message may be", async () => {
    await store.putConnection({ connectionId: "page", kind: "viewer", connectedAt: NOW.toISOString() });
    const message = "Do this, then that. ".repeat(TEXT_LIMIT / 20 + 1).slice(0, TEXT_LIMIT);
    expect(await carried("instruction", message)).toEqual({ read: message, pushed: message });
  });

  it("keeps a line longer than it may be cut, saying so and how long it was, with the rest of its report", async () => {
    const long = "z".repeat(LINE_LIMIT + 10);
    await report("laptop", {
      agents: [{ id, state: "waiting", sessionId }],
      lines: [{ agentId: id, sessionId, seq: 0, at: NOW.toISOString(), from: "agent", text: long }],
    });
    const [line] = (await read(`/agents/${id}/transcript`)).lines;
    expect(line.text).toHaveLength(LINE_LIMIT);
    expect(line.text).toMatch(new RegExp(`^z+… \\[cut: (\\d+) of ${LINE_LIMIT + 10} characters\\]$`));
    expect(line.text.indexOf("…")).toBe(Number(/cut: (\d+)/.exec(line.text)![1]));
    expect((await agent(id)).state).toBe("waiting");
  });

  it("pushes an agent to viewers when its state changes, and not when it does not", async () => {
    await store.putConnection({ connectionId: "page", kind: "viewer", connectedAt: NOW.toISOString() });
    await reports([{ id, state: "waiting", sessionId }]);
    await reports([{ id, state: "waiting", sessionId }]);
    const agents = poster.to("page").filter((m) => m.type === "agent");
    expect(agents).toEqual([{ type: "agent", agent: expect.objectContaining({ id, state: "waiting" }) }]);
  });
});

describe("what an agent says of itself", () => {
  let id: string;
  let sessionId: string;

  beforeEach(async () => {
    await beat("laptop", { capacity: 2 });
    const made = await create({ brief: "Go." });
    id = made.id;
    sessionId = made.session!.id;
  });

  const page = (status: string, summary: string, headline?: string) =>
    call("PUT", `/agents/${id}/status`, { status, summary, ...(headline !== undefined && { headline }) });
  // A host reports a turn ending as `waiting` and one beginning as `working`.
  const turn = (state: "working" | "waiting") => report("laptop", { agents: [{ id, state, sessionId }] });
  const said = async () => {
    const { state, status, summary } = await agent(id);
    return { state, status, summary };
  };

  it("starts a session working, with nothing said", async () => {
    expect(await said()).toEqual({ state: "working", status: "working", summary: null });
  });

  it("reads idle, not waiting, once a turn ends with nothing paged and nothing open", async () => {
    await store.putConnection({ connectionId: "page", kind: "viewer", connectedAt: NOW.toISOString() });
    await turn("waiting");
    expect(await agent(id)).toMatchObject({ state: "waiting", status: "idle", summary: null, headline: null });
    await turn("working");
    expect((await said()).status).toBe("working");
    await page("working", "Reading schema.ts");
    await turn("waiting");
    expect(await said()).toEqual({ state: "waiting", status: "idle", summary: "Reading schema.ts" });
    const pushed = poster.to("page").filter((m) => m.type === "agent");
    expect(pushed.map((m) => m.type === "agent" && m.agent.status)).not.toContain("waiting");
  });

  it("reads working while a background task or subagent it started is open, between turns too", async () => {
    await report("laptop", { agents: [{ id, state: "waiting", sessionId, tasks: 1, told: true }] });
    expect(await agent(id)).toMatchObject({ state: "waiting", status: "working", tasks: 1 });
    await report("laptop", { agents: [{ id, state: "waiting", sessionId, tasks: 0, told: true }] });
    expect(await agent(id)).toMatchObject({ status: "idle", tasks: 0 });
  });

  it("reads waiting with its question when it pages so, and is pushed to viewers", async () => {
    await store.putConnection({ connectionId: "page", kind: "viewer", connectedAt: NOW.toISOString() });
    await page("waiting", "Which schema should the status field use?");
    await turn("waiting");
    expect(await said()).toMatchObject({ status: "waiting", summary: "Which schema should the status field use?" });
    expect((await agent(id)).saidAt).toBe(NOW.toISOString());
    const pushed = poster.to("page").filter((m) => m.type === "agent");
    expect(pushed.at(-1)).toEqual({ type: "agent", agent: expect.objectContaining({ status: "waiting" }) });
  });

  it("stays waiting through turns it begins by itself, and until the person messages it", async () => {
    await page("waiting", "Need the beta token");
    await report("laptop", { agents: [{ id, state: "waiting", sessionId, tasks: 1, told: true }] });
    expect((await said()).status).toBe("waiting");
    await report("laptop", { agents: [{ id, state: "working", sessionId, tasks: 0, told: false }] });
    await report("laptop", { agents: [{ id, state: "waiting", sessionId, tasks: 0, told: false }] });
    expect(await said()).toMatchObject({ status: "waiting", summary: "Need the beta token" });
    expect((await call("POST", `/agents/${id}/messages`, { text: "Here it is." })).status).toBe(202);
    expect(await agent(id)).toMatchObject({ status: "working", summary: null, headline: null, saidAt: null });
    await turn("waiting");
    expect((await said()).status).toBe("idle");
  });

  it("stays waiting through the rest of a turn it paged waiting in", async () => {
    await report("laptop", { agents: [{ id, state: "working", sessionId, told: true }] });
    await page("waiting", "Need the beta token");
    await report("laptop", { agents: [{ id, state: "working", sessionId, tasks: 1, told: true }] });
    await report("laptop", { agents: [{ id, state: "waiting", sessionId, tasks: 0, told: true }] });
    expect((await said()).status).toBe("waiting");
  });

  it("keeps a headline with its summary, and drops it with the summary", async () => {
    await page("waiting", "PR #41 is open and passing; merge it?", "Needs merge OK");
    expect(await agent(id)).toMatchObject({ summary: "PR #41 is open and passing; merge it?", headline: "Needs merge OK" });
    await page("working", "Reading schema.ts");
    expect((await agent(id)).headline).toBeNull();
    await page("waiting", "Which schema?", "Asking which schema");
    await call("POST", `/agents/${id}/messages`, { text: "The first." });
    expect(await agent(id)).toMatchObject({ summary: null, headline: null });
  });

  it("refuses a headline over the limit, saying the limit", async () => {
    const res = await page("working", "Reading schema.ts", "x".repeat(HEADLINE_LIMIT + 1));
    expect(res.status).toBe(400);
    expect(JSON.stringify(await res.json())).toContain(String(HEADLINE_LIMIT));
    expect((await page("working", "Reading schema.ts", "x".repeat(HEADLINE_LIMIT))).status).toBe(200);
  });

  it("is never set idle by an agent", async () => {
    expect((await page("idle", "Replied")).status).toBe(400);
  });

  const line = (seq: number, from: string, text: string) => ({ agentId: id, sessionId, seq, at: now.toISOString(), from, text });

  it("serves what it did last as its activity, and when, beside what it last paged and when", async () => {
    await page("working", "Starting the approvals board", "Board: starting");
    later(60);
    await report("laptop", {
      lines: [
        line(0, "tool", `Bash ${JSON.stringify({ command: "gh pr create --body x", description: "Open the board PR" })}`),
        line(1, "instruction", "Also check beta."),
      ],
    });
    const working = await agent(id);
    expect(working).toMatchObject({ summary: "Starting the approvals board", saidAt: NOW.toISOString(), activity: { text: "Open the board PR", at: now.toISOString() } });
    expect(working.activity.at > working.saidAt).toBe(true);
    later(60);
    await page("review", "PR #9 is in review", "In review: #9");
    expect((await agent(id)).saidAt > (await agent(id)).activity.at).toBe(true);
    later(60);
    await report("laptop", { lines: [line(2, "agent", "Submitted PR #9.\nIt is queued.")] });
    expect((await agent(id)).activity).toEqual({ text: "Submitted PR #9.", at: now.toISOString() });
  });

  it("keeps the newer activity when lines arrive out of order", async () => {
    later(60);
    await report("laptop", { lines: [line(5, "agent", "Newer.")] });
    const newer = (await agent(id)).activity;
    now = NOW;
    await report("laptop", { lines: [line(4, "agent", "Older.")] });
    expect((await agent(id)).activity).toEqual(newer);
  });

  it("ignores the turn an older host still reports, reading the turn from its state", async () => {
    await page("working", "Reading schema.ts");
    await report("laptop", { agents: [{ id, state: "working", sessionId, turn: "ended" }] });
    expect(await said()).toEqual({ state: "working", status: "working", summary: "Reading schema.ts" });
    await report("laptop", { agents: [{ id, state: "waiting", sessionId, turn: "ended" }] });
    expect(await said()).toEqual({ state: "waiting", status: "idle", summary: "Reading schema.ts" });
    expect(await agent(id)).not.toHaveProperty("turn");
  });

  it("has no status once its session ends, and keeps its last summary", async () => {
    await page("working", "Opening the PR");
    await report("laptop", { agents: [{ id, state: "idle", sessionId }] });
    expect(await said()).toEqual({ state: "idle", status: null, summary: "Opening the PR" });
  });

  it("refuses an agent with no live session, an unknown one, and a bad status or summary", async () => {
    await call("POST", `/agents/${id}/stop`, { force: true });
    expect((await page("working", "x")).status).toBe(409);
    expect((await call("PUT", `/agents/${crypto.randomUUID()}/status`, { status: "working", summary: "x" })).status).toBe(404);
    expect((await page("finished", "x")).status).toBe(400);
    expect((await page("working", "")).status).toBe(400);
    expect((await page("working", "x".repeat(SUMMARY_LIMIT + 1))).status).toBe(400);
  });

  it("is refused without the token", async () => {
    const res = await call("PUT", `/agents/${id}/status`, { status: "working", summary: "x" }, "wrong");
    expect(res.status).toBe(401);
  });
});

describe("an agent that says it is done", () => {
  let id: string;
  let sessionId: string;

  const make = async (whenDone?: string) => {
    await beat("laptop", { capacity: 2 });
    const made = await create({ brief: "Review PR #18.", ...(whenDone && { whenDone }) });
    id = made.id;
    sessionId = made.session!.id;
  };
  const done = () => call("PUT", `/agents/${id}/status`, { status: "done", summary: "Approved PR #18.", headline: "Approved #18" });
  const stops = () => queued().filter((c) => c.kind === "stop" && c.agentId === id);

  it("is kept by default, reads done with its result, and is at work again once messaged", async () => {
    await make();
    expect((await agent(id)).whenDone).toBe("keep");
    expect((await done()).status).toBe(200);
    expect(await agent(id)).toMatchObject({ status: "done", summary: "Approved PR #18.", headline: "Approved #18", state: "working" });
    expect(stops()).toEqual([]);
    await report("laptop", { agents: [{ id, state: "waiting", sessionId }] });
    expect((await agent(id)).status).toBe("done");
    expect((await call("POST", `/agents/${id}/messages`, { text: "One more thing." })).status).toBe(202);
    expect(await agent(id)).toMatchObject({ status: "working", summary: null });
  });

  const quiet = (tasks = 0) => report("laptop", { agents: [{ id, state: "waiting", sessionId, tasks }] });

  it("is stopped when made to stop once its turn and background tasks end, and still reads done once its session has ended", async () => {
    await make("stop");
    await done();
    expect(stops()).toEqual([]);
    await quiet(1);
    expect(stops()).toEqual([]);
    await quiet(0);
    await quiet(0);
    expect(stops()).toHaveLength(1);
    const [stop] = stops();
    expect(stop).toBeDefined();
    await report("laptop", { commandResults: ack([stop!]), agents: [{ id, state: "idle", sessionId: null }] });
    expect(await agent(id)).toMatchObject({ state: "idle", status: "done", summary: "Approved PR #18." });
    expect((await call("POST", `/agents/${id}/resume`)).status).toBe(202);
    expect((await agent(id)).status).toBe("working");
  });

  it("is retired when made to retire once its turn ends, its name freed, reading done", async () => {
    await make("retire");
    const res = await done();
    expect(res.status, await res.clone().text()).toBe(200);
    expect(await res.json()).toMatchObject({ state: "working", status: "done" });
    await quiet();
    expect(await agent(id)).toMatchObject({ state: "retired", status: "done", summary: "Approved PR #18." });
    expect(queued().filter((c) => c.agentId === id).map((c) => c.kind)).toEqual(["create", "start", "stop", "retire"]);
    expect((await read(`/agents/${id}/sessions`)).sessions[0]).toMatchObject({ ended: "stopped" });
    expect((await call("POST", "/agents", { name: "frontend-1", hostId: "laptop" })).status).toBe(201);
  });

  it("does not read done when its session ends without saying so", async () => {
    await make("retire");
    await call("PUT", `/agents/${id}/status`, { status: "working", summary: "Reviewing" });
    await report("laptop", { agents: [{ id, state: "interrupted", sessionId }] });
    expect(await agent(id)).toMatchObject({ state: "interrupted", status: null });
  });

  const review = () => call("PUT", `/agents/${id}/status`, { status: "review", summary: "Submitted PR #18 to approval-service.", headline: "In review: #18" });

  it("in review, stays by default, reads review, and is at work again once messaged", async () => {
    await make();
    expect((await review()).status).toBe(200);
    expect(await agent(id)).toMatchObject({ status: "review", headline: "In review: #18" });
    expect(stops()).toEqual([]);
    await report("laptop", { agents: [{ id, state: "waiting", sessionId }] });
    expect((await agent(id)).status).toBe("review");
    expect((await call("POST", `/agents/${id}/messages`, { text: "Sent back: a check failed." })).status).toBe(202);
    expect(await agent(id)).toMatchObject({ status: "working", summary: null });
  });

  it("in review, is stopped but never retired when made to retire, and still reads review once its session has ended", async () => {
    await make("retire");
    expect((await review()).status).toBe(200);
    await quiet();
    expect(queued().filter((c) => c.agentId === id).map((c) => c.kind)).toEqual(["create", "start", "stop"]);
    await report("laptop", { commandResults: ack(stops()), agents: [{ id, state: "idle", sessionId: null }] });
    expect(await agent(id)).toMatchObject({ state: "idle", status: "review", summary: "Submitted PR #18 to approval-service." });
  });

  it("refuses a whenDone it does not know", async () => {
    await beat("laptop");
    expect((await call("POST", "/agents", { name: "x-1", hostId: "laptop", whenDone: "vanish" })).status).toBe(400);
  });
});

describe("messaging an agent", () => {
  let id: string;

  beforeEach(async () => {
    await beat("laptop", { capacity: 1 });
    id = (await create()).id;
  });

  const message = (body: object, target = id, bearer = "secret") =>
    call("POST", `/agents/${target}/messages`, body, bearer);

  it("starts an idle agent's session with the text, fresh the first time and resumed after", async () => {
    const res = await message({ text: "Hello." });
    expect(res.status).toBe(202);
    const { commandId } = await res.json();
    const start = queued().find((c) => c.id === commandId);
    const live = await agent(id);
    expect(start).toEqual({ kind: "start", id: commandId, agentId: id, sessionId: live.session.id, resume: false, text: "Hello.", ...SELF });
    expect(live.state).toBe("working");

    await report("laptop", { agents: [{ id, state: "interrupted", sessionId: live.session.id }] });
    const again = await (await message({ text: "Carry on." })).json();
    expect(queued().find((c) => c.id === again.commandId)).toMatchObject({ kind: "start", resume: true, text: "Carry on." });
  });

  it("sends a live session a message, or an interrupt with or without text", async () => {
    await message({ text: "Go." });
    const ids = [];
    for (const body of [{ text: "And this." }, { interrupt: true }, { interrupt: true, text: "Stop that." }]) {
      const res = await message(body);
      expect(res.status).toBe(202);
      ids.push((await res.json()).commandId);
    }
    expect(ids.map((c) => queued().find((q) => q.id === c))).toEqual([
      { kind: "message", id: ids[0], agentId: id, text: "And this." },
      { kind: "interrupt", id: ids[1], agentId: id },
      { kind: "interrupt", id: ids[2], agentId: id, text: "Stop that." },
    ]);
  });

  it("refuses an interrupt with nothing to interrupt, a misspelt flag, and no text at all", async () => {
    const res = await message({ interrupt: true });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "frontend-1 is idle, with no session to interrupt." });
    expect((await message({ text: "x", interupt: true })).status).toBe(400);
    expect((await message({})).status).toBe(400);
  });

  it("refuses a start on a full host, and anything for a lost one or a retired agent", async () => {
    await create({ name: "busy", brief: "Go." });
    const full = await message({ text: "Go." });
    expect(full.status).toBe(409);
    later(LOST_AFTER + 1);
    expect((await message({ text: "Go." })).status).toBe(409);
    await call("DELETE", `/agents/${id}`);
    expect(await (await message({ text: "Go." })).json()).toEqual({ error: "frontend-1 is retired." });
  });

  it("withdraws a message its lost host never took, but keeps offering a create", async () => {
    await message({ text: "Go." });
    const { commandId } = await (await message({ text: "Late." })).json();
    later(LOST_AFTER + 1);
    const sent = (await read(`/agents/${id}/commands`)).commands;
    expect(sent.find((s: { command: { id: string } }) => s.command.id === commandId).delivery).toBe("withdrawn");
    expect((await replayed()).map((c) => c.kind)).toEqual(["create"]);
  });

  it("keeps a command's record for its time and no longer", async () => {
    later(KEPT_FOR + 1);
    expect((await read(`/agents/${id}/commands`)).commands).toEqual([]);
  });
});

describe("stopping an agent", () => {
  let id: string;
  let sessionId: string;

  beforeEach(async () => {
    await beat("laptop", { capacity: 2 });
    const made = await create({ brief: "Go." });
    id = made.id;
    sessionId = made.session!.id;
  });

  it("queues a stop, and ends the session when its host has done it", async () => {
    const res = await call("POST", `/agents/${id}/stop`, {});
    expect(res.status).toBe(202);
    const { commandId } = await res.json();
    expect(queued().at(-1)).toEqual({ kind: "stop", id: commandId, agentId: id });
    expect((await agent(id)).state).toBe("working");
    await report("laptop", { commandResults: ack(queued()) });
    expect(await agent(id)).toMatchObject({ state: "idle", session: null });
    expect((await read(`/agents/${id}/sessions`)).sessions[0].ended).toBe("stopped");
  });

  it("refuses an agent with no session", async () => {
    await call("POST", `/agents/${id}/stop`, { force: true });
    const res = await call("POST", `/agents/${id}/stop`, {});
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "frontend-1 is idle, with no session to stop." });
  });

  it("ends the session on record when the host is lost, with no force asked, and withdraws what is queued", async () => {
    later(LOST_AFTER + 1);
    const forced = await call("POST", `/agents/${id}/stop`, {});
    expect(forced.status).toBe(202);
    expect(await forced.json()).toEqual({ commandId: null });
    expect(await agent(id)).toMatchObject({ state: "idle", session: null });
    expect((await read(`/agents/${id}/sessions`)).sessions[0]).toMatchObject({ ended: "stopped", endedAt: now.toISOString() });
    expect(queued().map((c) => c.kind)).toEqual(["create"]);
    expect((await read(`/agents/${id}/commands`)).commands.map((s: { delivery: string }) => s.delivery)).toEqual([
      "queued",
      "withdrawn",
    ]);
  });

  it("ends the session on record when the host was deregistered", async () => {
    await call("DELETE", "/hosts/laptop");
    const res = await call("POST", `/agents/${id}/stop`, {});
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ commandId: null });
    expect(await agent(id)).toMatchObject({ state: "idle", session: null });
  });

  it("still asks a disconnected host, not yet lost, to stop it", async () => {
    later(3 * HEARTBEAT_INTERVAL);
    const res = await call("POST", `/agents/${id}/stop`, {});
    expect(res.status).toBe(202);
    expect((await res.json()).commandId).not.toBeNull();
    expect((await agent(id)).state).toBe("working");
  });

  it("tells a host still running a force-stopped session to stop, once until it is taken", async () => {
    await call("POST", `/agents/${id}/stop`, { force: true });
    await report("laptop", { agents: [{ id, state: "working", sessionId }] });
    await report("laptop", { agents: [{ id, state: "working", sessionId }] });
    expect(queued().filter((c) => c.kind === "stop")).toHaveLength(1);
    expect((await agent(id)).state).toBe("idle");
  });
});

describe("resuming an agent", () => {
  it("starts a session, fresh if it never had one, and refuses one already live", async () => {
    await beat("laptop");
    const { id } = await create();
    const res = await call("POST", `/agents/${id}/resume`);
    expect(res.status).toBe(202);
    const { commandId } = await res.json();
    expect(queued().find((c) => c.id === commandId)).toMatchObject({ kind: "start", resume: false });
    expect(queued().find((c) => c.id === commandId)).not.toHaveProperty("text");
    const again = await call("POST", `/agents/${id}/resume`);
    expect(again.status).toBe(409);
    expect(await again.json()).toEqual({ error: "frontend-1 is working, in a live session already." });
  });
});

describe("renaming an agent", () => {
  beforeEach(async () => {
    await beat("laptop");
  });

  it("is created with only a name and a host", async () => {
    const res = await call("POST", "/agents", { name: "agent-1", hostId: "laptop" });
    expect(res.status, await res.clone().text()).toBe(201);
    expect(await res.json()).toMatchObject({ name: "agent-1" });
  });

  it("takes a new name, frees the old one, and leaves its host as it was", async () => {
    const made = await create({ name: "agent-1" });
    const before = queued().length;
    const res = await call("PATCH", `/agents/${made.id}`, { name: "scout" });
    expect(res.status, await res.clone().text()).toBe(200);
    expect(await res.json()).toMatchObject({ id: made.id, name: "scout" });
    expect(await agent(made.id)).toMatchObject({ name: "scout" });
    expect(queued()).toHaveLength(before);
    expect((await call("POST", "/agents", { name: "agent-1", hostId: "laptop" })).status).toBe(201);
  });

  it("refuses a name another agent holds, and a retired agent", async () => {
    const one = await create({ name: "agent-1" });
    await create({ name: "agent-2" });
    const taken = await call("PATCH", `/agents/${one.id}`, { name: "agent-2" });
    expect(taken.status).toBe(409);
    expect((await taken.json()).error).toBe("An agent not retired is already named agent-2.");
    expect(await agent(one.id)).toMatchObject({ name: "agent-1" });
    await call("DELETE", `/agents/${one.id}`);
    expect((await call("PATCH", `/agents/${one.id}`, { name: "agent-9" })).status).toBe(409);
  });
});

describe("who made an agent", () => {
  beforeEach(async () => {
    await beat("laptop");
  });

  const make = async (name: string, by?: string): Promise<Res> =>
    api.fetch(
      new Request("http://local/agents", {
        method: "POST",
        headers: { Authorization: "Bearer secret", "Content-Type": "application/json", ...(by && { "claimed-by": by }) },
        body: JSON.stringify({ name, hostId: "laptop" }),
      }),
    );

  it("is the claimed-by it was made with, or null without one", async () => {
    const res = await make("reviewer-1", "approval-service");
    expect(res.status, await res.clone().text()).toBe(201);
    const made = await res.json();
    expect(made.createdBy).toBe("approval-service");
    expect((await agent(made.id)).createdBy).toBe("approval-service");
    expect((await (await make("agent-1")).json()).createdBy).toBeNull();
  });

  it("lists only the agents one maker made", async () => {
    await make("reviewer-1", "approval-service");
    await make("agent-1", "Dakota");
    await make("agent-2");
    const { agents } = await read("/agents?createdBy=approval-service");
    expect(agents.map((w: { name: string }) => w.name)).toEqual(["reviewer-1"]);
  });

  it("reads null on an agent stored before it was recorded", async () => {
    const { createdBy: _, label: __, ...old } = { ...(await (await make("agent-1", "Dakota")).json()), hadSession: false };
    store.plant(old);
    expect(await agent(old.id)).toMatchObject({ createdBy: null, label: null });
  });
});

describe("an agent's label", () => {
  let id: string;

  beforeEach(async () => {
    await beat("laptop");
    id = (await create({ name: "reviewer-1", label: "approval: PR #18" })).id;
  });

  it("is given when it is made and read back", async () => {
    expect((await agent(id)).label).toBe("approval: PR #18");
    expect((await create({ name: "agent-1" }) as { label?: string }).label).toBeNull();
  });

  it("is changed or cleared, the name and title left as they were", async () => {
    expect((await call("PATCH", `/agents/${id}`, { label: "reviewer" })).status).toBe(200);
    expect(await agent(id)).toMatchObject({ name: "reviewer-1", label: "reviewer", title: null });
    expect((await call("PATCH", `/agents/${id}`, { label: null })).status).toBe(200);
    expect((await agent(id)).label).toBeNull();
  });

  it("refuses a label too long or empty", async () => {
    expect((await call("PATCH", `/agents/${id}`, { label: "x".repeat(LABEL_LIMIT + 1) })).status).toBe(400);
    expect((await call("PATCH", `/agents/${id}`, { label: " " })).status).toBe(400);
    expect((await call("POST", "/agents", { name: "agent-2", hostId: "laptop", label: "" })).status).toBe(400);
  });
});

describe("an agent's title", () => {
  let id: string;

  beforeEach(async () => {
    await beat("laptop");
    id = (await create({ name: "agent-3", brief: "Go." })).id;
  });

  const name = (title: unknown) => call("PUT", `/agents/${id}/title`, { title });

  it("is null until the agent names itself, and is set once", async () => {
    expect((await agent(id)).title).toBeNull();
    const res = await name("Short status headline");
    expect(res.status, await res.clone().text()).toBe(200);
    expect(await res.json()).toMatchObject({ name: "agent-3", title: "Short status headline" });
    const again = await name("Something else");
    expect(again.status).toBe(409);
    expect((await again.json()).error).toBe('agent-3 is titled "Short status headline" already; only the person changes it.');
    expect((await agent(id)).title).toBe("Short status headline");
  });

  it("is changed or cleared by the person, the name left as it was", async () => {
    await name("Short status headline");
    const changed = await call("PATCH", `/agents/${id}`, { title: "Headlines on cards" });
    expect(changed.status, await changed.clone().text()).toBe(200);
    expect(await agent(id)).toMatchObject({ name: "agent-3", title: "Headlines on cards" });
    expect((await call("PATCH", `/agents/${id}`, { title: null })).status).toBe(200);
    expect((await agent(id)).title).toBeNull();
    expect((await call("PATCH", `/agents/${id}`, {})).status).toBe(400);
  });

  it("survives its session stopping and resuming", async () => {
    await name("Short status headline");
    await call("POST", `/agents/${id}/stop`, { force: true });
    expect((await agent(id)).title).toBe("Short status headline");
    expect((await call("POST", `/agents/${id}/resume`)).status).toBe(202);
    expect(await agent(id)).toMatchObject({ state: "working", title: "Short status headline" });
  });

  it("refuses a title too long or empty, and a retired agent", async () => {
    expect((await name("x".repeat(TITLE_LIMIT + 1))).status).toBe(400);
    expect((await name("  ")).status).toBe(400);
    await call("DELETE", `/agents/${id}`);
    expect((await name("Too late")).status).toBe(409);
  });
});

describe("retiring an agent", () => {
  it("records it retired at once, ends its session, and queues a stop and then retire", async () => {
    await beat("laptop");
    const made = await create({ brief: "Go." });
    const res = await call("DELETE", `/agents/${made.id}`);
    expect(res.status).toBe(202);
    const { commandId } = await res.json();
    expect(queued().map((c) => c.kind)).toEqual(["create", "start", "stop", "retire"]);
    expect(queued().at(-1)!.id).toBe(commandId);
    expect(await agent(made.id)).toMatchObject({ state: "retired", session: null });
    expect((await read(`/agents/${made.id}/sessions`)).sessions[0].ended).toBe("stopped");
    expect((await call("DELETE", `/agents/${made.id}`)).status).toBe(409);

    // Whatever its host still says of it, it stays retired.
    await report("laptop", { agents: [{ id: made.id, state: "working", sessionId: made.session!.id }] });
    expect((await agent(made.id)).state).toBe("retired");
    expect(queued().filter((c) => c.kind === "stop")).toHaveLength(1);
  });

  it("offers retire to a lost host for as long as it takes", async () => {
    await beat("laptop");
    const made = await create();
    later(LOST_AFTER + 1);
    expect((await call("DELETE", `/agents/${made.id}`)).status).toBe(202);
    later(LOST_AFTER * 10);
    expect((await replayed()).map((c) => c.kind)).toEqual(["create", "retire"]);
  });
});

describe("a write racing a report or a retire", () => {
  let id: string;
  let sessionId: string;

  beforeEach(async () => {
    await beat("laptop", { capacity: 2 });
    const made = await create({ brief: "Go." });
    id = made.id;
    sessionId = made.session!.id;
  });

  /** Runs `between` once, after the route's next read of the agent and before what it read is written. */
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
  const line = () => ({ agentId: id, sessionId, seq: 0, at: NOW.toISOString(), from: "agent", text: "Reading schema.ts." });
  const turnEnds = () =>
    report("laptop", { commandResults: ack(queued()), agents: [{ id, state: "waiting", sessionId }], lines: [line()] });
  const retired = async () => expect((await call("DELETE", `/agents/${id}`)).status).toBe(202);
  const keptRetired = async () => {
    expect(await agent(id)).toMatchObject({ state: "retired", session: null });
    expect((await call("POST", "/agents", { name: "frontend-1", hostId: "laptop" })).status).toBe(201);
  };

  const routes: [string, () => Promise<Res>][] = [
    ["a message", () => call("POST", `/agents/${id}/messages`, { text: "And this." })],
    ["a title", () => call("PUT", `/agents/${id}/title`, { title: "Guarded writes" })],
    ["a rename", () => call("PATCH", `/agents/${id}`, { name: "scout", label: "racing" })],
    ["a force stop", () => call("POST", `/agents/${id}/stop`, { force: true })],
  ];

  for (const [what, send] of routes) {
    it(`keeps what a report wrote between ${what}'s read and its write`, async () => {
      afterGetting(turnEnds);
      const res = await send();
      expect(res.status, await res.clone().text()).toBeLessThan(300);
      expect(store.agents.get(id)).toMatchObject({ begun: sessionId, activity: { text: "Reading schema.ts." } });
    });

    it(`refuses ${what} once a retire lands between its read and its write`, async () => {
      afterGetting(retired);
      expect((await send()).status).toBe(409);
      await keptRetired();
    });
  }

  it("keeps a turn's end a report wrote under a title", async () => {
    afterGetting(turnEnds);
    expect((await call("PUT", `/agents/${id}/title`, { title: "Guarded writes" })).status).toBe(200);
    expect(await agent(id)).toMatchObject({ state: "waiting", title: "Guarded writes", session: { id: sessionId } });
  });

  it("starts a session with a message that raced its session's end, never writing the ended one back", async () => {
    afterGetting(() => report("laptop", { commandResults: ack(queued()), agents: [{ id, state: "idle", sessionId }] }));
    const res = await call("POST", `/agents/${id}/messages`, { text: "And this." });
    expect(res.status).toBe(202);
    const { commandId } = await res.json();
    const start = queued().find((c) => c.id === commandId);
    expect(start).toMatchObject({ kind: "start", text: "And this." });
    const live = await agent(id);
    expect(live.session.id).not.toBe(sessionId);
    expect((await read(`/agents/${id}/sessions`)).sessions.find((s: { id: string }) => s.id === sessionId).ended).toBe("stopped");
  });

  describe("with no session", () => {
    beforeEach(async () => {
      await call("POST", `/agents/${id}/stop`, { force: true });
    });

    const idleLine = () => report("laptop", { agents: [{ id, state: "idle", sessionId: null }], lines: [line()] });

    for (const [what, send] of [
      ["a resume", () => call("POST", `/agents/${id}/resume`)],
      ["a message's start", () => call("POST", `/agents/${id}/messages`, { text: "Again." })],
    ] as [string, () => Promise<Res>][]) {
      it(`keeps what a report wrote between ${what}'s read and its write`, async () => {
        afterGetting(idleLine);
        expect((await send()).status).toBe(202);
        expect(store.agents.get(id)).toMatchObject({ state: "working", activity: { text: "Reading schema.ts." } });
      });

      it(`refuses ${what} once a retire lands between its read and its write`, async () => {
        afterGetting(retired);
        expect((await send()).status).toBe(409);
        await keptRetired();
      });
    }
  });

  it("retires an agent a report wrote between the retire's read and its write, keeping what it wrote", async () => {
    afterGetting(turnEnds);
    expect((await call("DELETE", `/agents/${id}`)).status).toBe(202);
    expect(store.agents.get(id)).toMatchObject({ state: "retired", begun: sessionId, activity: { text: "Reading schema.ts." } });
    await keptRetired();
  });

  it("refuses a retire once another lands between its read and its write", async () => {
    afterGetting(retired);
    expect((await call("DELETE", `/agents/${id}`)).status).toBe(409);
    expect(queued().filter((c) => c.kind === "retire")).toHaveLength(1);
  });
});

describe("socket tickets", () => {
  it("trades the token for a one-time ticket, kept only as its hash", async () => {
    const res = await call("POST", "/socket-tickets");
    expect(res.status).toBe(201);
    const { ticket, socketUrl, expiresAt } = await res.json();
    expect(socketUrl).toBe(SOCKET);
    expect(expiresAt).toBe(new Date(NOW.getTime() + 60_000).toISOString());
    expect([...store.tickets.keys()]).toEqual([hash(ticket)]);
  });

  it("says so where there is no socket", async () => {
    api = new AgentServiceApi(store, TOKEN, { now: () => now });
    const res = await call("POST", "/socket-tickets");
    expect(res.status).toBe(503);
  });
});

describe("pushing to sockets", () => {
  it("forgets a socket that has gone, and never fails the request for one", async () => {
    await beat("laptop");
    await store.putConnection({ connectionId: "gone", kind: "host", hostId: "laptop", connectedAt: NOW.toISOString() });
    await store.putConnection({ connectionId: "broken", kind: "viewer", connectedAt: NOW.toISOString() });
    poster.gone.add("gone");
    const failing = poster.post.bind(poster);
    poster.post = async (connectionId, message) => {
      if (connectionId === "broken") throw new Error("socket fell over");
      return failing(connectionId, message);
    };
    await create();
    expect([...store.sockets.keys()]).toEqual(["broken"]);
    expect(queued()).toHaveLength(1);
  });
});

describe("a session's context", () => {
  const GLOBAL = { key: "global", version: 4, files: [{ path: "skills/x/SKILL.md", content: "Use x.", executable: false }] };
  const APPROVAL = { key: "approval", version: 2, files: [{ path: "skills/approve/SKILL.md", content: "Approve.", executable: false }] };
  let attached: Read;
  let asked: string[][];
  let id: string;

  beforeEach(async () => {
    attached = { context: GLOBAL, documents: [], skills: [], note: null };
    asked = [];
    const context: ContextSource = {
      forSession: async (documents) => {
        asked.push(documents);
        return attached;
      },
      refuse: async (documents) => (documents.includes("nope") ? "document-service answered 404 for nope: no document nope" : null),
    };
    api = new AgentServiceApi(store, TOKEN, { now: () => now, poster, socketUrl: SOCKET, context });
    await beat("laptop", { capacity: 1 });
    id = (await create()).id;
  });

  it("is attached to each start, with the environment its scripts need, and recorded on the session", async () => {
    const { commandId } = await (await call("POST", `/agents/${id}/messages`, { text: "Hello." })).json();
    expect(queued().find((c) => c.id === commandId)).toMatchObject({
      kind: "start",
      context: GLOBAL,
      ...SELF,
    });
    expect((await read(`/agents/${id}/sessions`)).sessions[0]).toMatchObject({ context: { key: "global", version: 4 }, contextNote: null });
  });

  it("is kept on the session once it has ended", async () => {
    await call("POST", `/agents/${id}/messages`, { text: "Hello." });
    await call("POST", `/agents/${id}/stop`, { force: true });
    expect((await read(`/agents/${id}/sessions`)).sessions[0]).toMatchObject({ ended: "stopped", context: { key: "global", version: 4 } });
  });

  it("is left out when it cannot be read, and the session says why", async () => {
    attached = { context: null, documents: [], skills: [], note: "document-service answered 503 for global" };
    const { commandId } = await (await call("POST", `/agents/${id}/messages`, { text: "Hello." })).json();
    const start = queued().find((c) => c.id === commandId)!;
    expect(start).not.toHaveProperty("context");
    // An agent can still say what it is doing without its context.
    expect(start).toMatchObject(SELF);
    expect((await read(`/agents/${id}/sessions`)).sessions[0]).toMatchObject({ context: null, contextNote: "document-service answered 503 for global" });
  });

  it("carries the documents an agent was made with after global, each start, and records them", async () => {
    const made = await create({ name: "reviewer-1", documents: ["approval"] });
    expect(made).toMatchObject({ documents: ["approval"] });
    attached = { ...attached, documents: [APPROVAL] };
    const { commandId } = await (await call("POST", `/agents/${made.id}/messages`, { text: "Hello." })).json();
    expect(asked.at(-1)).toEqual(["approval"]);
    expect(queued().find((c) => c.id === commandId)).toMatchObject({ kind: "start", context: GLOBAL, documents: [APPROVAL] });
    expect((await read(`/agents/${made.id}/sessions`)).sessions[0]).toMatchObject({
      context: { key: "global", version: 4 },
      documents: [{ key: "approval", version: 2 }],
    });
    await call("POST", `/agents/${made.id}/stop`, { force: true });
    await call("POST", `/agents/${made.id}/resume`);
    expect(asked.at(-1)).toEqual(["approval"]);
  });

  it("asks for the skills of the services the agent is given, lays them over global, and records them", async () => {
    const WT = { key: "work-tracker", version: 53, commit: "abc", files: [{ path: "skills/x/bin/run", content: "echo", executable: true }] };
    const given: string[][] = [];
    const withSkills = new AgentServiceApi(store, TOKEN, {
      now: () => now,
      poster,
      socketUrl: SOCKET,
      context: {
        forSession: async (_, skills) => ({ ...attached, skills: (skills ?? []).map(({ key, version, commit }) => ({ key, version, commit })) }),
        refuse: async () => null,
      },
      skills: {
        forSession: async (names) => {
          given.push(names);
          return { skills: [WT], notes: ["document-service answered 404 for its skill"] };
        },
      },
    });
    api = withSkills;
    await call("POST", `/agents/${id}/messages`, { text: "Hello." });
    expect(given).toEqual([["agent-service"]]);
    expect((await read(`/agents/${id}/sessions`)).sessions[0]).toMatchObject({
      skills: [{ key: "work-tracker", version: 53, commit: "abc" }],
      contextNote: "document-service answered 404 for its skill",
    });
  });

  it("serves its own clients, behind the token", async () => {
    expect((await api.fetch(new Request("http://local/skill"))).status).toBe(401);
    const skill = await read("/skill");
    expect(skill.key).toBe("agent-service");
    expect(skill.files.map((f: { path: string }) => f.path)).toContain("skills/page/bin/page");
  });

  it("gives an agent made without documents global alone, as before", async () => {
    const { commandId } = await (await call("POST", `/agents/${id}/messages`, { text: "Hello." })).json();
    expect(asked).toEqual([[]]);
    expect(queued().find((c) => c.id === commandId)).not.toHaveProperty("documents");
  });

  describe("too large for its start", () => {
    const BIG = { key: "global", version: 5, files: [{ path: "skills/x/reference/api.md", content: "x".repeat(CONTEXT_LIMIT), executable: false }] };
    const TRIMMED = { key: "global", version: 5, files: [{ path: "skills/x/SKILL.md", content: "Use x.", executable: false }] };
    let limits: (number | undefined)[];

    beforeEach(() => {
      limits = [];
      api = new AgentServiceApi(store, TOKEN, {
        now: () => now,
        poster,
        socketUrl: SOCKET,
        context: {
          forSession: async (_, __, limit) => {
            limits.push(limit);
            return limit === FETCH_LIMIT
              ? attached
              : { context: TRIMMED, documents: [], skills: [], note: "the x skill's reference/ would take global past it", cut: true };
          },
          refuse: async () => null,
        },
      });
    });

    it("carries what fits and where its host reads the whole, which is then recorded", async () => {
      attached = { context: BIG, documents: [APPROVAL], skills: [], note: null };
      const { commandId } = await (await call("POST", `/agents/${id}/messages`, { text: "Hello." })).json();
      expect(limits).toEqual([FETCH_LIMIT, undefined]);
      const start = queued().find((c) => c.id === commandId)!;
      if (start.kind !== "start") throw new Error("not a start");
      expect(start).toMatchObject({ context: TRIMMED, contextUrl: `/agents/${id}/sessions/${start.sessionId}/context` });
      expect(start).not.toHaveProperty("documents");
      expect((await read(`/agents/${id}/sessions`)).sessions[0].contextNote).toMatch(/^the x skill's reference\/ .*, in its start; its host is to read the whole/);

      expect(await read(start.contextUrl!)).toEqual({ context: BIG, documents: [APPROVAL] });
      expect((await read(`/agents/${id}/sessions`)).sessions[0]).toMatchObject({
        context: { key: "global", version: 5 },
        documents: [{ key: "approval", version: 2 }],
        contextNote: null,
      });
    });

    it("is read only for the agent's live session", async () => {
      attached = { context: BIG, documents: [], skills: [], note: null };
      const { commandId } = await (await call("POST", `/agents/${id}/messages`, { text: "Hello." })).json();
      const start = queued().find((c) => c.id === commandId)!;
      if (start.kind !== "start") throw new Error("not a start");
      await call("POST", `/agents/${id}/stop`, { force: true });
      expect((await call("GET", start.contextUrl!)).status).toBe(409);
      const nobody = `/agents/${crypto.randomUUID()}/sessions/${start.sessionId}/context`;
      expect((await call("GET", nobody)).status).toBe(404);
    });

    it("is refused, saying why, when not even the whole fits", async () => {
      attached = { context: null, documents: [], skills: [], note: "global v5 is 2000000 bytes, over the 1048576 a start can carry", cut: true };
      const res = await call("POST", `/agents/${id}/messages`, { text: "Hello." });
      expect(res.status).toBe(409);
      expect((await res.json()).error).toMatch(/^Its context cannot be given whole, so no session was started: global v5 is 2000000 bytes/);
      expect((await read(`/agents/${id}`)).session).toBeNull();
    });
  });

  it("refuses a document document-service does not know, in its words, and global or one twice", async () => {
    const res = await call("POST", "/agents", { name: "reviewer-1", hostId: "laptop", documents: ["approval", "nope"] });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("document-service answered 404 for nope: no document nope");
    const named = (documents: string[]) => call("POST", "/agents", { name: "reviewer-1", hostId: "laptop", documents });
    expect((await named(["global"])).status).toBe(400);
    expect((await named(["approval", "approval"])).status).toBe(400);
    expect((await named(["Approval"])).status).toBe(400);
    expect((await read("/agents")).agents).toHaveLength(1);
  });
});

describe("an agent's credentials", () => {
  let tokens: Record<string, string | null>;
  const known = (name: string, url: string | null, prefix: string): Credential => ({
    url,
    urlVar: `${prefix}_URL`,
    tokenVar: `${prefix}_TOKEN`,
    token: { value: async () => tokens[name] ?? null },
  });
  const credentials = () => ({
    "document-service": known("document-service", "https://ds", "DS"),
    "work-tracker": known("work-tracker", "https://wt", "WT"),
    "agent-service": known("agent-service", null, "AG"),
  });

  beforeEach(async () => {
    tokens = { "document-service": "ds-1", "work-tracker": "wt-1", "agent-service": "secret" };
    api = new AgentServiceApi(store, TOKEN, { now: () => now, poster, socketUrl: SOCKET, credentials: credentials() });
    await store.putConnection({ connectionId: "host", kind: "host", hostId: "laptop", connectedAt: now.toISOString() });
    await beat("laptop", { capacity: 4 });
  });

  const pushed = () => poster.to("host").flatMap((m) => (m.type === "command" && m.command.kind === "start" ? [m.command] : []));
  const everything = async (id: string) =>
    JSON.stringify([
      queued(),
      [...store.agents.values()],
      await read(`/agents/${id}`),
      await read(`/agents/${id}/commands`),
      await read(`/agents/${id}/sessions`),
      await read("/agents"),
    ]);

  it("gives an agent the services it names, their tokens only as its start is pushed to the host", async () => {
    const made = await create({ name: "reviewer-1", brief: "Review PR #18.", credentials: ["work-tracker", "agent-service"] });
    expect(made).toMatchObject({ credentials: ["work-tracker", "agent-service"] });
    const [start] = pushed();
    expect(start).toMatchObject({
      env: { WT_URL: "https://wt", AG_URL: "http://local" },
      credentials: ["work-tracker", "agent-service"],
      secrets: { WT_TOKEN: "wt-1", AG_TOKEN: "secret" },
    });
    expect(start!.env).not.toHaveProperty("DS_URL");
    expect(queued().find((c) => c.kind === "start")).not.toHaveProperty("secrets");
  });

  it("gives an agent this service at the public address it was given, not the one the request came to", async () => {
    api = new AgentServiceApi(store, TOKEN, { now: () => now, poster, socketUrl: SOCKET, credentials: credentials(), publicUrl: "https://beta.example.ts.net:8445/" });
    await create({ name: "reviewer-1", brief: "Review PR #18.", credentials: ["agent-service"] });
    expect(pushed()[0]!.env).toEqual({ AG_URL: "https://beta.example.ts.net:8445" });
  });

  it("never stores, lists or reads back a token", async () => {
    const made = await create({ name: "reviewer-1", brief: "Review PR #18.", credentials: ["work-tracker"] });
    expect(pushed()[0]).toMatchObject({ secrets: { WT_TOKEN: "wt-1" } });
    const all = await everything(made.id);
    expect(all).not.toContain("wt-1");
    expect(all).toContain("work-tracker");
  });

  it("gives an agent made without naming any today's three", async () => {
    await create({ brief: "Go." });
    expect(pushed()[0]).toMatchObject({
      env: { DS_URL: "https://ds", WT_URL: "https://wt", AG_URL: "http://local" },
      credentials: ["document-service", "work-tracker", "agent-service"],
      secrets: { DS_TOKEN: "ds-1", WT_TOKEN: "wt-1", AG_TOKEN: "secret" },
    });
  });

  it("refuses a name the stage has not, saying which it has", async () => {
    const res = await call("POST", "/agents", { name: "x-1", hostId: "laptop", credentials: ["work-tracker", "github"] });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe(
      "No credential is named github; this stage has document-service, work-tracker, agent-service.",
    );
    expect((await call("POST", "/agents", { name: "x-1", hostId: "laptop", credentials: ["work-tracker", "work-tracker"] })).status).toBe(400);
  });

  it("reads each token as each start is pushed, so a rotated one reaches the next start and its replay", async () => {
    const made = await create({ name: "reviewer-1", brief: "Go.", credentials: ["work-tracker"] });
    tokens["work-tracker"] = "wt-2";
    await store.putConnection({ connectionId: "again", kind: "host", hostId: "laptop", connectedAt: now.toISOString() });
    await new SocketHandler(store, TOKEN, poster, () => now, credentials()).handle({
      requestContext: { connectionId: "again", eventType: "MESSAGE" },
      body: JSON.stringify({ type: "ping" }),
    });
    expect(poster.to("again")).toContainEqual({ type: "command", command: expect.objectContaining({ kind: "start", secrets: { WT_TOKEN: "wt-2" } }) });
    await call("POST", `/agents/${made.id}/stop`, { force: true });
    await call("POST", `/agents/${made.id}/resume`);
    expect(pushed().at(-1)).toMatchObject({ secrets: { WT_TOKEN: "wt-2" } });
  });

  it("starts without a token it cannot read", async () => {
    tokens["work-tracker"] = null;
    await create({ brief: "Go.", credentials: ["work-tracker", "agent-service"] });
    expect(pushed()[0]!.secrets).toEqual({ AG_TOKEN: "secret" });
  });
});

describe("an agent made without naming a host", () => {
  const make = (body: object) => call("POST", "/agents", { name: "reviewer-1", ...body });

  it("is placed on the connected host with the most room, and says which", async () => {
    await beat("laptop", { capacity: 1 });
    await beat("desktop", { capacity: 3 });
    await beat("unknown");
    await beat("gone", { capacity: 9 });
    await store.putHost({ ...store.hosts.get("gone")!, heartbeatAt: new Date(now.getTime() - 120_000).toISOString() });
    const res = await make({ brief: "Go." });
    expect(res.status, await res.clone().text()).toBe(201);
    expect((await res.json()).hostId).toBe("desktop");
    expect(queued("desktop").map((c) => c.kind)).toEqual(["create", "start"]);
  });

  it("is placed only on a host carrying every label asked for", async () => {
    await beat("laptop", { capacity: 4, labels: ["macos"] });
    await beat("gpu-box", { capacity: 1, labels: ["linux", "gpu"] });
    expect((await (await make({ labels: ["gpu", "linux"] })).json()).hostId).toBe("gpu-box");
  });

  it("is not made, 503, when no host fits and has room", async () => {
    await beat("laptop", { capacity: 1, labels: ["macos"] });
    await create({ name: "agent-1", brief: "Go." });
    const full = await make({});
    expect(full.status).toBe(503);
    expect((await full.json()).error).toBe("No connected host has room for an agent; nothing was made.");
    const unlabelled = await make({ labels: ["gpu"] });
    expect(unlabelled.status).toBe(503);
    expect((await unlabelled.json()).error).toBe("No connected host, carrying gpu, has room for an agent; nothing was made.");
    expect((await read("/agents")).agents.map((w: { name: string }) => w.name)).toEqual(["agent-1"]);
  });

  it("goes where it is told with a hostId, as before, labels or not", async () => {
    await beat("laptop", { capacity: 1 });
    await beat("desktop", { capacity: 3 });
    expect((await (await make({ hostId: "laptop", labels: ["gpu"] })).json()).hostId).toBe("laptop");
  });
});

describe("a credential of an agent's own", () => {
  /** Kept as Secrets Manager would keep them, apart from the store. */
  class KeptSecrets implements AgentSecrets {
    kept = new Map<string, string>();
    async put(agentId: string, name: string, value: string) {
      this.kept.set(`${agentId}/${name}`, value);
    }
    async get(agentId: string, name: string) {
      return this.kept.get(`${agentId}/${name}`) ?? null;
    }
    async remove(agentId: string, names: string[]) {
      for (const name of names) this.kept.delete(`${agentId}/${name}`);
    }
  }
  let kept: KeptSecrets;
  const shared = (prefix: string, url: string | null, value: string): Credential => ({
    url,
    urlVar: `${prefix}_URL`,
    tokenVar: `${prefix}_TOKEN`,
    token: { value: async () => value },
  });
  const known = () => ({
    "document-service": shared("DS", "https://ds", "shared-ds"),
    "agent-service": shared("AG", null, "secret"),
  });

  beforeEach(async () => {
    kept = new KeptSecrets();
    api = new AgentServiceApi(store, TOKEN, { now: () => now, poster, socketUrl: SOCKET, credentials: known(), agentSecrets: kept });
    await store.putConnection({ connectionId: "host", kind: "host", hostId: "laptop", connectedAt: now.toISOString() });
    await beat("laptop", { capacity: 4 });
  });

  const pushed = () => poster.to("host").flatMap((m) => (m.type === "command" && m.command.kind === "start" ? [m.command] : []));
  const judge = () =>
    create({ name: "judge-1", brief: "Judge.", credentials: [{ name: "document-service", token: "judge-only" }, "agent-service"] });

  it("is given as that name's token in place of the shared one, at each start and replay", async () => {
    const made = await judge();
    expect(pushed()[0]).toMatchObject({
      env: { DS_URL: "https://ds", AG_URL: "http://local" },
      secrets: { DS_TOKEN: "judge-only", AG_TOKEN: "secret" },
    });
    await call("POST", `/agents/${made.id}/stop`, { force: true });
    await call("POST", `/agents/${made.id}/resume`);
    expect(pushed().at(-1)).toMatchObject({ secrets: { DS_TOKEN: "judge-only" } });
    await store.putConnection({ connectionId: "again", kind: "host", hostId: "laptop", connectedAt: now.toISOString() });
    await new SocketHandler(store, TOKEN, poster, () => now, known(), kept).handle({
      requestContext: { connectionId: "again", eventType: "MESSAGE" },
      body: JSON.stringify({ type: "ping" }),
    });
    expect(poster.to("again")).toContainEqual({
      type: "command",
      command: expect.objectContaining({ kind: "start", secrets: { DS_TOKEN: "judge-only", AG_TOKEN: "secret" } }),
    });
  });

  it("is never read back, listed or stored with the agent", async () => {
    const made = await judge();
    const all = JSON.stringify([
      made,
      queued(),
      [...store.agents.values()],
      await read(`/agents/${made.id}`),
      await read(`/agents/${made.id}/commands`),
      await read("/agents"),
    ]);
    expect(all).not.toContain("judge-only");
    expect(made).toMatchObject({ credentials: ["document-service", "agent-service"] });
  });

  it("is deleted when the agent is retired, as by saying it is done", async () => {
    const made = await judge();
    expect(kept.kept.size).toBe(1);
    await call("DELETE", `/agents/${made.id}`);
    expect(kept.kept.size).toBe(0);
    const reviewer = await create({ name: "reviewer-1", brief: "Go.", whenDone: "retire", credentials: [{ name: "document-service", token: "r" }] });
    await call("PUT", `/agents/${reviewer.id}/status`, { status: "done", summary: "Done." });
    await new SocketHandler(store, TOKEN, poster, () => now, known(), kept).handle({
      requestContext: { connectionId: "host", eventType: "MESSAGE" },
      body: JSON.stringify({ type: "report", agents: [{ id: reviewer.id, state: "waiting", sessionId: reviewer.session!.id }] }),
    });
    expect(await agent(reviewer.id)).toMatchObject({ state: "retired" });
    expect(kept.kept.size).toBe(0);
  });

  it("is not kept for an agent that is not made", async () => {
    await create({ name: "judge-1" });
    const res = await call("POST", "/agents", { name: "judge-1", hostId: "laptop", credentials: [{ name: "document-service", token: "x" }] });
    expect(res.status).toBe(409);
    expect(kept.kept.size).toBe(0);
  });

  it("refuses a name the stage has not, one given twice, and any where none can be kept", async () => {
    const make = (credentials: unknown) => call("POST", "/agents", { name: "x-1", hostId: "laptop", credentials });
    expect((await make([{ name: "github", token: "x" }])).status).toBe(400);
    expect((await make([{ name: "document-service", token: "x" }, "document-service"])).status).toBe(400);
    expect((await make([{ name: "document-service", token: "" }])).status).toBe(400);
    api = new AgentServiceApi(store, TOKEN, { now: () => now, poster, socketUrl: SOCKET, credentials: known() });
    const unkept = await make([{ name: "document-service", token: "x" }]);
    expect(unkept.status).toBe(503);
    expect((await unkept.json()).error).toMatch(/keeps no credential of an agent's own/);
    expect((await read("/agents")).agents).toEqual([]);
  });
});

describe("roles", () => {
  const ADMIN = "admin-secret";
  let asked: string[][];
  const known = (name: string, url: string | null, prefix: string): Credential => ({
    url,
    urlVar: `${prefix}_URL`,
    tokenVar: `${prefix}_TOKEN`,
    token: { value: async () => `${name}-token` },
  });

  beforeEach(async () => {
    asked = [];
    const context: ContextSource = {
      forSession: async (documents) => {
        asked.push(documents);
        return { context: null, documents: [], skills: [], note: null };
      },
      refuse: async (documents) => (documents.includes("nope") ? "document-service answered 404 for nope" : null),
    };
    api = new AgentServiceApi(store, TOKEN, {
      now: () => now,
      poster,
      socketUrl: SOCKET,
      context,
      admin: { value: async () => ADMIN },
      credentials: {
        "document-service": known("document-service", "https://ds", "DS"),
        "work-tracker": known("work-tracker", "https://wt", "WT"),
        "agent-service": known("agent-service", null, "AG"),
        "approval-service": known("approval-service", "https://as", "AS"),
      },
    });
    await beat("laptop", { capacity: 4 });
  });

  const start = (id: string) => queued().find((c) => c.kind === "start" && c.agentId === id) as Extract<Command, { kind: "start" }>;

  it("lists the six seeded roles, highest priority first, each with all it gives", async () => {
    const { roles } = await read("/roles");
    expect(roles.map((r: { name: string }) => r.name)).toEqual(["planner", "conflict", "investigator", "judge", "onboarder", "reviewer", "implementer"]);
    expect(roles.find((r: { name: string }) => r.name === "reviewer")).toEqual({
      name: "reviewer",
      documents: ["approval"],
      credentials: ["document-service", "work-tracker", "agent-service", "approval-service"],
      whenDone: "retire",
      label: "review",
      description: expect.stringContaining("**Started by** approval-service"),
      priority: 30,
      brief: null,
      updatedAt: null,
    });
    for (const role of roles) expect(role.description, role.name).toMatch(/\S/);
    expect(await read("/roles/implementer")).toMatchObject({ documents: ["tickets"], whenDone: "stop", priority: 10 });
    expect((await call("GET", "/roles/nobody")).status).toBe(404);
  });

  it("makes an agent from a role and a brief with exactly what the role names", async () => {
    const res = await call("POST", "/agents", { name: "reviewer-1", hostId: "laptop", role: "reviewer", brief: "Review PR #18." });
    expect(res.status).toBe(201);
    const made = await res.json();
    expect(made).toMatchObject({
      role: "reviewer",
      label: "review",
      whenDone: "retire",
      documents: ["approval"],
      credentials: ["document-service", "work-tracker", "agent-service", "approval-service"],
    });
    expect(start(made.id)).toMatchObject({
      text: "Review PR #18.",
      credentials: ["document-service", "work-tracker", "agent-service", "approval-service"],
      env: { DS_URL: "https://ds", WT_URL: "https://wt", AG_URL: "http://local", AS_URL: "https://as" },
    });
    expect(asked.at(-1)).toEqual(["approval"]);
  });

  it("takes what a caller gives over the role's, field by field", async () => {
    const made = await (
      await call("POST", "/agents", {
        name: "reviewer-1",
        hostId: "laptop",
        role: "reviewer",
        brief: "Go.",
        label: "review: PR #9",
        credentials: ["work-tracker", "approval-service"],
      })
    ).json();
    expect(made).toMatchObject({ role: "reviewer", label: "review: PR #9", documents: ["approval"], credentials: ["work-tracker", "approval-service"] });
  });

  it("starts a planner on the role's own brief, so a caller names only the role", async () => {
    const made = await (await call("POST", "/agents", { name: "planner-1", hostId: "laptop", role: "planner" })).json();
    expect(made).toMatchObject({ role: "planner", documents: ["planner"], whenDone: "stop", label: "plan: new work", state: "working" });
    expect(start(made.id).text).toContain("You are a planner");
    expect(asked.at(-1)).toEqual(["planner"]);
  });

  it("still makes an agent from explicit documents and credentials, with no role", async () => {
    const made = await create({ brief: "Go.", documents: ["tickets"], credentials: ["work-tracker"], whenDone: "stop" });
    expect(made).toMatchObject({ role: null, documents: ["tickets"], credentials: ["work-tracker"], whenDone: "stop" });
  });

  it("refuses a role the stage does not have", async () => {
    const res = await call("POST", "/agents", { name: "x-1", hostId: "laptop", role: "nobody", brief: "Go." });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("no role named nobody");
  });

  it("records an agent's role, and lists agents by it", async () => {
    await call("POST", "/agents", { name: "reviewer-1", hostId: "laptop", role: "reviewer", brief: "Go." });
    await call("POST", "/agents", { name: "judge-1", hostId: "laptop", role: "judge", brief: "Judge." });
    await create({ name: "plain-1" });
    expect((await read("/agents?role=reviewer")).agents.map((w: { name: string }) => w.name)).toEqual(["reviewer-1"]);
    expect((await read("/agents")).agents.map((w: { role: string | null }) => w.role)).toEqual(["reviewer", "judge", null]);
  });

  it("writes roles only with the admin token, which also reads", async () => {
    const role = { name: "scout", label: "scout", documents: ["tickets"], priority: 5 };
    expect((await call("POST", "/roles", role)).status).toBe(403);
    expect((await call("PATCH", "/roles/reviewer", { priority: 1 })).status).toBe(403);
    expect((await call("GET", "/roles", undefined, ADMIN)).status).toBe(200);
    expect((await call("GET", "/roles", undefined, "wrong")).status).toBe(401);

    const made = await call("POST", "/roles", role, ADMIN);
    expect(made.status).toBe(201);
    expect(await made.json()).toEqual({ ...role, credentials: null, whenDone: "keep", brief: null, description: null, updatedAt: now.toISOString() });
    expect((await call("POST", "/roles", role, ADMIN)).status).toBe(409);
    expect((await call("POST", "/roles", { ...role, name: "other", documents: ["nope"] }, ADMIN)).status).toBe(400);
    expect((await call("POST", "/roles", { ...role, name: "other", credentials: ["github"] }, ADMIN)).status).toBe(400);
  });

  it("changes a seeded role, and an agent made after gets what it names now", async () => {
    const res = await call("PATCH", "/roles/implementer", { documents: ["tickets", "approval"], priority: 15 }, ADMIN);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ name: "implementer", documents: ["tickets", "approval"], priority: 15, whenDone: "stop" });
    expect((await call("PATCH", "/roles/nobody", { priority: 1 }, ADMIN)).status).toBe(404);
    const made = await (await call("POST", "/agents", { name: "impl-1", hostId: "laptop", role: "implementer", brief: "Go." })).json();
    expect(made.documents).toEqual(["tickets", "approval"]);
  });

  it("changes a role's description, and clears it with null", async () => {
    const changed = await call("PATCH", "/roles/judge", { description: "Judges proposals." }, ADMIN);
    expect(changed.status).toBe(200);
    expect((await read("/roles/judge")).description).toBe("Judges proposals.");
    expect((await call("PATCH", "/roles/judge", { description: null }, ADMIN)).status).toBe(200);
    expect((await read("/roles/judge")).description).toBeNull();
    expect((await read("/roles")).roles.find((r: { name: string }) => r.name === "judge").description).toBeNull();
  });

  it("serves a role written before descriptions with its seed's", async () => {
    const { description: _, ...old } = SEEDED_ROLES.find((r) => r.name === "reviewer")!;
    await store.putRole({ ...old, priority: 25, updatedAt: now.toISOString() } as Role);
    const role = await read("/roles/reviewer");
    expect(role).toMatchObject({ priority: 25, description: SEEDED_ROLES.find((r) => r.name === "reviewer")!.description });
    expect(role.description).toMatch(/\S/);
  });
});
