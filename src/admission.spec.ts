import { beforeEach, describe, expect, it } from "vitest";
import { AgentServiceApi, type TokenSource } from "./api.ts";
import { FRESH_FOR_MS, inStartOrder, usageRefusal, type AgentRequest } from "./admission.ts";
import type { Credential } from "./credentials.ts";
import { FakeStore } from "./fake-store.ts";
import { TEST_ROLES as SEEDED_ROLES, testRoles } from "./test-roles.ts";

const TOKEN = { value: async () => "secret" } satisfies TokenSource;
const NOW = new Date("2026-11-07T12:00:00.000Z");

let store: FakeStore;
let api: AgentServiceApi;
let now: Date;

const known = (name: string, url: string | null, prefix: string): Credential => ({
  url,
  urlVar: `${prefix}_URL`,
  tokenVar: `${prefix}_TOKEN`,
  token: { value: async () => `${name}-shared` },
});

beforeEach(() => {
  store = new FakeStore();
  now = NOW;
  api = new AgentServiceApi(store, TOKEN, {
    now: () => now,
    roles: testRoles(),
    context: { forSession: async () => ({ skills: [], note: null }), refuse: async () => null },
    credentials: {
      "document-service": known("document-service", "https://ds", "DS"),
      "work-tracker": known("work-tracker", "https://wt", "WT"),
      "agent-service": known("agent-service", null, "AG"),
      "approval-service": known("approval-service", "https://as", "AS"),
    },
  });
});

const later = (seconds: number) => {
  now = new Date(now.getTime() + seconds * 1000);
};

const call = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
  api.fetch(
    new Request(`http://local${path}`, {
      method,
      headers: { Authorization: "Bearer secret", "Content-Type": "application/json", ...headers },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    }),
  );

const beat = async (id: string, capacity: number) => {
  const res = await call("POST", `/hosts/${id}/heartbeat`, { version: "1", labels: [], capacity });
  expect(res.status).toBe(200);
};

const usage = async (fiveHour: number, sevenDay: number, readAt = now) => {
  const window = (utilization: number) => ({
    utilization,
    resetsAt: new Date(now.getTime() + 3600_000).toISOString(),
    readAt: readAt.toISOString(),
    hostId: "laptop",
  });
  await store.putUsage("fiveHour", window(fiveHour));
  await store.putUsage("sevenDay", window(sevenDay));
};

const ask = async (body: object, requester = "approval-service") => {
  const res = await call("POST", "/requests", body, { "claimed-by": requester });
  expect(res.status, await res.clone().text()).toBe(201);
  return (await res.json()) as { id: string; state: string; why: string | null; agentId: string | null; position: number | null };
};

const request = async (id: string) => (await (await call("GET", `/requests/${id}`)).json()) as Record<string, any>;

const waiting = async () => ((await (await call("GET", "/requests")).json()) as { requests: Record<string, any>[] }).requests;

describe("a request for an agent", () => {
  it("waits while usage is at or over 90%, and says so", async () => {
    await beat("laptop", 2);
    await usage(0.9, 0.2);
    const asked = await ask({ role: "reviewer", brief: "Review PR #41.", subject: "PR #41" });
    expect(asked).toMatchObject({ state: "waiting", agentId: null, position: 1 });
    expect(asked.why).toBe("Waits on usage: 5-hour usage is 90%, at or over 90%.");
    expect(store.agents.size).toBe(0);
  });

  it("waits while no connected host has room, and says so", async () => {
    await beat("laptop", 0);
    await usage(0.1, 0.1);
    const asked = await ask({ role: "reviewer", brief: "Go." });
    expect(asked).toMatchObject({ state: "waiting", why: "Waits on a host: No connected host has room for an agent." });
  });

  it("waits on usage never reported, or read too long ago, but not on a window since reset", async () => {
    await beat("laptop", 2);
    expect((await ask({ role: "reviewer", brief: "Go." })).why).toContain("no 5-hour usage has been reported");
    await usage(0.8, 0.1, new Date(now.getTime() - FRESH_FOR_MS - 60_000));
    expect(usageRefusal(await api["fleet"].usage(), now)).toContain("minutes old, read at 80%");
    const reset = { utilization: 0.99, resetsAt: new Date(now.getTime() - 1000).toISOString(), readAt: NOW.toISOString() };
    expect(usageRefusal({ readAt: null, fiveHour: { ...reset, hostId: "h" }, sevenDay: { ...reset, hostId: "h" } }, now)).toBeNull();
  });

  it("on a stale reading well under the limit, starts one request at a time, each once the last start is fresh or gave a reading", async () => {
    await beat("laptop", 3);
    const stale = new Date(now.getTime() - 15 * 60 * 60_000);
    await usage(0.04, 0.37, stale);
    const first = await ask({ role: "reviewer", brief: "Go." });
    expect(first.state).toBe("started");
    const second = await ask({ role: "reviewer", brief: "Go." });
    const third = await ask({ role: "reviewer", brief: "Go." });
    expect(second).toMatchObject({ state: "waiting" });
    expect(second.why).toContain("the agent started since has not given a new one yet");
    // The started agent's session gives a fresh reading: everything waiting may start.
    later(30);
    await usage(0.05, 0.37);
    await beat("laptop", 3);
    expect((await request(second.id)).state).toBe("started");
    expect((await request(third.id)).state).toBe("started");
  });

  it("on a stale reading with no reading since a start, starts the next once that start is itself stale", async () => {
    await beat("laptop", 3);
    await usage(0.1, 0.1, new Date(now.getTime() - FRESH_FOR_MS - 60_000));
    await ask({ role: "reviewer", brief: "Go." });
    const next = await ask({ role: "reviewer", brief: "Go." });
    expect(next.state).toBe("waiting");
    later(FRESH_FOR_MS / 1000 + 1);
    await beat("laptop", 2);
    expect((await request(next.id)).state).toBe("started");
  });

  it("starts at most one in a single admission on a stale reading", async () => {
    await beat("laptop", 0);
    await usage(0.1, 0.1, new Date(now.getTime() - FRESH_FOR_MS - 60_000));
    const a = await ask({ role: "reviewer", brief: "Go." });
    const b = await ask({ role: "reviewer", brief: "Go." });
    await beat("laptop", 3);
    const after = [await request(a.id), await request(b.id)];
    expect(after.map((each) => each.state).sort()).toEqual(["started", "waiting"]);
    expect(after.find((each) => each.state === "waiting")!.why).toContain("the agent just started will give a new one");
  });

  it("still waits on a stale reading near the limit", async () => {
    await beat("laptop", 3);
    await usage(0.75, 0.1, new Date(now.getTime() - FRESH_FOR_MS - 60_000));
    expect((await ask({ role: "reviewer", brief: "Go." })).why).toContain("minutes old, read at 75%");
  });

  it("starts once usage and a host allow, on a host and under a name the service chooses, and records its agent", async () => {
    await beat("laptop", 0);
    await usage(0.95, 0.2);
    const asked = await ask({ role: "reviewer", brief: "Review PR #41.", item: "item-1" });
    await usage(0.5, 0.2);
    later(1);
    await usage(0.5, 0.2);
    expect((await request(asked.id)).state).toBe("waiting");
    await beat("laptop", 1);
    const started = await request(asked.id);
    expect(started).toMatchObject({ state: "started", why: null, position: null, agentId: asked.id, startedAt: now.toISOString() });
    const agent = store.agents.get(asked.id)!;
    expect(agent).toMatchObject({
      name: `reviewer-${asked.id.slice(0, 8)}`,
      hostId: "laptop",
      role: "reviewer",
      item: "item-1",
      createdBy: "approval-service",
      skills: ["agent-roles/reviewer"],
      whenDone: "retire",
      state: "working",
    });
    expect(await waiting()).toEqual([]);
  });

  it("starts at once when it can", async () => {
    await beat("laptop", 1);
    await usage(0.1, 0.1);
    const asked = await ask({ role: "planner" });
    expect(asked).toMatchObject({ state: "started", agentId: asked.id });
    expect(store.agents.get(asked.id)).toMatchObject({ role: "planner", label: "plan: new work", skills: ["agent-roles/planner"] });
  });

  it("starts the higher role priority first, and of equal priority the older", async () => {
    await beat("laptop", 0);
    await usage(0.1, 0.1);
    const implementer = await ask({ role: "implementer", brief: "Do it." });
    later(1);
    const reviewer = await ask({ role: "reviewer", brief: "Review." });
    later(1);
    const onboarder = await ask({ role: "onboarder", brief: "Onboard." });
    expect((await waiting()).map((r) => [r.id, r.position])).toEqual([
      [reviewer.id, 1],
      [onboarder.id, 2],
      [implementer.id, 3],
    ]);
    await beat("laptop", 1);
    expect((await request(reviewer.id)).state).toBe("started");
    expect((await request(onboarder.id)).state).toBe("waiting");
    expect((await request(implementer.id)).state).toBe("waiting");
    await beat("laptop", 2);
    expect((await request(onboarder.id)).state).toBe("started");
    expect((await request(implementer.id))).toMatchObject({ state: "waiting", position: 1 });
  });

  it("can be withdrawn while waiting, and then never starts", async () => {
    await beat("laptop", 0);
    await usage(0.1, 0.1);
    const asked = await ask({ role: "reviewer", brief: "Go.", credentials: ["work-tracker"] });
    const res = await call("DELETE", `/requests/${asked.id}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ state: "withdrawn", withdrawnAt: now.toISOString(), position: null });
    await beat("laptop", 2);
    expect((await request(asked.id)).state).toBe("withdrawn");
    expect(store.agents.size).toBe(0);
    expect((await call("DELETE", `/requests/${asked.id}`)).status).toBe(409);
    expect((await call("DELETE", "/requests/3b0f6c1e-9a52-4c1d-8f43-2a6e1c7d9b10")).status).toBe(404);
  });

  it("cannot be withdrawn once started", async () => {
    await beat("laptop", 1);
    await usage(0.1, 0.1);
    const asked = await ask({ role: "reviewer", brief: "Go." });
    expect((await call("DELETE", `/requests/${asked.id}`)).status).toBe(409);
  });

  it("gives an agent its role's skills, settings and, naming none, every service this stage has", async () => {
    await beat("laptop", 0);
    await usage(0.1, 0.1);
    const asked = await ask({ role: "reviewer", brief: "Go." });
    await beat("laptop", 1);
    const reviewer = SEEDED_ROLES.find((r) => r.name === "reviewer")!;
    const agent = store.agents.get(asked.id)!;
    expect(agent).toMatchObject({ role: "reviewer", skills: reviewer.skills, whenDone: reviewer.whenDone });
    expect(agent.credentials ?? null).toBe(reviewer.credentials);
  });

  it("refuses a service this stage does not have", async () => {
    const unknown = await call("POST", "/requests", { role: "reviewer", brief: "Go.", credentials: ["nothing"] });
    expect(unknown.status).toBe(400);
    expect(((await unknown.json()) as { message: string }).message).toContain("No credential is named nothing");
  });

  it("names no host or agent name, and needs a brief its role lacks", async () => {
    expect((await call("POST", "/requests", { role: "reviewer", brief: "Go.", hostId: "laptop" })).status).toBe(400);
    expect((await call("POST", "/requests", { role: "reviewer", brief: "Go.", name: "me-1" })).status).toBe(400);
    const briefless = await call("POST", "/requests", { role: "reviewer" });
    expect(briefless.status).toBe(400);
    expect(((await briefless.json()) as { message: string }).message).toContain("needs `brief`");
    expect((await call("POST", "/requests", { role: "nobody", brief: "Go." })).status).toBe(400);
    expect((await call("POST", "/requests", { role: "reviewer", brief: "Go.", credentials: ["github"] })).status).toBe(400);
  });

  it("lists every request with all=true, and by requester or item", async () => {
    await beat("laptop", 1);
    await usage(0.1, 0.1);
    const started = await ask({ role: "reviewer", brief: "Go.", item: "a" }, "approval-service");
    const left = await ask({ role: "implementer", brief: "Go.", item: "b" }, "work-tracker");
    const all = ((await (await call("GET", "/requests?all=true")).json()) as { requests: { id: string }[] }).requests;
    expect(all.map((r) => r.id)).toEqual([left.id, started.id]);
    const byItem = ((await (await call("GET", "/requests?all=true&item=a")).json()) as { requests: { id: string }[] }).requests;
    expect(byItem.map((r) => r.id)).toEqual([started.id]);
    const mine = ((await (await call("GET", "/requests?requester=work-tracker")).json()) as { requests: { id: string }[] }).requests;
    expect(mine.map((r) => r.id)).toEqual([left.id]);
  });

  it("starts each once, however many admissions run at once", async () => {
    await beat("laptop", 0);
    await usage(0.1, 0.1);
    const asked = await ask({ role: "reviewer", brief: "Go." });
    await beat("laptop", 3);
    await Promise.all([api.admit("http://local"), api.admit("http://local"), call("POST", "/hosts/laptop/heartbeat", { version: "1", labels: [], capacity: 3 })]);
    expect([...store.agents.values()].filter((w) => w.id === asked.id)).toHaveLength(1);
    expect(store.agents.size).toBe(1);
  });
});

describe("start order", () => {
  const at = (id: string, role: string, createdAt: string) => ({ id, role, createdAt }) as AgentRequest;
  it("is by role priority, then age", () => {
    const order = inStartOrder(
      [at("a", "implementer", "1"), at("b", "planner", "3"), at("c", "onboarder", "2"), at("d", "reviewer", "1")],
      [...SEEDED_ROLES],
    );
    expect(order.map((r) => r.id)).toEqual(["b", "d", "c", "a"]);
  });
});
