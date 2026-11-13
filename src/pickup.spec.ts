import { beforeEach, describe, expect, it } from "vitest";
import { AgentServiceApi, fixedToken } from "./api.ts";
import { FakeStore } from "./fake-store.ts";
import { PER_TICK, Pickup, PICKER, type Self } from "./pickup.ts";
import { start } from "./server.ts";
import { testRoles } from "./test-roles.ts";

const TOKEN = "t";

interface Task {
  id: string;
  shortId: string;
  title: string;
  status: string;
  ready: boolean;
  assignee: string | null;
  createdAt: string;
}

let store: FakeStore;
let api: AgentServiceApi;
let tasks: Task[];
let up: boolean;
let refusePatch: boolean;
let seen: string[];
let logged: string[];

const task = (n: number, fields: Partial<Task> = {}): Task => ({
  id: `0000000${n}-aaaa-4bbb-8ccc-dddddddddddd`,
  shortId: `0000000${n}`,
  title: `Task ${n}`,
  status: "backlog",
  ready: true,
  assignee: null,
  createdAt: `2026-11-12T0${n}:00:00.000Z`,
  ...fields,
});

/** A stand-in waypoint: ListTasks with its ready and assignee filters, oldest first, and UpdateTask's assignee. */
const waypoint = (async (url: string | URL | Request, init?: RequestInit) => {
  seen.push(`${init?.method} ${String(url).replace("https://wp", "")} ${new Headers(init?.headers).get("authorization")} ${new Headers(init?.headers).get("x-actor")}`);
  if (!up) throw new Error("connect ECONNREFUSED");
  const { pathname, searchParams } = new URL(String(url));
  if (init?.method === "GET" && pathname === "/tasks") {
    const found = tasks
      .filter((t) => searchParams.get("ready") !== "true" || t.ready)
      .filter((t) => searchParams.get("assignee") !== "none" || !t.assignee)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    return Response.json({ tasks: found, nextToken: null });
  }
  const id = /^\/tasks\/(.+)$/.exec(pathname)?.[1];
  const held = tasks.find((t) => t.id === id);
  if (init?.method === "PATCH" && held) {
    if (refusePatch) return Response.json({ code: "ConflictException", message: "Changed." }, { status: 409 });
    Object.assign(held, JSON.parse(String(init.body)));
    return Response.json({ task: held });
  }
  return Response.json({ code: "ResourceNotFoundException" }, { status: 404 });
}) as typeof globalThis.fetch;

const self: Self = async (method, path, body) => {
  const res = await api.fetch(
    new Request(`http://local${path}`, {
      method,
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json", "claimed-by": PICKER },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    }),
  );
  return { status: res.status, body: res.status === 204 ? null : await res.json() };
};

const pickup = () => new Pickup({ url: "https://wp", token: { value: async () => "wp-token" } }, store, self, "implementer", waypoint, (line) => logged.push(line));

beforeEach(() => {
  store = new FakeStore();
  api = new AgentServiceApi(store, fixedToken(TOKEN), { roles: testRoles() });
  tasks = [];
  up = true;
  refusePatch = false;
  seen = [];
  logged = [];
});

describe("picking up waypoint's ready tasks", () => {
  it("asks for an agent for each ready, unassigned task, oldest first, and assigns the task to it by name", async () => {
    tasks = [task(2), task(1)];
    expect(await pickup().tick()).toEqual([task(1).id, task(2).id]);
    const requests = (await store.listRequests()).sort((a, b) => a.createdAt.localeCompare(b.createdAt) || 0);
    expect(requests.map((r) => r.item).sort()).toEqual([task(1).id, task(2).id]);
    for (const request of requests) {
      const held = tasks.find((t) => t.id === request.item)!;
      expect(held.assignee).toBe(`implementer-${request.id.slice(0, 8)}`);
      expect(request).toMatchObject({ role: "implementer", requester: PICKER, subject: `waypoint ${held.shortId}`, label: `task: ${held.title}`, state: "waiting" });
      expect(request.brief).toContain(`waypoint task ${held.shortId}`);
    }
    expect(seen[0]).toBe("GET /tasks?ready=true&assignee=none&maxResults=20 Bearer wp-token agent-service");
  });

  it("never takes a task with an assignee, or one not ready, and two looks never take one task twice", async () => {
    tasks = [task(1, { assignee: "someone" }), task(2, { ready: false }), task(3)];
    const picker = pickup();
    expect(await picker.tick()).toEqual([task(3).id]);
    expect(await picker.tick()).toEqual([]);
    // Taken, though its assignee was since cleared by hand: it is asked for once.
    tasks.find((t) => t.id === task(3).id)!.assignee = null;
    expect(await picker.tick()).toEqual([]);
    expect((await store.listRequests()).map((r) => r.item)).toEqual([task(3).id]);
  });

  it("does not look again while a look is still running", async () => {
    tasks = [task(1)];
    const picker = pickup();
    const [first, second] = await Promise.all([picker.tick(), picker.tick()]);
    expect([first, second]).toEqual([[task(1).id], []]);
    expect(await store.listRequests()).toHaveLength(1);
  });

  it("takes nothing while waypoint is down, saying so, and takes the task on the next look", async () => {
    tasks = [task(1)];
    up = false;
    const picker = pickup();
    expect(await picker.tick()).toEqual([]);
    expect(await store.listRequests()).toEqual([]);
    expect(logged).toEqual([JSON.stringify({ pickUp: "failed", error: "connect ECONNREFUSED" })]);
    up = true;
    expect(await picker.tick()).toEqual([task(1).id]);
  });

  it("lets go of a task whose assignee cannot be set, withdrawing its request, and tries it again on the next look", async () => {
    tasks = [task(1)];
    refusePatch = true;
    const picker = pickup();
    expect(await picker.tick()).toEqual([]);
    expect((await store.listRequests()).map((r) => r.state)).toEqual(["withdrawn"]);
    refusePatch = false;
    expect(await picker.tick()).toEqual([task(1).id]);
  });

  it("takes at most PER_TICK tasks in one look", async () => {
    tasks = Array.from({ length: PER_TICK + 2 }, (_, i) => task(i + 1));
    expect(await pickup().tick()).toHaveLength(PER_TICK);
  });
});

describe("the served process", () => {
  it("refuses to pick up tasks when the services name no waypoint", () => {
    expect(() => start({ db: ":memory:", token: TOKEN, services: {}, pickUp: "implementer" })).toThrow("picking up tasks needs the services to name waypoint");
  });
});
