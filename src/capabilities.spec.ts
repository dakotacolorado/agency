import { beforeEach, describe, expect, it } from "vitest";
import { AgencyApi, type TokenSource } from "./api.ts";
import { capabilitiesOf, DEFAULT_CAPABILITIES } from "./capabilities.ts";
import { FakeStore } from "./fake-store.ts";
import type { Poster } from "./push.ts";
import type { Command, SocketOutbound } from "./schema.ts";
import { SocketHandler } from "./socket.ts";
import { testRoles } from "./test-roles.ts";

const TOKEN = { value: async () => "secret" } satisfies TokenSource;
const NOW = new Date("2026-11-17T12:00:00.000Z");

class FakePoster implements Poster {
  posts: { connectionId: string; message: SocketOutbound }[] = [];
  async post(connectionId: string, message: SocketOutbound) {
    this.posts.push({ connectionId, message });
    return "sent" as const;
  }
}

let store: FakeStore;
let poster: FakePoster;
let api: AgencyApi;

const make = (options: ConstructorParameters<typeof AgencyApi>[2] = {}) =>
  new AgencyApi(store, TOKEN, {
    now: () => NOW,
    poster,
    roles: testRoles(),
    context: { forSession: async () => ({ skills: [], note: null }), refuse: async () => null },
    ...options,
  });

beforeEach(async () => {
  store = new FakeStore();
  poster = new FakePoster();
  api = make();
  await api.beat("laptop", { version: "1", labels: [], capacity: 4 });
});

const call = async (method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> => {
  const res = await api.fetch(
    new Request(`http://local${path}`, {
      method,
      headers: { Authorization: "Bearer secret", "Content-Type": "application/json" },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    }),
  );
  return { status: res.status, body: await res.json() };
};

const queued = () => (store.commands.get("laptop") ?? []).map((q) => q.command);
const starts = () => queued().filter((c): c is Extract<Command, { kind: "start" }> => c.kind === "start");
const configures = () => queued().filter((c) => c.kind === "configure");

const create = async (body: object) => {
  const res = await call("POST", "/agents", { name: "a-1", hostId: "laptop", ...body });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body;
};

const report = async (agents: object[]) => {
  const connectionId = "reports";
  if (!store.sockets.has(connectionId)) await store.putConnection({ connectionId, kind: "host", hostId: "laptop", connectedAt: NOW.toISOString() });
  await new SocketHandler(store, TOKEN, poster, () => NOW).handle({
    requestContext: { connectionId, eventType: "MESSAGE" },
    body: JSON.stringify({ type: "report", agents }),
  });
};

/** Ends its session as its host does, reporting it idle. */
const endSession = async (agent: { id: string; session: { id: string } }) => report([{ id: agent.id, state: "idle", sessionId: agent.session.id }]);

describe("capabilities", () => {
  it("map 1 to Haiku, 2 to Sonnet and 3 to Opus by default, only Haiku with a price step", async () => {
    expect(await call("GET", "/capabilities")).toEqual({
      status: 200,
      body: {
        capabilities: [
          {
            capability: 1,
            model: "claude-haiku-5-5",
            effort: null,
            priceStepAt: 100000,
            prices: { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.2, aboveStep: { input: 0.5, output: 2.5, cacheRead: 0.05, cacheWrite: 1 } },
          },
          { capability: 2, model: "claude-sonnet-5-5", effort: null, priceStepAt: null, prices: { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 4, aboveStep: null } },
          { capability: 3, model: "claude-opus-5-5", effort: null, priceStepAt: null, prices: { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 8, aboveStep: null } },
        ],
      },
    });
  });

  it("are the stage's map, each capability it names replacing that one's default", async () => {
    const capabilities = capabilitiesOf({ "2": { model: "claude-sonnet-5-5", effort: "high" } });
    expect(capabilities).toEqual({ ...DEFAULT_CAPABILITIES, 2: { ...DEFAULT_CAPABILITIES[2], effort: "high" } });
    expect(() => capabilitiesOf({ "4": { model: "x" } })).toThrow();
    expect(() => capabilitiesOf({ "1": { model: "x", effort: "max" } })).toThrow();
    api = make({ capabilities });
    expect((await call("GET", "/capabilities")).body.capabilities[1]).toEqual({ capability: 2, ...DEFAULT_CAPABILITIES[2], effort: "high" });
    await create({ brief: "Go.", capability: 2 });
    expect(starts()[0]).toMatchObject({ model: "claude-sonnet-5-5", effort: "high" });
  });

  it("outside 1-3 are refused, by every operation that takes one", async () => {
    for (const capability of [0, 4, 2.5, "3"]) {
      const made = await call("POST", "/agents", { name: "a-1", hostId: "laptop", capability });
      expect(made.status).toBe(400);
      expect(made.body.code).toBe("ValidationException");
      expect((await call("POST", "/requests", { role: "implementer", brief: "Go.", capability })).status).toBe(400);
    }
    const agent = await create({});
    for (const capability of [0, 4]) expect((await call("PUT", `/agents/${agent.id}/capability`, { capability })).status).toBe(400);
    expect(queued().map((c) => c.kind)).toEqual(["create"]);
  });
});

describe("an agent's capability", () => {
  it("is the one it is made with, and its start carries that capability's model", async () => {
    const agent = await create({ brief: "Go.", capability: 1 });
    expect(agent).toMatchObject({ capability: 1, model: "claude-haiku-5-5", contextTokens: null, overPriceStep: false });
    expect(starts()).toEqual([expect.objectContaining({ resume: false, model: "claude-haiku-5-5" })]);
    expect(starts()[0]).not.toHaveProperty("effort");
  });

  it("is its role's when none is given, and 3 for a role with none or no role", async () => {
    expect((await call("GET", "/roles/implementer")).body.capability).toBe(2);
    expect((await call("GET", "/roles/planner")).body.capability).toBe(3);
    expect(await create({ role: "implementer", brief: "Go." })).toMatchObject({ capability: 2, model: "claude-sonnet-5-5" });
    expect(await create({ name: "a-2", role: "planner" })).toMatchObject({ capability: 3, model: "claude-opus-5-5" });
    expect(await create({ name: "a-3" })).toMatchObject({ capability: 3, model: "claude-opus-5-5" });
    expect(await create({ name: "a-4", role: "implementer", brief: "Go.", capability: 1 })).toMatchObject({ capability: 1 });
  });

  it("of a request is the one asked for, else its role's, and its start carries the model", async () => {
    await store.putUsage("fiveHour", { utilization: 0.1, resetsAt: "2026-11-17T15:00:00.000Z", readAt: NOW.toISOString(), hostId: "laptop" });
    await store.putUsage("sevenDay", { utilization: 0.1, resetsAt: "2026-11-20T15:00:00.000Z", readAt: NOW.toISOString(), hostId: "laptop" });
    const asked = await call("POST", "/requests", { role: "implementer", brief: "Go.", item: "t-1", capability: 1 });
    expect(asked.status, JSON.stringify(asked.body)).toBe(201);
    expect(asked.body).toMatchObject({ state: "started", capability: 1 });
    expect((await call("GET", `/agents/${asked.body.agentId}`)).body).toMatchObject({ capability: 1, model: "claude-haiku-5-5" });
    expect(starts().at(-1)).toMatchObject({ agentId: asked.body.agentId, model: "claude-haiku-5-5" });

    const plain = await call("POST", "/requests", { role: "implementer", brief: "Go.", item: "t-2" });
    expect(plain.body.capability).toBeNull();
    expect((await call("GET", `/agents/${plain.body.agentId}`)).body).toMatchObject({ capability: 2, model: "claude-sonnet-5-5" });
    expect(starts().at(-1)).toMatchObject({ agentId: plain.body.agentId, model: "claude-sonnet-5-5" });
  });

  it("is 3 on an agent recorded before capabilities", async () => {
    const agent = await create({});
    const { capability: _, ...before } = (await store.getAgent(agent.id))!;
    await store.commit({ agents: [before] });
    expect((await call("GET", `/agents/${agent.id}`)).body).toMatchObject({ capability: 3, model: "claude-opus-5-5" });
  });
});

describe("SetAgentCapability", () => {
  it("on a live agent records it and queues a configure with the new model", async () => {
    const agent = await create({ brief: "Go.", capability: 3 });
    const set = await call("PUT", `/agents/${agent.id}/capability`, { capability: 1 });
    expect(set).toMatchObject({ status: 200, body: { capability: 1, model: "claude-haiku-5-5" } });
    expect(configures()).toEqual([{ kind: "configure", id: expect.any(String), agentId: agent.id, model: "claude-haiku-5-5", effort: null }]);
    expect((await call("GET", `/agents/${agent.id}`)).body.capability).toBe(1);
    // The same again changes nothing.
    expect((await call("PUT", `/agents/${agent.id}/capability`, { capability: 1 })).status).toBe(200);
    expect(configures()).toHaveLength(1);
  });

  it("on an idle agent records it, queues nothing, and its next start, a resumed one, carries the new model", async () => {
    const agent = await create({ brief: "Go.", capability: 3 });
    await endSession(agent);
    expect((await call("GET", `/agents/${agent.id}`)).body.state).toBe("idle");
    expect((await call("PUT", `/agents/${agent.id}/capability`, { capability: 2 })).body).toMatchObject({ capability: 2, model: "claude-sonnet-5-5" });
    expect(configures()).toEqual([]);
    expect((await call("POST", `/agents/${agent.id}/messages`, { text: "Carry on." })).status).toBe(202);
    expect(starts().map((s) => [s.resume, s.model])).toEqual([
      [false, "claude-opus-5-5"],
      [true, "claude-sonnet-5-5"],
    ]);
  });

  it("refuses a deleted agent and one no agent has", async () => {
    const agent = await create({});
    await call("DELETE", `/agents/${agent.id}`);
    expect((await call("PUT", `/agents/${agent.id}/capability`, { capability: 2 })).status).toBe(409);
    expect((await call("PUT", "/agents/3b0f6c1e-9a52-4c1d-8f43-2a6e1c7d9b10/capability", { capability: 2 })).status).toBe(404);
  });
});

describe("an agent's context size", () => {
  it("is its host's last report, over the price step above its model's priceStepAt", async () => {
    const agent = await create({ brief: "Go.", capability: 1 });
    const live = { id: agent.id, state: "working", sessionId: agent.session.id };
    await store.putConnection({ connectionId: "page", kind: "viewer", connectedAt: NOW.toISOString() });
    await report([{ ...live, contextTokens: 90000 }]);
    expect((await call("GET", `/agents/${agent.id}`)).body).toMatchObject({ contextTokens: 90000, overPriceStep: false });
    await report([{ ...live, contextTokens: 120000 }]);
    expect((await call("GET", `/agents/${agent.id}`)).body).toMatchObject({ contextTokens: 120000, overPriceStep: true });
    expect(poster.posts.some((p) => p.connectionId === "page" && p.message.type === "agent" && p.message.agent.overPriceStep)).toBe(true);
    // A report that does not say leaves the last size.
    await report([live]);
    expect((await call("GET", `/agents/${agent.id}`)).body.contextTokens).toBe(120000);
    // On a model with no step, no size is over it.
    await call("PUT", `/agents/${agent.id}/capability`, { capability: 3 });
    expect((await call("GET", `/agents/${agent.id}`)).body).toMatchObject({ contextTokens: 120000, overPriceStep: false });
  });
});

describe("an agent's context growth", () => {
  it("is kept, carried over when absent, and cleared when the context falls without it", async () => {
    const agent = await create({ brief: "Go.", capability: 1 });
    const live = { id: agent.id, state: "working", sessionId: agent.session.id };
    await store.putConnection({ connectionId: "page", kind: "viewer", connectedAt: NOW.toISOString() });
    const added = async () => (await call("GET", `/agents/${agent.id}`)).body.contextAddedTokens;
    expect(await added()).toBeNull();
    await report([{ ...live, contextTokens: 90000, contextAddedTokens: 4000 }]);
    expect(await added()).toBe(4000);
    expect(poster.posts.some((p) => p.message.type === "agent" && p.message.agent.contextAddedTokens === 4000)).toBe(true);
    // A report that does not say leaves the last, also when the context grew.
    await report([{ ...live, contextTokens: 95000 }]);
    expect(await added()).toBe(4000);
    await report([live]);
    expect(await added()).toBe(4000);
    // A fall without it is a compaction: cleared.
    await report([{ ...live, contextTokens: 20000 }]);
    expect(await added()).toBeNull();
    // A fall with it keeps what the host says.
    await report([{ ...live, contextTokens: 30000, contextAddedTokens: 10000 }]);
    await report([{ ...live, contextTokens: 5000, contextAddedTokens: 0 }]);
    expect(await added()).toBe(0);
    expect((await call("GET", "/agents")).body.agents.find((a: { id: string }) => a.id === agent.id).contextAddedTokens).toBe(0);
  });
});
