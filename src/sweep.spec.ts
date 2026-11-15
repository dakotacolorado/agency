import { beforeEach, describe, expect, it, vi } from "vitest";
import { AgencyApi } from "./api.ts";
import type { Agent } from "./domain.ts";
import { FakeStore } from "./fake-store.ts";
import { closedSince, RESUME_SECONDS, retireClosed, RETIRE_CLOSED_AFTER, startTimers } from "./sweep.ts";

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
  it("defaults to 14 days", () => {
    expect(RETIRE_CLOSED_AFTER).toBe(14);
  });

  it("deletes a done agent closed 15 days ago as DeleteAgent does, keeping its sessions and transcript", async () => {
    await agent("old", {}, 15);
    expect(await retire()).toEqual(["old"]);
    expect(state("old")).toBe("deleted");
    expect(store.commands.get("laptop")!.map((q) => q.command.kind)).toEqual(["delete"]);
    expect(await store.sessionsOf("id-old")).toHaveLength(1);
    expect(await store.readLines("id-old", 0, 10)).toHaveLength(1);
    expect(lines.map((l) => JSON.parse(l))).toEqual([{ retired: "old", closedSince: daysAgo(15) }]);
    // Its name is free again, as after DeleteAgent.
    await expect(store.commit({ claim: { name: "old", agentId: "another" } })).resolves.toBeUndefined();
  });

  it("keeps one closed 13 days ago", async () => {
    await agent("recent", {}, 13);
    expect(await retire()).toEqual([]);
    expect(state("recent")).toBe("idle");
  });

  it("counts from the later of saying done and its session ending", async () => {
    await agent("said-late", {}, 20, 1);
    await agent("ended-late", {}, 1, 20);
    expect(await retire()).toEqual([]);
    expect(closedSince(store.agents.get("id-said-late")!, await store.sessionsOf("id-said-late"))).toBe(daysAgo(1));
  });

  it("never retires one in review, waiting or working, or with a live session or a running task, whatever its age", async () => {
    await agent("review", { status: "review" }, 365);
    await agent("waiting", { status: "waiting" }, 365);
    await agent("working", { status: "working" }, 365);
    await agent("unsaid", { status: null }, 365);
    await agent("live", { state: "working", session: { id: "s-live-now", startedAt: daysAgo(30) } }, 365);
    await agent("live-idle", { state: "waiting", session: { id: "s-live-idle", startedAt: daysAgo(30) } }, 365);
    await agent("tasks", { tasks: 2 }, 365);
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
    await agent("old", {}, 15);
    let done!: () => void;
    const swept = new Promise<void>((r) => (done = r));
    const stop = startTimers(store, { log: () => {}, now: () => NOW, retire: () => retire().then(done) });
    await swept;
    stop();
    expect(state("old")).toBe("deleted");
  });

  it("reconciles on its first sweep, once the retire has run", async () => {
    await agent("old", {}, 15);
    const seen: string[] = [];
    let done!: () => void;
    const swept = new Promise<void>((r) => (done = r));
    const stop = startTimers(store, {
      log: () => {},
      now: () => NOW,
      retire: () => retire().then(() => seen.push("retired")),
      reconcile: async () => {
        seen.push(`reconciled with old ${state("old")}`);
        done();
      },
    });
    await swept;
    stop();
    expect(seen).toEqual(["retired", "reconciled with old deleted"]);
  });

  it("resumes every minute, apart from the hourly sweep, one look at a time, until stopped", async () => {
    vi.useFakeTimers();
    try {
      let looks = 0;
      let finish!: () => void;
      const stop = startTimers(store, {
        log: () => {},
        now: () => NOW,
        resume: () => {
          looks++;
          return new Promise<void>((r) => (finish = r));
        },
      });
      expect(RESUME_SECONDS).toBe(60);
      expect(looks).toBe(0);
      await vi.advanceTimersByTimeAsync(RESUME_SECONDS * 1000);
      expect(looks).toBe(1);
      // Still running: the next tick does not start another.
      await vi.advanceTimersByTimeAsync(RESUME_SECONDS * 1000);
      expect(looks).toBe(1);
      finish();
      await vi.advanceTimersByTimeAsync(RESUME_SECONDS * 1000);
      expect(looks).toBe(2);
      finish();
      stop();
      await vi.advanceTimersByTimeAsync(10 * RESUME_SECONDS * 1000);
      expect(looks).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
