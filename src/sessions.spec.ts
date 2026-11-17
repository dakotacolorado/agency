import { beforeEach, describe, expect, it } from "vitest";
import { AgencyApi, type TokenSource } from "./api.ts";
import { capabilitiesOf } from "./capabilities.ts";
import { FakeStore } from "./fake-store.ts";
import type { Poster } from "./push.ts";
import type { SocketOutbound } from "./schema.ts";
import { costOf, sessionsCsv } from "./sessions.ts";
import { SocketHandler } from "./socket.ts";
import { Store } from "./store.ts";
import { testRoles } from "./test-roles.ts";
import { DEFAULT_CAPABILITIES } from "./capabilities.ts";

const TOKEN = { value: async () => "secret" } satisfies TokenSource;
const START = new Date("2026-11-17T12:00:00.000Z");

class FakePoster implements Poster {
  posts: { connectionId: string; message: SocketOutbound }[] = [];
  async post(connectionId: string, message: SocketOutbound) {
    this.posts.push({ connectionId, message });
    return "sent" as const;
  }
}

let now: Date;
let store: FakeStore;
let poster: FakePoster;
let api: AgencyApi;

const make = (options: ConstructorParameters<typeof AgencyApi>[2] = {}) =>
  new AgencyApi(store, TOKEN, {
    now: () => now,
    poster,
    roles: testRoles(),
    context: { forSession: async () => ({ skills: [], note: null }), refuse: async () => null },
    ...options,
  });

beforeEach(async () => {
  now = START;
  named = 0;
  store = new FakeStore();
  poster = new FakePoster();
  api = make();
  await api.beat("laptop", { version: "1", labels: [], capacity: 8 });
});

const call = async (method: string, path: string, body?: unknown): Promise<{ status: number; body: any; type: string }> => {
  const res = await api.fetch(
    new Request(`http://local${path}`, {
      method,
      headers: { Authorization: "Bearer secret", "Content-Type": "application/json" },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    }),
  );
  const type = res.headers.get("content-type") ?? "";
  return { status: res.status, type, body: type.startsWith("application/json") ? await res.json() : await res.text() };
};

let named = 0;

/** Moves the clock, its host beating then so it is not lost. */
const at = async (instant: string) => {
  now = new Date(instant);
  await api.beat("laptop", { version: "1", labels: [], capacity: 8 });
};

const create = async (body: object = {}) => {
  const res = await call("POST", "/agents", { name: `a-${++named}`, hostId: "laptop", brief: "Go.", ...body });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body as { id: string; session: { id: string } };
};

const report = async (body: { agents?: object[]; tokens?: object[] }) => {
  const connectionId = "reports";
  if (!store.sockets.has(connectionId)) await store.putConnection({ connectionId, kind: "host", hostId: "laptop", connectedAt: now.toISOString() });
  await new SocketHandler(store, TOKEN, poster, () => now).handle({
    requestContext: { connectionId, eventType: "MESSAGE" },
    body: JSON.stringify({ type: "report", agents: [], ...body }),
  });
};

const tokens = (inputTokens: number, outputTokens: number, cacheReadInputTokens = 0, cacheCreationInputTokens = 0) => ({
  inputTokens,
  outputTokens,
  cacheReadInputTokens,
  cacheCreationInputTokens,
});

const M = 1_000_000;

const sessions = async (query = "") => {
  const res = await call("GET", `/sessions${query}`);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body as { sessions: any[]; nextToken: string | null };
};

describe("a session's record", () => {
  it("holds who ran it on what, from its start", async () => {
    const agent = await create({ role: "implementer", item: "task-1", capability: 2 });
    expect((await sessions()).sessions).toEqual([
      {
        id: agent.session.id,
        agentId: agent.id,
        agentName: "a-1",
        role: "implementer",
        item: "task-1",
        capability: 2,
        model: "claude-sonnet-5-5",
        capabilityChanges: [],
        tokens: tokens(0, 0),
        modelsUsed: [],
        estimatedCostUsd: 0,
        startedAt: START.toISOString(),
        endedAt: null,
        activeMs: 0,
        turns: 0,
        peakContextTokens: null,
        endReason: null,
        skills: [],
      },
    ]);
  });

  it("lists each model reported, Opus and then Sonnet, costed at the default prices", async () => {
    const agent = await create();
    const opus = tokens(1 * M, 0.1 * M, 1 * M, 0.1 * M);
    await report({ tokens: [{ agentId: agent.id, sessionId: agent.session.id, ...opus, byModel: { "claude-opus-5-5": opus } }] });
    const sonnet = tokens(1 * M, 0.1 * M);
    const total = tokens(2 * M, 0.2 * M, 1 * M, 0.1 * M);
    await report({ tokens: [{ agentId: agent.id, sessionId: agent.session.id, ...total, byModel: { "claude-opus-5-5": opus, "claude-sonnet-5-5": sonnet } }] });
    const [record] = (await sessions()).sessions;
    // Opus: 4 + 2 + 0.2 + 0.8; Sonnet: 2 + 1.
    expect(record.modelsUsed).toEqual([
      { model: "claude-opus-5-5", ...opus, estimatedCostUsd: 7 },
      { model: "claude-sonnet-5-5", ...sonnet, estimatedCostUsd: 3 },
    ]);
    expect(record.estimatedCostUsd).toBe(10);
    expect(record.tokens).toEqual(total);
    // A total sent again, or late, adds nothing.
    await report({ tokens: [{ agentId: agent.id, sessionId: agent.session.id, ...opus, byModel: { "claude-opus-5-5": tokens(1, 1) } }] });
    expect((await sessions()).sessions[0]).toMatchObject({ tokens: total, estimatedCostUsd: 10 });
  });

  it("counts every token on the model it started on, from a host that reports none by model", async () => {
    const agent = await create({ capability: 3 });
    await report({ tokens: [{ agentId: agent.id, sessionId: agent.session.id, ...tokens(M, 0) }] });
    expect((await sessions()).sessions[0]).toMatchObject({ modelsUsed: [{ model: "claude-opus-5-5", inputTokens: M, estimatedCostUsd: 4 }], estimatedCostUsd: 4 });
  });

  it("prices Haiku above its step once the session's context went past 100k, and leaves a model with no price out", async () => {
    const agent = await create({ capability: 1 });
    const live = { id: agent.id, state: "working", sessionId: agent.session.id };
    const haiku = tokens(M, 0);
    const spent = { agentId: agent.id, sessionId: agent.session.id, ...tokens(2 * M, 0), byModel: { "claude-haiku-5-5-20261101": haiku, "someone-elses-model": haiku } };
    await report({ agents: [{ ...live, contextTokens: 90_000 }], tokens: [spent] });
    expect((await sessions()).sessions[0]).toMatchObject({
      peakContextTokens: 90_000,
      modelsUsed: [{ estimatedCostUsd: 0.1 }, { model: "someone-elses-model", estimatedCostUsd: null }],
      estimatedCostUsd: 0.1,
    });
    await report({ agents: [{ ...live, contextTokens: 120_000 }] });
    await report({ agents: [{ ...live, contextTokens: 30_000 }] });
    expect((await sessions()).sessions[0]).toMatchObject({ peakContextTokens: 120_000, estimatedCostUsd: 0.5 });
  });

  it("keeps the highest activeMs and turns reported", async () => {
    const agent = await create();
    const live = { id: agent.id, state: "working", sessionId: agent.session.id };
    await report({ agents: [{ ...live, activeMs: 5000, turns: 3 }] });
    await report({ agents: [{ ...live, state: "waiting", activeMs: 4000, turns: 2 }] });
    expect((await sessions()).sessions[0]).toMatchObject({ activeMs: 5000, turns: 3 });
    await report({ agents: [{ ...live, activeMs: 6000, turns: 4 }] });
    expect((await sessions()).sessions[0]).toMatchObject({ activeMs: 6000, turns: 4 });
  });

  it("records each capability change while live, and none while idle", async () => {
    const agent = await create({ capability: 3 });
    now = new Date(START.getTime() + 60_000);
    expect((await call("PUT", `/agents/${agent.id}/capability`, { capability: 2 })).status).toBe(200);
    expect((await sessions()).sessions[0]).toMatchObject({
      capability: 3,
      model: "claude-opus-5-5",
      capabilityChanges: [{ at: now.toISOString(), from: 3, to: 2 }],
    });
    expect((await call("POST", `/agents/${agent.id}/stop`)).status).toBe(202);
    expect((await call("PUT", `/agents/${agent.id}/capability`, { capability: 1 })).status).toBe(200);
    expect((await sessions()).sessions[0].capabilityChanges).toHaveLength(1);
  });

  it("ends stopped, interrupted, or by a usage limit", async () => {
    const stopped = await create();
    const died = await create();
    const limited = await create();
    now = new Date(START.getTime() + 1000);
    await call("POST", `/agents/${stopped.id}/stop`);
    await report({
      agents: [
        { id: died.id, state: "interrupted", sessionId: died.session.id },
        { id: limited.id, state: "idle", sessionId: limited.session.id, limitedUntil: "2026-11-17T17:00:00.000Z" },
      ],
    });
    const ended = Object.fromEntries((await sessions()).sessions.map((s) => [s.agentId, s]));
    expect(ended[stopped.id]).toMatchObject({ endedAt: now.toISOString(), endReason: "stopped" });
    expect(ended[died.id]).toMatchObject({ endedAt: now.toISOString(), endReason: "interrupted" });
    expect(ended[limited.id]).toMatchObject({ endedAt: now.toISOString(), endReason: "limit" });
  });

  it("is kept after its agent is deleted", async () => {
    const agent = await create({ item: "task-1" });
    expect((await call("DELETE", `/agents/${agent.id}`)).status).toBe(202);
    expect((await sessions("?item=task-1")).sessions).toEqual([expect.objectContaining({ agentId: agent.id, endReason: "stopped" })]);
  });

  it("fills a session from before records kept it from its agent, its tokens too", async () => {
    const agent = await create({ role: "implementer", item: "task-1" });
    await report({ tokens: [{ agentId: agent.id, sessionId: agent.session.id, ...tokens(10, 20) }] });
    store.db
      .prepare("UPDATE sessions SET record = json_remove(record, '$.agentName', '$.role', '$.item', '$.capability', '$.model', '$.tokens', '$.activeMs', '$.turns', '$.capabilityChanges', '$.endReason')")
      .run();
    new Store(store.db);
    expect((await sessions()).sessions[0]).toMatchObject({
      agentName: "a-1",
      role: "implementer",
      item: "task-1",
      capability: null,
      model: null,
      tokens: tokens(10, 20),
      modelsUsed: [],
      estimatedCostUsd: null,
      activeMs: null,
    });
  });
});

describe("ListSessions", () => {
  const seed = async () => {
    const a = await create({ role: "implementer", item: "task-1", capability: 3 });
    await at("2026-11-18T09:00:00.000Z");
    const b = await create({ role: "reviewer", item: "task-1", capability: 2 });
    await at("2026-11-19T09:00:00.000Z");
    const c = await create({ role: "implementer", item: "task-2", capability: 1 });
    await report({ tokens: [{ agentId: c.id, sessionId: c.session.id, ...tokens(1, 1), byModel: { "claude-sonnet-5-5": tokens(1, 1) } }] });
    return { a, b, c };
  };
  const ids = (list: { sessions: any[] }) => list.sessions.map((s) => s.agentId);

  it("lists newest first, filtered by item, role, agent, model and time", async () => {
    const { a, b, c } = await seed();
    expect(ids(await sessions())).toEqual([c.id, b.id, a.id]);
    expect(ids(await sessions("?item=task-1"))).toEqual([b.id, a.id]);
    expect(ids(await sessions("?role=implementer"))).toEqual([c.id, a.id]);
    expect(ids(await sessions(`?agentId=${b.id}`))).toEqual([b.id]);
    expect(ids(await sessions("?model=claude-opus-5-5"))).toEqual([a.id]);
    expect(ids(await sessions("?model=claude-sonnet-5-5"))).toEqual([c.id, b.id]);
    expect(ids(await sessions("?since=2026-11-18"))).toEqual([c.id, b.id]);
    expect(ids(await sessions("?until=2026-11-18T09:00:00.000Z"))).toEqual([a.id]);
    expect(ids(await sessions("?since=2026-11-18&until=2026-11-19&role=reviewer&item=task-1"))).toEqual([b.id]);
    expect((await call("GET", "/sessions?since=yesterday")).status).toBe(400);
  });

  it("pages by nextToken", async () => {
    const { a, b, c } = await seed();
    const first = await sessions("?limit=2");
    expect(ids(first)).toEqual([c.id, b.id]);
    const second = await sessions(`?limit=2&nextToken=${first.nextToken}`);
    expect(ids(second)).toEqual([a.id]);
    expect(second.nextToken).toBeNull();
    expect((await call("GET", "/sessions?nextToken=nonsense")).status).toBe(400);
  });

  it("answers CSV of the same rows, filtered", async () => {
    const { a, b } = await seed();
    const res = await call("GET", "/sessions?format=csv&item=task-1");
    expect(res.status).toBe(200);
    expect(res.type).toMatch(/^text\/csv/);
    const rows = (res.body as string).trimEnd().split("\r\n");
    expect(rows[0]).toBe(
      "id,agentId,agentName,role,item,capability,model,capabilityChanges,modelsUsed,inputTokens,outputTokens,cacheCreationInputTokens,cacheReadInputTokens,estimatedCostUsd,startedAt,endedAt,activeMs,turns,peakContextTokens,endReason",
    );
    expect(rows.slice(1).map((r) => r.split(",")[1])).toEqual([b.id, a.id]);
    expect(rows[1]).toContain(",reviewer,task-1,2,claude-sonnet-5-5,");
  });

  it("escapes a cell holding a comma or a quote", () => {
    const csv = sessionsCsv([{ agentName: 'a,"b"', capabilityChanges: [], modelsUsed: [], tokens: tokens(0, 0) } as never]);
    expect(csv.split("\r\n")[1]).toContain(`"a,""b"""`);
  });
});

describe("an agent's currentSession", () => {
  it("is its live session's record, and null once it has none", async () => {
    const agent = await create();
    await report({ tokens: [{ agentId: agent.id, sessionId: agent.session.id, ...tokens(M, 0) }] });
    expect((await call("GET", `/agents/${agent.id}`)).body.currentSession).toMatchObject({ id: agent.session.id, estimatedCostUsd: 4 });
    expect((await call("GET", "/agents")).body.agents[0].currentSession).toMatchObject({ id: agent.session.id });
    await call("POST", `/agents/${agent.id}/stop`);
    const idle = (await call("GET", `/agents/${agent.id}`)).body;
    expect(idle.state).toBe("idle");
    expect(idle.currentSession).toBeNull();
  });

  it("is pushed to viewers with its agent", async () => {
    const agent = await create();
    await store.putConnection({ connectionId: "page", kind: "viewer", connectedAt: now.toISOString() });
    poster.posts = [];
    await report({ tokens: [{ agentId: agent.id, sessionId: agent.session.id, ...tokens(M, 0) }] });
    const pushed = poster.posts.map((p) => p.message).filter((m) => m.type === "agent");
    expect(pushed.at(-1)).toMatchObject({ agent: { currentSession: { estimatedCostUsd: 4 } } });
  });
});

describe("prices", () => {
  it("are the capability map's, a model without its own keeping its default's", () => {
    const custom = capabilitiesOf({ "3": { model: "claude-opus-5-5", prices: { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 } } });
    expect(costOf("claude-opus-5-5", tokens(M, M, M, M), 0, custom)).toBe(4);
    expect(capabilitiesOf({ "3": { model: "claude-opus-5-5" } })[3].prices).toEqual(DEFAULT_CAPABILITIES[3].prices);
    expect(capabilitiesOf({ "3": { model: "claude-fable-5-2" } })[3].prices).toBeNull();
  });
});
