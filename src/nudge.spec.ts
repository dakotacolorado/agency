import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgencyApi } from "./api.ts";
import type { Agent } from "./domain.ts";
import { FakeStore } from "./fake-store.ts";
import { agentPage, notice, Nudge } from "./nudge.ts";
import { retireClosed } from "./sweep.ts";

const agent = (status: string, extra: Partial<Agent> = {}) =>
  ({ id: "a1", name: "implementer-a1", title: null, state: "waiting", status, summary: "PR #3 is up", ...extra }) as Agent;

describe("what the person is told of an agent", () => {
  it("is urgent while it waits on them, and normal in review", () => {
    expect(notice(agent("waiting"))).toEqual({ title: "implementer-a1 is waiting on you", body: "PR #3 is up", priority: "urgent" });
    expect(notice(agent("review", { title: "Fix login", state: "idle" }))).toMatchObject({ title: "implementer-a1 (Fix login) is ready for review", priority: "normal" });
  });

  it("is nothing once it is done, working or idle, or deleted", () => {
    expect(notice(agent("done"))).toBeNull();
    expect(notice(agent("working", { state: "working" }))).toBeNull();
    expect(notice(agent("idle", { state: "idle" }))).toBeNull();
    expect(notice(agent("waiting", { state: "deleted" }))).toBeNull();
    expect(notice(agent("review", { state: "deleted" }))).toBeNull();
  });
});

describe("the page a notification links to", () => {
  it("is the worker page when its address is set", () => {
    expect(agentPage("https://agency.test", "https://ui.test:8449/")(agent("waiting"))).toBe("https://ui.test:8449/workers/a1");
  });

  it("is agency's own page without it", () => {
    expect(agentPage("https://agency.test/", null)(agent("waiting"))).toBe("https://agency.test/#/agents/a1");
    expect(agentPage("https://agency.test", "")(agent("waiting"))).toBe("https://agency.test/#/agents/a1");
  });
});

/** nudge as its producer sees it: active notifications by key, and every call made. */
class FakeNudge {
  readonly calls: { method: string; path: string; auth: string; body: Record<string, any> | null }[] = [];
  readonly active = new Map<string, Record<string, any>>();
  failing = false;
  private server: Server | null = null;

  async url(): Promise<string> {
    this.server = createServer((req: IncomingMessage, res) => {
      let data = "";
      req.on("data", (d) => (data += d)).on("end", () => {
        const body = data ? JSON.parse(data) : null;
        this.calls.push({ method: req.method!, path: req.url!, auth: req.headers.authorization!, body });
        const answer = (status: number, json: unknown) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(json));
        if (this.failing) return answer(503, { code: "ServiceUnavailable", message: "down" });
        if (req.method === "GET") return answer(200, { notifications: [...this.active.values()].map((n) => ({ ...n, state: "active" })) });
        if (req.url === "/notifications/resolve") return this.active.delete(body.key) ? answer(200, {}) : answer(404, {});
        const had = this.active.has(body.key);
        this.active.set(body.key, { body: null, ...body });
        return answer(had ? 200 : 201, {});
      });
    });
    await new Promise<void>((r) => this.server!.listen(0, "127.0.0.1", r));
    return `http://127.0.0.1:${(this.server.address() as AddressInfo).port}/`;
  }

  close() {
    this.server?.close();
  }

  paths() {
    return this.calls.map((c) => `${c.method} ${c.path}`);
  }
}

let fake: FakeNudge;
let logged: string[];
let nudge: Nudge;
let nudgeUrl: string;

beforeEach(async () => {
  fake = new FakeNudge();
  logged = [];
  nudgeUrl = await fake.url();
  nudge = new Nudge(nudgeUrl, "tk", (a) => `https://ui.test/workers/${a.id}`, (m) => logged.push(m));
});
afterEach(() => fake.close());

describe("Nudge", () => {
  it("posts while an agent waits, updates it on a new summary, and resolves it once it does not", async () => {
    nudge.wrote([agent("waiting")]);
    nudge.wrote([agent("waiting", { activity: { text: "x", at: "now" } })]);
    nudge.wrote([agent("waiting", { summary: "Which schema?" })]);
    nudge.wrote([agent("done", { state: "idle" })]);
    nudge.wrote([agent("done", { state: "idle", activity: { text: "y", at: "now" } })]);
    await nudge.settled();
    expect(fake.paths(), "a write that changes nothing shown is no call").toEqual(["POST /notifications", "POST /notifications", "POST /notifications/resolve"]);
    expect(fake.calls[0]).toMatchObject({ auth: "Bearer tk", body: { key: "agent:a1", priority: "urgent", link: "https://ui.test/workers/a1" } });
    expect(fake.calls[1]?.body).toMatchObject({ key: "agent:a1", body: "Which schema?" });
    expect(fake.calls[2]?.body).toMatchObject({ key: "agent:a1", silent: true });
    expect(fake.active.size).toBe(0);
    expect(logged, "a resolve of one already closed is not a failure").toEqual([]);
  });

  it("resolves an agent it knows nothing of yet once, as it may be open from before", async () => {
    nudge.wrote([agent("working", { state: "working" })]);
    nudge.wrote([agent("working", { state: "working", summary: "other" })]);
    await nudge.settled();
    expect(fake.paths()).toEqual(["POST /notifications/resolve"]);
    expect(logged).toEqual([]);
  });

  it("logs a failure, never throws, and sends it again on the next write", async () => {
    fake.failing = true;
    expect(() => nudge.wrote([agent("done", { state: "idle" })])).not.toThrow();
    await nudge.settled();
    expect(logged[0]).toContain("nudge: implementer-a1");
    fake.failing = false;
    nudge.wrote([agent("done", { state: "idle" })]);
    await nudge.settled();
    expect(fake.paths()).toEqual(["POST /notifications/resolve", "POST /notifications/resolve"]);
  });

  it("reconciles: resolves what no agent waits for, posts what is missing or stale, and leaves the rest", async () => {
    const link = (id: string) => `https://ui.test/workers/${id}`;
    fake.active.set("agent:gone", { key: "agent:gone", title: "t", body: null, priority: "urgent", link: link("gone") });
    fake.active.set("agent:done", { key: "agent:done", title: "t", body: null, priority: "normal", link: link("done") });
    fake.active.set("agent:same", { key: "agent:same", title: "same is waiting on you", body: "PR #3 is up", priority: "urgent", link: link("same") });
    fake.active.set("agent:stale", { key: "agent:stale", title: "stale is waiting on you", body: "old", priority: "urgent", link: link("stale") });
    fake.active.set("release/1", { key: "release/1", title: "not an agent's", body: null, priority: "urgent", link: "https://x.test" });
    const agents = [
      agent("done", { id: "done", name: "done", state: "idle" }),
      agent("waiting", { id: "same", name: "same" }),
      agent("waiting", { id: "stale", name: "stale" }),
      agent("review", { id: "missing", name: "missing", state: "idle" }),
      agent("waiting", { id: "deleted", name: "deleted", state: "deleted" }),
    ];
    await nudge.reconcile(async () => agents);
    expect(fake.calls[0]).toMatchObject({ method: "GET", path: "/notifications?state=active&limit=500" });
    expect(fake.calls.slice(1).map((c) => [c.path, c.body?.key])).toEqual([
      ["/notifications/resolve", "agent:gone"],
      ["/notifications/resolve", "agent:done"],
      ["/notifications", "agent:stale"],
      ["/notifications", "agent:missing"],
    ]);
    expect([...fake.active.keys()].sort()).toEqual(["agent:missing", "agent:same", "agent:stale", "release/1"]);
    expect(logged).toEqual([JSON.stringify({ nudge: "reconciled", resolved: 2, posted: 2 })]);

    fake.calls.length = 0;
    nudge.wrote(agents);
    await nudge.settled();
    expect(fake.calls, "what reconcile saw open, or closed, is known").toEqual([]);
  });

  it("logs a failed reconcile and never throws", async () => {
    fake.failing = true;
    await expect(nudge.reconcile(async () => [])).resolves.toBeUndefined();
    expect(logged[0]).toContain("nudge: reconcile");
  });
});

describe("an agent's nudge, through the API", () => {
  const NOW = new Date("2026-11-14T12:00:00.000Z");
  let store: FakeStore;
  let api: AgencyApi;
  let id: string;

  const call = async (method: string, path: string, body?: unknown) =>
    api.fetch(
      new Request(`http://local${path}`, {
        method,
        headers: { Authorization: "Bearer secret", "Content-Type": "application/json" },
        ...(body !== undefined && { body: JSON.stringify(body) }),
      }),
    );
  const open = async () => {
    await nudge.settled();
    return fake.active.has(`agent:${id}`);
  };

  beforeEach(async () => {
    store = new FakeStore();
    api = new AgencyApi(store, { value: async () => "secret" }, { now: () => NOW, notifier: nudge });
    await api.beat("laptop", { version: "0.1.0", labels: [], capacity: 1 });
    const res = await call("POST", "/agents", { name: "frontend-1", hostId: "laptop", brief: "Go." });
    expect(res.status).toBe(201);
    id = ((await res.json()) as { id: string }).id;
  });

  const page = async (status: string) => expect((await call("PUT", `/agents/${id}/status`, { status, summary: "Which one?" })).status).toBe(200);

  it("is open while it waits or is in review, and taken back once it is done", async () => {
    await page("waiting");
    expect(await open()).toBe(true);
    expect(fake.active.get(`agent:${id}`)).toMatchObject({ priority: "urgent" });
    await page("review");
    await nudge.settled();
    expect(fake.active.get(`agent:${id}`)).toMatchObject({ priority: "normal" });
    await page("done");
    expect(await open()).toBe(false);
    expect(fake.calls.filter((c) => c.path === "/notifications").map((c) => c.body?.priority), "done posts nothing").toEqual(["urgent", "normal"]);
  });

  it("is taken back by a message or an interrupt, before the agent says anything", async () => {
    await page("waiting");
    expect(await open()).toBe(true);
    expect((await call("POST", `/agents/${id}/messages`, { text: "Use the first." })).status).toBe(202);
    expect(await open()).toBe(false);
    await page("review");
    expect(await open()).toBe(true);
    expect((await call("POST", `/agents/${id}/messages`, { interrupt: true })).status).toBe(202);
    expect(await open()).toBe(false);
  });

  it("is taken back when the agent is deleted", async () => {
    await page("waiting");
    expect(await open()).toBe(true);
    expect((await call("DELETE", `/agents/${id}`)).status).toBe(202);
    expect(await open()).toBe(false);
  });

  it("is taken back when a closed agent is retired", async () => {
    const closed = { ...(await store.getAgent(id))!, state: "idle", session: null, status: "done", saidAt: "2026-10-01T00:00:00.000Z" } as Agent;
    await store.commit({ agents: [closed], guarded: false });
    // Left open from before this release, when done still nudged, by an agency that has not seen it since.
    fake.active.set(`agent:${id}`, { key: `agent:${id}`, title: "old", body: null, priority: "normal", link: "x" });
    nudge = new Nudge(nudgeUrl, "tk", (a) => a.id, (m) => logged.push(m));
    api = new AgencyApi(store, { value: async () => "secret" }, { now: () => NOW, notifier: nudge });
    expect(await retireClosed(api.fleet, 14, () => {})).toEqual(["frontend-1"]);
    expect(await open()).toBe(false);
  });

  it("never fails the agent's request when nudge is down", async () => {
    fake.failing = true;
    await page("waiting");
    expect((await call("POST", `/agents/${id}/messages`, { text: "Go on." })).status).toBe(202);
    expect((await call("DELETE", `/agents/${id}`)).status).toBe(202);
    await nudge.settled();
    expect(logged.length).toBeGreaterThan(0);
  });
});
