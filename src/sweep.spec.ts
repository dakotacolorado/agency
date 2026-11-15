import { beforeEach, describe, expect, it } from "vitest";
import { AgencyApi } from "./api.ts";
import type { Agent } from "./domain.ts";
import { FakeStore } from "./fake-store.ts";
import { closedSince, retireClosed, RETIRE_CLOSED_AFTER, startTimers } from "./sweep.ts";

const NOW = new Date("2026-11-14T12:00:00.000Z");
const daysAgo = (days: number) => new Date(NOW.getTime() - days * 24 * 3600 * 1000).toISOString();

let store: FakeStore;
let api: AgencyApi;
let lines: string[];

beforeEach(() => {
  store = new FakeStore();
  api = new AgencyApi(store, { value: async () => "secret" }, { now: () => NOW });
  lines = [];
});

/** An agent written as it stands once closed: its last session ended `endedDaysAgo`, and it said `status` `saidDaysAgo`. */
async function agent(name: string, fields: Partial<Agent>, endedDaysAgo: number | null, saidDaysAgo: number | null = endedDaysAgo) {
  const record: Agent = {
    id: `id-${name}`,
    name,
    hostId: "laptop",
    state: "idle",
    session: null,
    createdAt: daysAgo(30),
    reportedAt: daysAgo(30),
    hadSession: true,
    tasks: 0,
    status: "done",
    summary: "finished",
    saidAt: saidDaysAgo === null ? null : daysAgo(saidDaysAgo),
    ...fields,
  };
  await store.commit({
    agents: [record],
    sessions:
      endedDaysAgo === null
        ? []
        : [{ id: `s-${name}`, agentId: record.id, startedAt: daysAgo(20), endedAt: daysAgo(endedDaysAgo), ended: "stopped" }],
    claim: { name, agentId: record.id },
  });
  await store.putLines(record.id, [{ seq: 1, at: daysAgo(20), sessionId: `s-${name}`, from: "agent", text: "hello" }]);
  return record;
}

const state = (name: string) => store.agents.get(`id-${name}`)!.state;
const retire = (days = RETIRE_CLOSED_AFTER) => retireClosed(api.fleet, days, (l) => lines.push(l));

describe("retireClosed", () => {
  it("defaults to 3 days", () => {
    expect(RETIRE_CLOSED_AFTER).toBe(3);
  });

  it("deletes a done agent closed 4 days ago as DeleteAgent does, keeping its sessions and transcript", async () => {
    await agent("old", {}, 4);
    expect(await retire()).toEqual(["old"]);
    expect(state("old")).toBe("deleted");
    expect(store.commands.get("laptop")!.map((q) => q.command.kind)).toEqual(["delete"]);
    expect(await store.sessionsOf("id-old")).toHaveLength(1);
    expect(await store.readLines("id-old", 0, 10)).toHaveLength(1);
    expect(lines.map((l) => JSON.parse(l))).toEqual([{ retired: "old", closedSince: daysAgo(4) }]);
    // Its name is free again, as after DeleteAgent.
    await expect(store.commit({ claim: { name: "old", agentId: "another" } })).resolves.toBeUndefined();
  });

  it("keeps one closed 2 days ago", async () => {
    await agent("recent", {}, 2);
    expect(await retire()).toEqual([]);
    expect(state("recent")).toBe("idle");
  });

  it("counts from the later of saying done and its session ending", async () => {
    await agent("said-late", {}, 5, 1);
    await agent("ended-late", {}, 1, 5);
    expect(await retire()).toEqual([]);
    expect(closedSince(store.agents.get("id-said-late")!, await store.sessionsOf("id-said-late"))).toBe(daysAgo(1));
  });

  it("never retires one in review, waiting or working, or with a live session or a running task, whatever its age", async () => {
    await agent("review", { status: "review" }, 30);
    await agent("waiting", { status: "waiting" }, 30);
    await agent("working", { status: "working" }, 30);
    await agent("unsaid", { status: null }, 30);
    await agent("live", { state: "working", session: { id: "s-live-now", startedAt: daysAgo(30) } }, 30);
    await agent("live-idle", { state: "waiting", session: { id: "s-live-idle", startedAt: daysAgo(30) } }, 30);
    await agent("tasks", { tasks: 2 }, 30);
    expect(await retire()).toEqual([]);
    for (const name of ["review", "waiting", "working", "unsaid", "live", "live-idle", "tasks"]) expect(state(name)).not.toBe("deleted");
  });

  it("retires none when set to 0", async () => {
    await agent("old", {}, 30);
    expect(await retire(0)).toEqual([]);
    expect(state("old")).toBe("idle");
  });

  it("leaves one already deleted alone", async () => {
    await agent("gone", { state: "deleted" }, 30);
    expect(await retire()).toEqual([]);
    expect(store.commands.get("laptop")).toEqual([]);
  });
});

describe("startTimers", () => {
  it("retires on its first sweep", async () => {
    await agent("old", {}, 4);
    let done!: () => void;
    const swept = new Promise<void>((r) => (done = r));
    const stop = startTimers(store, { log: () => {}, now: () => NOW, retire: () => retire().then(done) });
    await swept;
    stop();
    expect(state("old")).toBe("deleted");
  });
});
