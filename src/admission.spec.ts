import { beforeEach, describe, expect, it } from "vitest";
import { AgencyApi, type TokenSource } from "./api.ts";
import { inStartOrder, MAKING_FOR_MS, usageRefusal, type AgentRequest } from "./admission.ts";
import type { Credential } from "./credentials.ts";
import { KeyringUnreachable } from "./keyring.ts";
import { FakeStore } from "./fake-store.ts";
import { TEST_ROLES as SEEDED_ROLES, testRoles } from "./test-roles.ts";

const TOKEN = { value: async () => "secret" } satisfies TokenSource;
const NOW = new Date("2026-11-07T12:00:00.000Z");

let store: FakeStore;
let api: AgencyApi;
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
  api = new AgencyApi(store, TOKEN, {
    now: () => now,
    roles: testRoles(),
    context: { forSession: async () => ({ skills: [], note: null }), refuse: async () => null },
    credentials: {
      "document-service": known("document-service", "https://ds", "DS"),
      "work-tracker": known("work-tracker", "https://wt", "WT"),
      agency: known("agency", null, "AG"),
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

const beat = (id: string, capacity: number) => api.beat(id, { version: "1", labels: [], capacity });

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
  it("waits while usage is at or over 95%, and says so", async () => {
    await beat("laptop", 2);
    await usage(0.95, 0.2);
    const asked = await ask({ role: "reviewer", brief: "Review PR #41.", subject: "PR #41" });
    expect(asked).toMatchObject({ state: "waiting", agentId: null, position: 1 });
    expect(asked.why).toBe("Waits on usage: 5-hour usage is 95%, at or over 95%.");
    expect(store.agents.size).toBe(0);
  });

  it("starts at 95% and over while the usage limit is off, and waits again once it is on", async () => {
    await beat("laptop", 3);
    await usage(0.2, 0.97);
    const asked = await ask({ role: "reviewer", brief: "Go." });
    expect(asked.why).toBe("Waits on usage: weekly usage is 97%, at or over 95%.");
    const off = await call("PUT", "/usage/limit", { on: false });
    expect(off.status).toBe(200);
    expect(await off.json()).toMatchObject({ limitOn: false });
    expect(await request(asked.id)).toMatchObject({ state: "started" });
    expect(await (await call("GET", "/usage")).json()).toMatchObject({ limitOn: false });
    await call("PUT", "/usage/limit", { on: true });
    expect((await ask({ role: "reviewer", brief: "Go again." })).why).toBe("Waits on usage: weekly usage is 97%, at or over 95%.");
  });

  it("waits while no connected host has room, and says so", async () => {
    await beat("laptop", 0);
    await usage(0.1, 0.1);
    const asked = await ask({ role: "reviewer", brief: "Go." });
    expect(asked).toMatchObject({ state: "waiting", why: "Waits on a host: No connected host has room for an agent." });
  });

  it("waits, saying keyring is unreachable, rather than starting without its secrets", async () => {
    let up = false;
    api = new AgencyApi(store, TOKEN, {
      now: () => now,
      roles: testRoles(),
      context: { forSession: async () => ({ skills: [], note: null }), refuse: async () => null },
      credentials: { agency: known("agency", null, "AG") },
      keyring: {
        resolve: async () => {
          if (!up) throw new KeyringUnreachable("fetch failed");
          return { GH_TOKEN: "gh-secret" };
        },
      },
    });
    await beat("laptop", 2);
    await usage(0.1, 0.1);
    const asked = await ask({ role: "reviewer", brief: "Go." });
    expect(asked).toMatchObject({ state: "waiting", agentId: null });
    expect(asked.why).toContain("keyring unreachable");
    expect(store.agents.size).toBe(0);
    up = true;
    await api.admit("http://local");
    expect(await request(asked.id)).toMatchObject({ state: "started" });
  });

  it("waits on usage never reported, but not on a window since reset", async () => {
    await beat("laptop", 2);
    expect((await ask({ role: "reviewer", brief: "Go." })).why).toContain("no 5-hour usage has been reported");
    const reset = { utilization: 0.99, resetsAt: new Date(now.getTime() - 1000).toISOString(), readAt: NOW.toISOString() };
    expect(usageRefusal({ readAt: null, fiveHour: { ...reset, hostId: "h" }, sevenDay: { ...reset, hostId: "h" }, limitOn: true }, now)).toBeNull();
  });

  it("judges a reading however old: starts everything a host has room for under the limit, and waits at it", async () => {
    await beat("laptop", 3);
    const old = new Date(now.getTime() - 15 * 60 * 60_000);
    await usage(0.04, 0.74, old);
    const asked = [await ask({ role: "reviewer", brief: "Go." }), await ask({ role: "reviewer", brief: "Go." })];
    expect(asked.map((each) => each.state)).toEqual(["started", "started"]);
    await usage(0.1, 0.95, new Date(old.getTime() + 60_000));
    expect((await ask({ role: "reviewer", brief: "Go." })).why).toBe("Waits on usage: weekly usage is 95%, at or over 95%.");
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
      whenDone: "delete",
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
    await Promise.all([api.admit("http://local"), api.admit("http://local"), beat("laptop", 3)]);
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

describe("one agent to an item", () => {
  const refused = async (body: object, requester = "person") => {
    const res = await call("POST", "/requests", body, { "claimed-by": requester });
    expect(res.status, await res.clone().text()).toBe(409);
    return ((await res.json()) as { code: string; message: string });
  };

  it("refuses a second request while the first waits, naming it", async () => {
    await beat("laptop", 0);
    await usage(0.1, 0.1);
    const first = await ask({ role: "implementer", brief: "Go.", item: "task-1" }, "hopper");
    expect(first.state).toBe("waiting");
    const no = await refused({ role: "implementer", brief: "Go.", item: "task-1" });
    expect(no.code).toBe("ConflictException");
    expect(no.message).toBe(`Not asked for: implementer request ${first.id.slice(0, 8)} is already on task-1. Ask with \`another: true\` for one more.`);
    expect((await waiting()).map((r) => r.id)).toEqual([first.id]);
  });

  it("refuses one while an agent not deleted or done is on it, and takes one once it is", async () => {
    await beat("laptop", 2);
    await usage(0.1, 0.1);
    const first = await ask({ role: "implementer", brief: "Go.", item: "task-1" }, "hopper");
    expect(first.state).toBe("started");
    expect((await refused({ role: "reviewer", brief: "Go.", item: "task-1" })).message).toContain(`implementer-${first.id.slice(0, 8)} is already on task-1`);
    const done = await call("PUT", `/agents/${first.id}/status`, { status: "done", summary: "Shipped." });
    expect(done.status, await done.clone().text()).toBe(200);
    const second = await ask({ role: "implementer", brief: "Again.", item: "task-1" }, "person");
    expect(second.state).toBe("started");
    expect((await call("DELETE", `/agents/${second.id}`)).status).toBe(202);
    expect((await ask({ role: "implementer", brief: "Once more.", item: "task-1" })).state).toBe("started");
  });

  it("takes one more when asked with another: true, and any number without an item", async () => {
    await beat("laptop", 4);
    await usage(0.1, 0.1);
    await ask({ role: "implementer", brief: "Go.", item: "task-1" }, "hopper");
    expect((await ask({ role: "reviewer", brief: "Review it.", item: "task-1", another: true })).state).toBe("started");
    await ask({ role: "reviewer", brief: "Go." });
    await ask({ role: "reviewer", brief: "Go." });
    expect(store.agents.size).toBe(4);
  });

  it("counts a request started whose agent is still being made", async () => {
    await beat("laptop", 0);
    await usage(0.1, 0.1);
    const first = await ask({ role: "implementer", brief: "Go.", item: "task-1" });
    const held = (await store.getRequest(first.id))!;
    await store.putRequest({ ...held, state: "started", startedAt: now.toISOString(), agentId: first.id });
    await refused({ role: "implementer", brief: "Go.", item: "task-1" });
    // One that started long ago and made no agent holds the item no longer.
    later(MAKING_FOR_MS / 1000 + 1);
    await ask({ role: "implementer", brief: "Go.", item: "task-1" });
  });

  // hopper's tick and workplace-ui's Start each check that nobody is on the task, then ask: both
  // checks pass before either asks, as they did on 8472655a, and still only one agent starts.
  it("starts exactly one agent when hopper's tick and the person's Start race on one ready task", async () => {
    await beat("laptop", 2);
    await usage(0.1, 0.1);
    const nobody = async () => {
      const agents = ((await (await call("GET", "/agents?item=task-1")).json()) as { agents: unknown[] }).agents;
      const requests = ((await (await call("GET", "/requests?item=task-1")).json()) as { requests: unknown[] }).requests;
      return agents.length === 0 && requests.length === 0;
    };
    expect(await Promise.all([nobody(), nobody()])).toEqual([true, true]);
    const [hopper, person] = await Promise.all([
      call("POST", "/requests", { role: "implementer", brief: "Go.", item: "task-1" }, { "claimed-by": "hopper" }),
      call("POST", "/requests", { role: "implementer", brief: "Go.", item: "task-1" }, { "claimed-by": "person" }),
    ]);
    expect([hopper.status, person.status].sort()).toEqual([201, 409]);
    const on = [...store.agents.values()].filter((a) => a.item === "task-1");
    expect(on).toHaveLength(1);
    expect(on[0]!.state).toBe("working");
  });
});

describe("the runtime of a request's agent", () => {
  beforeEach(async () => {
    api = new AgencyApi(store, TOKEN, {
      now: () => now,
      roles: testRoles(),
      context: { forSession: async () => ({ skills: [], note: null }), refuse: async () => null },
      defaultRuntime: "container",
    });
    await api.beat("laptop", { version: "1", labels: ["runtime:host"], capacity: 4 });
    await usage(0.1, 0.1);
  });

  const runtimeOf = async (asked: { agentId: string | null }) =>
    ((await (await call("GET", `/agents/${asked.agentId}`)).json()) as { runtime: string }).runtime;

  it("is host when its labels include runtime:host, and the stage's default otherwise", async () => {
    const onHost = await ask({ role: "reviewer", brief: "Go.", subject: "PR #1", labels: ["runtime:host"] });
    expect(onHost.state).toBe("started");
    expect(await runtimeOf(onHost)).toBe("host");
    const inContainer = await ask({ role: "reviewer", brief: "Go.", subject: "PR #2" });
    expect(inContainer, inContainer.why ?? "").toMatchObject({ state: "started" });
    expect(await runtimeOf(inContainer)).toBe("container");
    const starts = (store.commands.get("laptop") ?? []).map((q) => q.command).filter((c) => c.kind === "start");
    expect(starts.map((c) => (c as { runtime: string }).runtime)).toEqual(["host", "container"]);
  });
});
