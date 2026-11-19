import { beforeEach, describe, expect, it } from "vitest";
import { AgencyApi, type TokenSource } from "./api.ts";
import {
  expired,
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
import { sentView } from "./fleet.ts";
import type { Poster } from "./push.ts";
import { RESUME_TEXT, type Command, type SocketOutbound } from "./schema.ts";
import { SocketHandler } from "./socket.ts";
import type { ContextSource, Read } from "./context.ts";
import type { Credential } from "./credentials.ts";
import { KeyringUnreachable, type Resolving, type SecretSource } from "./keyring.ts";
import { TEST_ROLES as SEEDED_ROLES, testRoles } from "./test-roles.ts";

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
let api: AgencyApi;
let now: Date;

beforeEach(() => {
  store = new FakeStore();
  poster = new FakePoster();
  now = NOW;
  api = new AgencyApi(store, TOKEN, { now: () => now, poster, socketUrl: SOCKET });
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

/** A host's heartbeat, as its socket hands it over. */
const beat = (id: string, body: { labels?: string[]; capacity?: number } = {}) => api.beat(id, { ...EMPTY, ...body });

/** An agent's sessions and commands, as the store keeps them: no route serves them. */
const sessionsOf = async (id: string) => ({ sessions: await store.sessionsOf(id) });
const commandsOf = async (id: string) => ({ commands: (await store.sentTo(id)).filter((s) => !expired(s, now)).map((s) => sentView(s, now)) });

/** Ends the agent's live session as its host does, reporting it idle; there is no stopping one from outside. */
const endSession = async (id: string, hostId = "laptop") => {
  const live = ((await (await call("GET", `/agents/${id}`)).json()) as { session: { id: string } | null }).session;
  if (live) await report(hostId, { agents: [{ id, state: "idle", sessionId: live.id }] });
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
/** What every start carries without any honed skill: this service's address, and its own clients. */
const SELF = {
  runtime: "container",
  model: "claude-opus-5-5",
  env: { AGENCY_URL: "http://local", AG_URL: "http://local" },
  credentials: ["agency"],
  context: { key: "agency", version: expect.any(Number), files: expect.arrayContaining([expect.objectContaining({ path: "skills/page/bin/page" })]) },
};

describe("auth", () => {
  it("serves health without a token", async () => {
    expect((await api.fetch(new Request("http://local/health"))).status).toBe(200);
  });

  it("refuses a read without the token, or with the wrong one", async () => {
    expect((await api.fetch(new Request("http://local/hosts"))).status).toBe(401);
    expect((await call("GET", "/hosts", undefined, "wrong")).status).toBe(401);
  });

  it("says plainly when no token is configured", async () => {
    const unconfigured = new AgencyApi(store, { value: async () => null });
    const res = await unconfigured.fetch(new Request("http://local/hosts"));
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ message: "API token is not configured." });
  });

});

describe("heartbeat", () => {
  it("registers a host", async () => {
    await beat("laptop");
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
    await beat("bare", { labels: undefined });
    expect((await host("bare")).labels).toEqual([]);
    await beat("laptop", { labels: ["macos", "gpu"] });
    await beat("laptop", { labels: undefined });
    expect((await host("laptop")).labels).toEqual(["macos", "gpu"]);
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
    expect(await res.json()).toEqual({ code: "ResourceNotFoundException", message: "No operation is at GET /hosts/laptop." });
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
      runtime: "container",
      capability: 3,
      model: "claude-opus-5-5",
      contextTokens: null,
      overPriceStep: false,
      skills: [],
      credentials: null,
      status: null,
      summary: null,
      headline: null,
      saidAt: null,
      activity: null,
      tasks: 0,
      told: null,
      limitedUntil: null,
      lifetimeCostUsd: null,
      sessionCount: 0,
      hostStatus: "connected",
      currentSession: null,
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
    expect(made.session).toEqual({ id: expect.any(String), startedAt: NOW.toISOString(), skills: [], contextNote: null });
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
    expect(await sessionsOf(made.id)).toEqual({
      sessions: [
        {
          id: made.session!.id,
          agentId: made.id,
          startedAt: NOW.toISOString(),
          endedAt: null,
          ended: null,
          agentName: "frontend-1",
          role: null,
          item: null,
          capability: 3,
          model: "claude-opus-5-5",
          capabilityChanges: [],
          tokens: { inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 },
          activeMs: 0,
          turns: 0,
          endReason: null,
          skills: [],
          clients: { version: expect.any(Number), commit: expect.any(String) },
          contextNote: null,
        },
      ],
    });
  });

  it("refuses a name an agent not deleted has, and frees it on deletion", async () => {
    const first = await create();
    const res = await call("POST", "/agents", { name: "frontend-1", hostId: "laptop" });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ message: "An agent not deleted is already named frontend-1." });
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
    expect(await full.json()).toMatchObject({ message: "laptop is running all 1 sessions it will." });
    await create({ name: "c" });

    later(LOST_AFTER + 1);
    const lost = await call("POST", "/agents", { name: "d", hostId: "laptop" });
    expect(lost.status).toBe(409);
    expect((await lost.json()).message).toMatch(/^laptop has not sent a heartbeat since/);
  });

  it("refuses a brief longer than a message may be, rather than cutting it", async () => {
    const res = await call("POST", "/agents", { name: "a", hostId: "laptop", brief: "x".repeat(TEXT_LIMIT + 1) });
    expect(res.status).toBe(400);
    expect(store.agents.size).toBe(0);
  });
});

describe("listing agents", () => {
  it("leaves out the deleted unless asked, and takes no host or state filter", async () => {
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
    expect(await names("?state=deleted")).toEqual(["a", "b"]);
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

  it("lists every agent started on it, deleted ones included, and no other", async () => {
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
    const sent = (await commandsOf(id)).commands;
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
    const [first] = (await sessionsOf(id)).sessions;
    expect(first).toMatchObject({ id: sessionId, ended: "stopped", endedAt: NOW.toISOString() });

    const res = await call("POST", `/agents/${id}/messages`, { text: "Again." });
    expect(res.status).toBe(202);
    const again = (await agent(id)).session.id;
    await reports([{ id, state: "interrupted", sessionId: again }]);
    expect(await agent(id)).toMatchObject({ state: "interrupted", session: null });
    expect((await sessionsOf(id)).sessions[1]).toMatchObject({ id: again, ended: "interrupted" });
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
    const sent = (await commandsOf(id)).commands;
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
    await endSession(id);
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
    expect((await call("POST", `/agents/${id}/messages`, { text: "Again." })).status).toBe(202);
    expect((await agent(id)).status).toBe("working");
  });

  it("is deleted when made to delete once its turn ends, its name freed, reading done", async () => {
    await make("delete");
    const res = await done();
    expect(res.status, await res.clone().text()).toBe(200);
    expect(await res.json()).toMatchObject({ state: "working", status: "done" });
    await quiet();
    expect(await agent(id)).toMatchObject({ state: "deleted", status: "done", summary: "Approved PR #18." });
    expect(queued().filter((c) => c.agentId === id).map((c) => c.kind)).toEqual(["create", "start", "stop", "delete"]);
    expect((await sessionsOf(id)).sessions[0]).toMatchObject({ ended: "stopped" });
    expect((await call("POST", "/agents", { name: "frontend-1", hostId: "laptop" })).status).toBe(201);
  });

  it("does not read done when its session ends without saying so", async () => {
    await make("delete");
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

  it("in review, is stopped but never deleted when made to delete, and still reads review once its session has ended", async () => {
    await make("delete");
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
    expect(await res.json()).toMatchObject({ message: "frontend-1 is idle, with no session to interrupt." });
    expect((await message({ text: "x", interupt: true })).status).toBe(400);
    expect((await message({})).status).toBe(400);
  });

  it("refuses a start on a full host, and anything for a lost one or a deleted agent", async () => {
    await create({ name: "busy", brief: "Go." });
    const full = await message({ text: "Go." });
    expect(full.status).toBe(409);
    later(LOST_AFTER + 1);
    expect((await message({ text: "Go." })).status).toBe(409);
    await call("DELETE", `/agents/${id}`);
    expect(await (await message({ text: "Go." })).json()).toMatchObject({ message: "frontend-1 is deleted." });
  });

  it("withdraws a message its lost host never took, but keeps offering a create", async () => {
    await message({ text: "Go." });
    const { commandId } = await (await message({ text: "Late." })).json();
    later(LOST_AFTER + 1);
    const sent = (await commandsOf(id)).commands;
    expect(sent.find((s: { command: { id: string } }) => s.command.id === commandId)!.delivery).toBe("withdrawn");
    expect((await replayed()).map((c) => c.kind)).toEqual(["create"]);
  });

  it("keeps a command's record for its time and no longer", async () => {
    later(KEPT_FOR + 1);
    expect((await commandsOf(id)).commands).toEqual([]);
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

  it("refuses a name another agent holds, and a deleted agent", async () => {
    const one = await create({ name: "agent-1" });
    await create({ name: "agent-2" });
    const taken = await call("PATCH", `/agents/${one.id}`, { name: "agent-2" });
    expect(taken.status).toBe(409);
    expect((await taken.json()).message).toBe("An agent not deleted is already named agent-2.");
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
    expect((await again.json()).message).toBe('agent-3 is titled "Short status headline" already; only the person changes it.');
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

  it("survives its session ending and a new one starting", async () => {
    await name("Short status headline");
    await endSession(id);
    expect((await agent(id)).title).toBe("Short status headline");
    expect((await call("POST", `/agents/${id}/messages`, { text: "Again." })).status).toBe(202);
    expect(await agent(id)).toMatchObject({ state: "working", title: "Short status headline" });
  });

  it("refuses a title too long or empty, and a deleted agent", async () => {
    expect((await name("x".repeat(TITLE_LIMIT + 1))).status).toBe(400);
    expect((await name("  ")).status).toBe(400);
    await call("DELETE", `/agents/${id}`);
    expect((await name("Too late")).status).toBe(409);
  });
});

describe("deleting an agent", () => {
  it("records it deleted at once, ends its session, and queues a stop and then delete", async () => {
    await beat("laptop");
    const made = await create({ brief: "Go." });
    const res = await call("DELETE", `/agents/${made.id}`);
    expect(res.status).toBe(202);
    const { commandId } = await res.json();
    expect(queued().map((c) => c.kind)).toEqual(["create", "start", "stop", "delete"]);
    expect(queued().at(-1)!.id).toBe(commandId);
    expect(await agent(made.id)).toMatchObject({ state: "deleted", session: null });
    expect((await sessionsOf(made.id)).sessions[0]!.ended).toBe("stopped");
    expect((await call("DELETE", `/agents/${made.id}`)).status).toBe(409);

    // Whatever its host still says of it, it stays deleted.
    await report("laptop", { agents: [{ id: made.id, state: "working", sessionId: made.session!.id }] });
    expect((await agent(made.id)).state).toBe("deleted");
    expect(queued().filter((c) => c.kind === "stop")).toHaveLength(1);
  });

  it("offers delete to a lost host for as long as it takes", async () => {
    await beat("laptop");
    const made = await create();
    later(LOST_AFTER + 1);
    expect((await call("DELETE", `/agents/${made.id}`)).status).toBe(202);
    later(LOST_AFTER * 10);
    expect((await replayed()).map((c) => c.kind)).toEqual(["create", "delete"]);
  });
});

describe("stopping an agent", () => {
  it("ends its session at once, queues a stop, keeps the agent, and a message starts it again", async () => {
    await beat("laptop");
    const made = await create({ brief: "Go." });
    const res = await call("POST", `/agents/${made.id}/stop`);
    expect(res.status).toBe(202);
    const { commandId } = await res.json();
    expect(queued().map((c) => c.kind)).toEqual(["create", "start", "stop"]);
    expect(queued().at(-1)!.id).toBe(commandId);
    expect(await agent(made.id)).toMatchObject({ state: "idle", session: null, name: made.name });
    expect((await sessionsOf(made.id)).sessions[0]!.ended).toBe("stopped");
    expect((await call("POST", `/agents/${made.id}/stop`)).status).toBe(409);

    // Should its host still run the session, it stays stopped, and is told to stop once.
    await report("laptop", { agents: [{ id: made.id, state: "working", sessionId: made.session!.id }] });
    expect((await agent(made.id)).state).toBe("idle");

    expect((await call("POST", `/agents/${made.id}/messages`, { text: "Carry on." })).status).toBe(202);
    expect(queued().at(-1)!.kind).toBe("start");
    expect((await agent(made.id)).state).toBe("working");
  });

  it("refuses an unknown or deleted agent", async () => {
    await beat("laptop");
    const made = await create();
    expect((await call("POST", `/agents/${crypto.randomUUID()}/stop`)).status).toBe(404);
    await call("DELETE", `/agents/${made.id}`);
    expect((await call("POST", `/agents/${made.id}/stop`)).status).toBe(409);
  });
});

describe("a write racing a report or a delete", () => {
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
  const deleted = async () => expect((await call("DELETE", `/agents/${id}`)).status).toBe(202);
  const keptDeleted = async () => {
    expect(await agent(id)).toMatchObject({ state: "deleted", session: null });
    expect((await call("POST", "/agents", { name: "frontend-1", hostId: "laptop" })).status).toBe(201);
  };

  const routes: [string, () => Promise<Res>][] = [
    ["a message", () => call("POST", `/agents/${id}/messages`, { text: "And this." })],
    ["a title", () => call("PUT", `/agents/${id}/title`, { title: "Guarded writes" })],
    ["a rename", () => call("PATCH", `/agents/${id}`, { name: "scout", label: "racing" })],
  ];

  for (const [what, send] of routes) {
    it(`keeps what a report wrote between ${what}'s read and its write`, async () => {
      afterGetting(turnEnds);
      const res = await send();
      expect(res.status, await res.clone().text()).toBeLessThan(300);
      expect(store.agents.get(id)).toMatchObject({ begun: sessionId, activity: { text: "Reading schema.ts." } });
    });

    it(`refuses ${what} once a delete lands between its read and its write`, async () => {
      afterGetting(deleted);
      expect((await send()).status).toBe(409);
      await keptDeleted();
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
    expect((await sessionsOf(id)).sessions.find((s: { id: string }) => s.id === sessionId)!.ended).toBe("stopped");
  });

  describe("with no session", () => {
    beforeEach(async () => {
      await endSession(id);
    });

    const idleLine = () => report("laptop", { agents: [{ id, state: "idle", sessionId: null }], lines: [line()] });

    for (const [what, send] of [
      ["a message's start", () => call("POST", `/agents/${id}/messages`, { text: "Again." })],
    ] as [string, () => Promise<Res>][]) {
      it(`keeps what a report wrote between ${what}'s read and its write`, async () => {
        afterGetting(idleLine);
        expect((await send()).status).toBe(202);
        expect(store.agents.get(id)).toMatchObject({ state: "working", activity: { text: "Reading schema.ts." } });
      });

      it(`refuses ${what} once a delete lands between its read and its write`, async () => {
        afterGetting(deleted);
        expect((await send()).status).toBe(409);
        await keptDeleted();
      });
    }
  });

  it("deletes an agent a report wrote between the delete's read and its write, keeping what it wrote", async () => {
    afterGetting(turnEnds);
    expect((await call("DELETE", `/agents/${id}`)).status).toBe(202);
    expect(store.agents.get(id)).toMatchObject({ state: "deleted", begun: sessionId, activity: { text: "Reading schema.ts." } });
    await keptDeleted();
  });

  it("refuses a delete once another lands between its read and its write", async () => {
    afterGetting(deleted);
    expect((await call("DELETE", `/agents/${id}`)).status).toBe(409);
    expect(queued().filter((c) => c.kind === "delete")).toHaveLength(1);
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
    api = new AgencyApi(store, TOKEN, { now: () => now });
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
  const PLANNER = { key: "agent-roles/planner", version: 4, files: [{ path: "skills/planner/SKILL.md", content: "Plan.", executable: false }] };
  let given: Read;
  let asked: string[][];
  let id: string;

  beforeEach(async () => {
    given = { skills: [PLANNER], note: null };
    asked = [];
    const context: ContextSource = {
      forSession: async (skills) => {
        asked.push(skills);
        return given;
      },
      refuse: async (skills) => (skills.includes("team/nope") ? "honed has no skill named team/nope" : null),
    };
    api = new AgencyApi(store, TOKEN, { now: () => now, poster, socketUrl: SOCKET, context, roles: testRoles() });
    await beat("laptop", { capacity: 1 });
    id = (await create({ skills: ["agent-roles/planner"] })).id;
  });

  it("gives each start the skills the agent names and this service's clients, and records them on the session", async () => {
    await call("POST", `/agents/${id}/messages`, { text: "Go." });
    expect(asked.at(-1)).toEqual(["agent-roles/planner"]);
    const start = queued().find((c) => c.kind === "start") as Extract<Command, { kind: "start" }>;
    expect(start.documents).toEqual([PLANNER]);
    expect(start.context?.files.map((f) => f.path)).toEqual(expect.arrayContaining(["skills/page/SKILL.md", "skills/page/bin/page", "skills/title/bin/title"]));
    const [session] = (await sessionsOf(id)).sessions;
    expect(session).toMatchObject({ skills: [{ name: "agent-roles/planner", version: 4 }], clients: { commit: expect.any(String) }, contextNote: null });
    expect(session).not.toHaveProperty("context");
  });

  it("says on the session why a skill was left out", async () => {
    given = { skills: [], note: "honed has no skill named agent-roles/planner" };
    await call("POST", `/agents/${id}/messages`, { text: "Go." });
    const [session] = (await sessionsOf(id)).sessions;
    expect(session).toMatchObject({ skills: [], contextNote: "honed has no skill named agent-roles/planner" });
  });

  it("refuses a skill honed does not have, and a name that is not one", async () => {
    const named = (skills: string[]) => call("POST", "/agents", { name: "reviewer-1", hostId: "laptop", skills });
    const res = await named(["team/nope"]);
    expect(res.status).toBe(400);
    expect((await res.json()).message).toBe("honed has no skill named team/nope");
    expect((await named(["a", "a"])).status).toBe(400);
    expect((await named(["a/b/c"])).status).toBe(400);
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
    agency: known("agency", null, "AG"),
  });

  beforeEach(async () => {
    tokens = { "document-service": "ds-1", "work-tracker": "wt-1", "agency": "secret" };
    api = new AgencyApi(store, TOKEN, { now: () => now, poster, socketUrl: SOCKET, credentials: credentials() });
    await store.putConnection({ connectionId: "host", kind: "host", hostId: "laptop", connectedAt: now.toISOString() });
    await beat("laptop", { capacity: 4 });
  });

  const pushed = () => poster.to("host").flatMap((m) => (m.type === "command" && m.command.kind === "start" ? [m.command] : []));
  const everything = async (id: string) =>
    JSON.stringify([
      queued(),
      [...store.agents.values()],
      await read(`/agents/${id}`),
      await commandsOf(id),
      await sessionsOf(id),
      await read("/agents"),
    ]);

  it("gives an agent the services it names, their tokens only as its start is pushed to the host", async () => {
    const made = await create({ name: "reviewer-1", brief: "Review PR #18.", credentials: ["work-tracker", "agency"] });
    expect(made).toMatchObject({ credentials: ["work-tracker", "agency"] });
    const [start] = pushed();
    expect(start).toMatchObject({
      env: { WT_URL: "https://wt", AG_URL: "http://local" },
      credentials: ["work-tracker", "agency"],
      secrets: { WT_TOKEN: "wt-1", AG_TOKEN: "secret" },
    });
    expect(start!.env).not.toHaveProperty("DS_URL");
    expect(queued().find((c) => c.kind === "start")).not.toHaveProperty("secrets");
  });

  describe("of a service with an instance on some hosts", () => {
    const starts = (hostId: string) => queued(hostId).filter((c): c is Extract<Command, { kind: "start" }> => c.kind === "start");

    beforeEach(async () => {
      api = new AgencyApi(store, TOKEN, {
        now: () => now,
        poster,
        socketUrl: SOCKET,
        credentials: { ...credentials(), "work-tracker": { ...known("work-tracker", "https://wt", "WT"), urlByHost: { desktop: "https://wt-desktop" }, mcp: "/mcp" } },
      });
      await beat("desktop", { capacity: 4 });
    });

    it("gives a session on a host it names that host's address, and one on any other host its url", async () => {
      await create({ name: "on-desktop", hostId: "desktop", brief: "Go.", credentials: ["work-tracker", "document-service"] });
      await create({ name: "on-laptop", hostId: "laptop", brief: "Go.", credentials: ["work-tracker", "document-service"] });
      expect(starts("desktop")[0]!.env).toEqual({ WT_URL: "https://wt-desktop", DS_URL: "https://ds" });
      expect(starts("laptop")[0]!.env).toEqual({ WT_URL: "https://wt", DS_URL: "https://ds" });
      expect(starts("desktop")[0]!.mcpServers).toMatchObject({ "work-tracker": { url: "${WT_URL}/mcp" } });
    });

    it("gives a resumed session, messaged or past its usage limit, the same address as a new one", async () => {
      const made = await create({ name: "on-desktop", hostId: "desktop", brief: "Go.", credentials: ["work-tracker"] });
      await endSession(made.id, "desktop");
      await call("POST", `/agents/${made.id}/messages`, { text: "Again." });
      expect(starts("desktop").at(-1)).toMatchObject({ resume: true, env: { WT_URL: "https://wt-desktop" } });
      const live = (await agent(made.id)).session.id;
      await report("desktop", { agents: [{ id: made.id, state: "idle", sessionId: live, limitedUntil: new Date(now.getTime() + 60_000).toISOString() }] });
      later(121);
      expect(await api.resume(() => {})).toEqual(["on-desktop"]);
      expect(starts("desktop").at(-1)).toMatchObject({ resume: true, text: RESUME_TEXT, env: { WT_URL: "https://wt-desktop" } });
      expect(starts("desktop")).toHaveLength(3);
    });
  });

  it("gives an agent this service at the public address it was given, not the one the request came to, by its former name too", async () => {
    api = new AgencyApi(store, TOKEN, { now: () => now, poster, socketUrl: SOCKET, credentials: credentials(), publicUrl: "https://beta.example.ts.net:8445/" });
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
      credentials: ["document-service", "work-tracker", "agency"],
      secrets: { DS_TOKEN: "ds-1", WT_TOKEN: "wt-1", AG_TOKEN: "secret" },
    });
  });

  it("refuses a name the stage has not, saying which it has", async () => {
    const res = await call("POST", "/agents", { name: "x-1", hostId: "laptop", credentials: ["work-tracker", "github"] });
    expect(res.status).toBe(400);
    expect((await res.json()).message).toBe(
      "No credential is named github; this stage has document-service, work-tracker, agency.",
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
    await endSession(made.id);
    await call("POST", `/agents/${made.id}/messages`, { text: "Again." });
    expect(pushed().at(-1)).toMatchObject({ secrets: { WT_TOKEN: "wt-2" } });
  });

  it("names the agent as `x-actor` to every MCP server of every start, new or resumed, beside the token's reference and never the token", async () => {
    api = new AgencyApi(store, TOKEN, {
      now: () => now,
      poster,
      socketUrl: SOCKET,
      credentials: { ...credentials(), "work-tracker": { ...known("work-tracker", "https://wt", "WT"), mcp: "/mcp" }, agency: { ...known("agency", null, "AG"), mcp: "/mcp" } },
    });
    const made = await create({ name: "planner-7", brief: "Plan it.", credentials: ["work-tracker", "agency", "document-service"] });
    const servers = {
      "work-tracker": { type: "http", url: "${WT_URL}/mcp", headers: { Authorization: "Bearer ${WT_TOKEN}", "x-actor": "planner-7" } },
      agency: { type: "http", url: "${AG_URL}/mcp", headers: { Authorization: "Bearer ${AG_TOKEN}", "x-actor": "planner-7" } },
    };
    expect(pushed()[0]).toMatchObject({ resume: false, mcpServers: servers });
    await endSession(made.id);
    await call("POST", `/agents/${made.id}/messages`, { text: "Again." });
    expect(pushed().at(-1)).toMatchObject({ resume: true, mcpServers: servers });
    const configs = JSON.stringify(pushed().map((c) => c.mcpServers));
    for (const token of ["wt-1", "secret", "ds-1"]) expect(configs).not.toContain(token);
  });

  describe("with keyring", () => {
    let asked: Resolving[];
    let answer: () => Record<string, string>;
    const keyring: SecretSource = {
      resolve: async (who) => {
        asked.push(who);
        return answer();
      },
    };

    beforeEach(() => {
      asked = [];
      answer = () => ({ GH_TOKEN: "gh-secret-1" });
      api = new AgencyApi(store, TOKEN, { now: () => now, poster, socketUrl: SOCKET, credentials: credentials(), keyring });
    });

    it("resolves for the agent, its role and its host's labels, and lets keyring's value win over the services'", async () => {
      await beat("laptop", { capacity: 4, labels: ["gpu"] });
      answer = () => ({ GH_TOKEN: "gh-secret-1", WT_TOKEN: "from-keyring" });
      await create({ name: "planner-1", brief: "Go.", credentials: ["work-tracker"] });
      expect(asked).toEqual([{ agent: "planner-1", role: null, labels: ["gpu"] }]);
      expect(pushed()[0]!.secrets).toEqual({ WT_TOKEN: "from-keyring", GH_TOKEN: "gh-secret-1" });
    });

    it("resolves again for a resumed session, and records only the variable names", async () => {
      const made = await create({ name: "planner-1", brief: "Go.", credentials: [] });
      await endSession(made.id);
      answer = () => ({ GH_TOKEN: "gh-secret-2" });
      await call("POST", `/agents/${made.id}/messages`, { text: "Again." });
      expect(asked).toHaveLength(2);
      expect(pushed().at(-1)!.secrets).toEqual({ GH_TOKEN: "gh-secret-2" });
      expect((await sessionsOf(made.id)).sessions).toContainEqual(expect.objectContaining({ secretNames: ["GH_TOKEN"] }));
      const all = await everything(made.id);
      expect(all).not.toContain("gh-secret");
      expect(all).toContain("GH_TOKEN");
    });

    it("does not start a new agent while keyring is unreachable, saying why", async () => {
      answer = () => {
        throw new KeyringUnreachable("fetch failed");
      };
      const res = await call("POST", "/agents", { name: "planner-1", hostId: "laptop", brief: "Go." });
      expect(res.status).toBe(503);
      expect((await res.json()).message).toContain("keyring unreachable");
      expect(pushed()).toHaveLength(0);
    });

    it("does not start or resume a message's session while keyring is unreachable, and the agent stays idle", async () => {
      const made = await create({ name: "planner-1", brief: "Go." });
      await endSession(made.id);
      const before = pushed().length;
      answer = () => {
        throw new KeyringUnreachable("fetch failed");
      };
      const res = await call("POST", `/agents/${made.id}/messages`, { text: "Again." });
      expect(await res.text()).toContain("keyring unreachable");
      expect(pushed()).toHaveLength(before);
      expect((await agent(made.id)).session).toBeNull();
    });

    describe("when its host holds a session it will not run without secrets", () => {
      const needs = async (id: string, sessionId: string) => {
        const connectionId = "restarted";
        await store.putConnection({ connectionId, kind: "host", hostId: "laptop", connectedAt: now.toISOString() });
        await new SocketHandler(store, TOKEN, poster, () => now, credentials(), undefined, undefined, undefined, keyring, () => api.restartWaiting(() => {})).handle({
          requestContext: { connectionId, eventType: "MESSAGE" },
          body: JSON.stringify({ type: "report", agents: [{ id, state: "waiting", sessionId, needsStart: true }] }),
        });
      };

      it("answers with a start that resumes it, carrying freshly resolved secrets, and does not ask twice", async () => {
        const made = await create({ name: "planner-1", brief: "Go." });
        const old = (await agent(made.id)).session.id;
        answer = () => ({ GH_TOKEN: "after-restart" });
        await needs(made.id, old);
        const starts = pushed();
        expect(starts).toHaveLength(2);
        expect(starts[1]).toMatchObject({ resume: true, secrets: { GH_TOKEN: "after-restart" } });
        expect(starts[1]!.sessionId).not.toBe(old);
        expect((await agent(made.id)).session.id).toBe(starts[1]!.sessionId);
        // The host still reports the old session until it takes the start: nothing more is sent.
        await needs(made.id, old);
        expect(pushed()).toHaveLength(2);
        expect(await everything(made.id)).not.toContain("after-restart");
      });

      it("waits, saying keyring is unreachable, and starts it once keyring answers", async () => {
        const made = await create({ name: "planner-1", brief: "Go." });
        const old = (await agent(made.id)).session.id;
        answer = () => {
          throw new KeyringUnreachable("fetch failed");
        };
        await needs(made.id, old);
        expect(pushed()).toHaveLength(1);
        expect(JSON.stringify(await agent(made.id))).toContain("keyring unreachable");
        answer = () => ({ GH_TOKEN: "back" });
        expect(await api.restartWaiting(() => {})).toEqual(["planner-1"]);
        expect(pushed()[1]).toMatchObject({ resume: true, secrets: { GH_TOKEN: "back" } });
      });
    });

    it("withholds a replayed start it cannot resolve, rather than sending it without its secrets", async () => {
      await create({ name: "planner-1", brief: "Go." });
      answer = () => {
        throw new KeyringUnreachable("fetch failed");
      };
      await store.putConnection({ connectionId: "again", kind: "host", hostId: "laptop", connectedAt: now.toISOString() });
      await new SocketHandler(store, TOKEN, poster, () => now, credentials(), undefined, undefined, undefined, keyring).handle({
        requestContext: { connectionId: "again", eventType: "MESSAGE" },
        body: JSON.stringify({ type: "ping" }),
      });
      expect(poster.to("again").filter((m) => m.type === "command" && m.command.kind === "start")).toEqual([]);
    });
  });

  it("starts without a token it cannot read", async () => {
    tokens["work-tracker"] = null;
    await create({ brief: "Go.", credentials: ["work-tracker", "agency"] });
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
    expect((await full.json()).message).toBe("No connected host has room for an agent; nothing was made.");
    const unlabelled = await make({ labels: ["gpu"] });
    expect(unlabelled.status).toBe(503);
    expect((await unlabelled.json()).message).toBe("No connected host, carrying gpu, has room for an agent; nothing was made.");
    expect((await read("/agents")).agents.map((w: { name: string }) => w.name)).toEqual(["agent-1"]);
  });

  it("goes where it is told with a hostId, as before, labels or not", async () => {
    await beat("laptop", { capacity: 1 });
    await beat("desktop", { capacity: 3 });
    expect((await (await make({ hostId: "laptop", labels: ["gpu"] })).json()).hostId).toBe("laptop");
  });
});

describe("an agent's runtime", () => {
  beforeEach(async () => {
    api = new AgencyApi(store, TOKEN, { now: () => now, poster, socketUrl: SOCKET, defaultRuntime: "container" });
    await beat("laptop", { capacity: 4, labels: ["linux", "runtime:host"] });
  });

  const startOf = (id: string) => queued().filter((c) => c.kind === "start" && c.agentId === id).at(-1);

  it("is the stage's default without the runtime:host label, and in its start", async () => {
    const made = await create({ brief: "Go." });
    expect((await agent(made.id)).runtime).toBe("container");
    expect(startOf(made.id)).toMatchObject({ kind: "start", runtime: "container" });
  });

  it("is host with the runtime:host label, placed or not", async () => {
    const placed = await call("POST", "/agents", { name: "placed-1", labels: ["runtime:host"], brief: "Go." });
    expect(placed.status, await placed.clone().text()).toBe(201);
    const { id, hostId, runtime } = await placed.json();
    expect({ hostId, runtime }).toEqual({ hostId: "laptop", runtime: "host" });
    expect(startOf(id)).toMatchObject({ runtime: "host" });
    const named = await create({ name: "named-1", labels: ["runtime:host"] });
    expect((await agent(named.id)).runtime).toBe("host");
    expect((await read("/agents")).agents.map((a: { runtime: string }) => a.runtime).sort()).toEqual(["host", "host"]);
  });

  it("is kept for its life: a resumed session runs where its first did", async () => {
    const made = await create({ labels: ["runtime:host"], brief: "Go." });
    await endSession(made.id);
    api = new AgencyApi(store, TOKEN, { now: () => now, poster, socketUrl: SOCKET, defaultRuntime: "container" });
    const res = await call("POST", `/agents/${made.id}/messages`, { text: "Carry on." });
    expect(res.status).toBe(202);
    expect(startOf(made.id)).toMatchObject({ resume: true, runtime: "host" });
    expect((await agent(made.id)).runtime).toBe("host");
  });

  it("is host for an agent recorded before runtimes were chosen", async () => {
    const made = await create();
    const { runtime: _, ...before } = store.agents.get(made.id)!;
    store.plant(before);
    expect((await agent(made.id)).runtime).toBe("host");
    await call("POST", `/agents/${made.id}/messages`, { text: "Go." });
    expect(startOf(made.id)).toMatchObject({ runtime: "host" });
  });
});

describe("roles", () => {
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
      forSession: async (skills) => {
        asked.push(skills);
        return { skills: [], note: null };
      },
      refuse: async (skills) => (skills.includes("team/nope") ? "honed has no skill named team/nope" : null),
    };
    api = new AgencyApi(store, TOKEN, {
      now: () => now,
      poster,
      socketUrl: SOCKET,
      context,
      roles: testRoles(),
      credentials: {
        "document-service": known("document-service", "https://ds", "DS"),
        "work-tracker": known("work-tracker", "https://wt", "WT"),
        agency: known("agency", null, "AG"),
        "approval-service": known("approval-service", "https://as", "AS"),
      },
    });
    await beat("laptop", { capacity: 4 });
  });

  const start = (id: string) => queued().find((c) => c.kind === "start" && c.agentId === id) as Extract<Command, { kind: "start" }>;

  it("lists the roles its source gives, highest priority first, each with all it gives", async () => {
    const { roles } = await read("/roles");
    expect(roles.map((r: { name: string }) => r.name)).toEqual(["planner", "onboarder", "reviewer", "implementer"]);
    expect(roles.find((r: { name: string }) => r.name === "reviewer")).toEqual(SEEDED_ROLES.find((r) => r.name === "reviewer"));
    expect(await read("/roles/implementer")).toMatchObject({ skills: ["agent-roles/implementer"], whenDone: "stop", priority: 10 });
    expect((await call("GET", "/roles/nobody")).status).toBe(404);
  });

  it("has no operation that writes a role: they are changed in honed", async () => {
    expect((await call("POST", "/roles", { name: "scout", label: "scout", priority: 5 })).status).toBe(404);
    expect((await call("PATCH", "/roles/reviewer", { priority: 1 })).status).toBe(404);
  });

  it("makes an agent from a role and a brief with exactly what the role names", async () => {
    const res = await call("POST", "/agents", { name: "reviewer-1", hostId: "laptop", role: "reviewer", brief: "Review PR #18." });
    expect(res.status).toBe(201);
    const made = await res.json();
    expect(made).toMatchObject({
      role: "reviewer",
      label: "review",
      whenDone: "delete",
      skills: ["agent-roles/reviewer"],
      // Naming none, it is given every service the stage has, at each start.
      credentials: null,
    });
    expect(start(made.id)).toMatchObject({
      text: "Review PR #18.",
      credentials: ["document-service", "work-tracker", "agency", "approval-service"],
      env: { DS_URL: "https://ds", WT_URL: "https://wt", AG_URL: "http://local", AS_URL: "https://as" },
    });
    expect(asked.at(-1)).toEqual(["agent-roles/reviewer"]);
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
    expect(made).toMatchObject({ role: "reviewer", label: "review: PR #9", skills: ["agent-roles/reviewer"], credentials: ["work-tracker", "approval-service"] });
  });

  it("starts a planner on the role's own brief, so a caller names only the role", async () => {
    const made = await (await call("POST", "/agents", { name: "planner-1", hostId: "laptop", role: "planner" })).json();
    expect(made).toMatchObject({ role: "planner", skills: ["agent-roles/planner"], whenDone: "stop", label: "plan: new work", state: "working" });
    expect(start(made.id).text).toContain("You are a planner");
    expect(asked.at(-1)).toEqual(["agent-roles/planner"]);
  });

  it("still makes an agent from explicit skills and credentials, with no role", async () => {
    const made = await create({ brief: "Go.", skills: ["team/tickets"], credentials: ["work-tracker"], whenDone: "stop" });
    expect(made).toMatchObject({ role: null, skills: ["team/tickets"], credentials: ["work-tracker"], whenDone: "stop" });
  });

  it("refuses a role the stage does not have", async () => {
    const res = await call("POST", "/agents", { name: "x-1", hostId: "laptop", role: "nobody", brief: "Go." });
    expect(res.status).toBe(400);
    expect((await res.json()).message).toContain("no role named nobody");
  });

  it("records an agent's role, and lists agents by it", async () => {
    await call("POST", "/agents", { name: "reviewer-1", hostId: "laptop", role: "reviewer", brief: "Go." });
    await call("POST", "/agents", { name: "onboarder-1", hostId: "laptop", role: "onboarder", brief: "Onboard." });
    await create({ name: "plain-1" });
    expect((await read("/agents?role=reviewer")).agents.map((w: { name: string }) => w.name)).toEqual(["reviewer-1"]);
    expect((await read("/agents")).agents.map((w: { role: string | null }) => w.role)).toEqual(["reviewer", "onboarder", null]);
  });
});

describe("an agent a usage limit stopped", () => {
  let id: string;
  let sessionId: string;
  const resets = () => new Date(now.getTime() + 60 * 1000).toISOString();
  let logged: string[];
  const resume = () => api.resume((l) => logged.push(l));
  const resumes = () => queued().filter((c) => "text" in c && c.text === RESUME_TEXT);

  beforeEach(async () => {
    logged = [];
    await beat("laptop", { capacity: 2 });
    const made = await create({ brief: "Go." });
    id = made.id;
    sessionId = made.session!.id;
    await report("laptop", { commandResults: ack(queued()) });
  });

  it("keeps when its limit resets as its host reports, serves it, and clears it on a report without it", async () => {
    const until = resets();
    await report("laptop", { agents: [{ id, state: "waiting", sessionId, limitedUntil: until }] });
    expect((await agent(id)).limitedUntil).toBe(until);
    expect((await read("/agents")).agents[0].limitedUntil).toBe(until);
    await report("laptop", { agents: [{ id, state: "waiting", sessionId }] });
    expect((await agent(id)).limitedUntil).toBeNull();
    await report("laptop", { agents: [{ id, state: "waiting", sessionId, limitedUntil: until }] });
    await report("laptop", { agents: [{ id, state: "waiting", sessionId, limitedUntil: null }] });
    expect((await agent(id)).limitedUntil).toBeNull();
  });

  it("sends a live session one message once its limit is over a minute past, and clears it", async () => {
    const until = resets();
    await report("laptop", { agents: [{ id, state: "waiting", sessionId, limitedUntil: until }] });
    later(60);
    expect(await resume()).toEqual([]);
    later(61);
    expect(await resume()).toEqual(["frontend-1"]);
    expect(resumes()).toEqual([{ kind: "message", id: expect.any(String), agentId: id, text: RESUME_TEXT }]);
    expect(await agent(id)).toMatchObject({ limitedUntil: null, state: "working" });
    expect(logged.map((l) => JSON.parse(l))).toEqual([{ resumed: "frontend-1", limitedUntil: until }]);
    later(60);
    expect(await resume()).toEqual([]);
    expect(resumes()).toHaveLength(1);
  });

  it("does not take back a limit it resumed from that a report sent before the resume carries", async () => {
    const until = resets();
    await report("laptop", { agents: [{ id, state: "waiting", sessionId, limitedUntil: until }] });
    later(121);
    await resume();
    await report("laptop", { agents: [{ id, state: "waiting", sessionId, limitedUntil: until }] });
    expect((await agent(id)).limitedUntil).toBeNull();
    const next = resets();
    await report("laptop", { agents: [{ id, state: "waiting", sessionId, limitedUntil: next }] });
    expect((await agent(id)).limitedUntil).toBe(next);
  });

  it("starts one with no live session resuming its last conversation with the message", async () => {
    const until = resets();
    await report("laptop", { agents: [{ id, state: "idle", sessionId, limitedUntil: until }] });
    expect(await agent(id)).toMatchObject({ state: "idle", session: null, limitedUntil: until });
    later(121);
    expect(await resume()).toEqual(["frontend-1"]);
    const [start] = resumes();
    const live = await agent(id);
    expect(start).toMatchObject({ kind: "start", agentId: id, sessionId: live.session.id, resume: true, text: RESUME_TEXT });
    expect(live).toMatchObject({ state: "working", limitedUntil: null });
  });

  it("sends nothing before its limit resets, nor to one deleted", async () => {
    await report("laptop", { agents: [{ id, state: "waiting", sessionId, limitedUntil: resets() }] });
    later(30);
    expect(await resume()).toEqual([]);
    expect((await agent(id)).limitedUntil).not.toBeNull();
    expect((await call("DELETE", `/agents/${id}`)).status).toBe(202);
    later(600);
    expect(await resume()).toEqual([]);
    expect(resumes()).toEqual([]);
    expect(logged).toEqual([]);
  });

  it("keeps the limit, and logs why, when its host cannot be reached, to try again on the next look", async () => {
    await report("laptop", { agents: [{ id, state: "waiting", sessionId, limitedUntil: resets() }] });
    later(3600);
    expect(await resume()).toEqual([]);
    expect(resumes()).toEqual([]);
    expect((await agent(id)).limitedUntil).not.toBeNull();
    expect(JSON.parse(logged[0]!)).toMatchObject({ resumed: "failed", agent: "frontend-1" });
    await beat("laptop", { capacity: 2 });
    expect(await resume()).toEqual(["frontend-1"]);
  });

  it("clears the limit when the person messages it first", async () => {
    await report("laptop", { agents: [{ id, state: "waiting", sessionId, limitedUntil: resets() }] });
    expect((await call("POST", `/agents/${id}/messages`, { text: "resume" })).status).toBe(202);
    expect((await agent(id)).limitedUntil).toBeNull();
  });
});
