import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { KEPT_FOR, type Host, type Queued, type Worker } from "./domain.ts";
import { Conflict, NameTaken, Stale, Store } from "./store.ts";
import type { WorkerRequest } from "./admission.ts";

const AT = "2026-10-27T12:00:00.000Z";
const host: Host = { id: "laptop", heartbeatAt: AT, version: null, labels: [], capacity: 2 };
const worker = (fields: Partial<Worker> = {}): Worker => ({
  id: "w",
  name: "a",
  hostId: "laptop",
  state: "idle",
  session: null,
  createdAt: AT,
  reportedAt: null,
  hadSession: false,
  ...fields,
});
const queued = (id: string, kind: "create" | "message" = "message", queuedAt = AT): Queued => ({
  command: kind === "create" ? { kind, id, workerId: "w", name: "a" } : { kind, id, workerId: "w", text: "hi" },
  queuedAt,
});
const request = (fields: Partial<WorkerRequest> = {}): WorkerRequest => ({
  id: "r",
  role: "implementer",
  brief: null,
  item: null,
  subject: null,
  label: null,
  labels: [],
  credentials: null,
  ownCredentials: [],
  requester: null,
  state: "waiting",
  why: null,
  createdAt: AT,
  startedAt: null,
  workerId: null,
  withdrawnAt: null,
  ...fields,
});

let dir: string;
let file: string;
let store: Store;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "agent-service-store-"));
  file = join(dir, "db.sqlite");
  store = Store.open(file);
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

const reopen = () => {
  store.close();
  store = Store.open(file);
};

describe("a restart", () => {
  it("keeps hosts, workers, their sessions, transcripts, roles, requests, usage and every command still pending", async () => {
    await store.putHost(host);
    await store.commit({
      workers: [worker({ state: "working", session: { id: "s", startedAt: AT } })],
      sessions: [{ id: "s", workerId: "w", startedAt: AT, endedAt: null, ended: null }],
      queue: [{ hostId: "laptop", queued: queued("c1", "create") }, { hostId: "laptop", queued: queued("c2") }],
      claim: { name: "a", workerId: "w" },
    });
    await store.putLines("w", [{ seq: 0, at: AT, sessionId: "s", from: "agent" as const, text: "Hello." }]);
    await store.putUsage("fiveHour", { utilization: 0.5, resetsAt: AT, readAt: AT, hostId: "laptop" });
    await store.putRequest(request());
    await store.putSecret("w", "waypoint", "s3cret");
    await store.putConnection({ connectionId: "c", kind: "host", hostId: "laptop", connectedAt: AT });
    reopen();
    expect(await store.listHosts()).toEqual([host]);
    expect(await store.getWorker("w")).toMatchObject({ state: "working", session: { id: "s" } });
    expect((await store.sessionsOf("w")).map((s) => s.id)).toEqual(["s"]);
    expect(await store.readLines("w", -1, 10)).toEqual([{ seq: 0, at: AT, sessionId: "s", from: "agent" as const, text: "Hello." }]);
    expect((await store.pending("laptop")).map((q) => q.command.id)).toEqual(["c1", "c2"]);
    expect((await store.sentTo("w")).map((s) => s.command.id)).toEqual(["c1", "c2"]);
    expect((await store.usage()).fiveHour?.utilization).toBe(0.5);
    expect((await store.listRequests()).map((r) => r.id)).toEqual(["r"]);
    expect(await store.getSecret("w", "waypoint")).toBe("s3cret");
    await expect(store.commit({ claim: { name: "a", workerId: "other" } })).rejects.toBeInstanceOf(NameTaken);
    // A socket does not outlive the process that held it.
    expect(await store.connections()).toEqual([]);
  });
});

describe("a change", () => {
  it("is refused whole when the name is taken, and writes nothing", async () => {
    await store.commit({ claim: { name: "a", workerId: "w" } });
    await expect(store.commit({ workers: [worker({ id: "x" })], claim: { name: "a", workerId: "x" } })).rejects.toBeInstanceOf(NameTaken);
    expect(await store.getWorker("x")).toBeNull();
  });

  it("frees a released name for the next to claim it", async () => {
    await store.commit({ claim: { name: "a", workerId: "w" } });
    await store.commit({ claim: { name: "b", workerId: "w" }, release: "a" });
    await store.commit({ claim: { name: "a", workerId: "x" } });
  });

  it("guarded, is refused as a conflict when a worker was written since it was read", async () => {
    await store.commit({ workers: [worker()], guarded: true });
    const read = (await store.getWorker("w"))!;
    await store.commit({ workers: [{ ...read, state: "working" }], guarded: true });
    await expect(store.commit({ workers: [{ ...read, state: "interrupted" }], guarded: true })).rejects.toBeInstanceOf(Conflict);
    expect((await store.getWorker("w"))!.state).toBe("working");
  });

  it("guarded, refuses a new worker that another write made first", async () => {
    await store.commit({ workers: [worker()] });
    await expect(store.commit({ workers: [worker()], guarded: true })).rejects.toBeInstanceOf(Conflict);
  });

  it("writes only a session's ending over what it began with", async () => {
    const context = { key: "global", version: 3 };
    await store.commit({ sessions: [{ id: "s", workerId: "w", startedAt: AT, endedAt: null, ended: null, context, documents: [], skills: [], contextNote: null }] });
    await store.commit({ sessions: [{ id: "s", workerId: "w", startedAt: AT, endedAt: AT, ended: "stopped" }] });
    expect(await store.sessionsOf("w")).toEqual([{ id: "s", workerId: "w", startedAt: AT, endedAt: AT, ended: "stopped", context, documents: [], skills: [], contextNote: null }]);
  });
});

describe("a command", () => {
  it("settled taken off its host's queue, and held as written until its host says it was taken", async () => {
    await store.commit({ queue: [{ hostId: "laptop", queued: queued("c") }] });
    const sent = { ...queued("c"), reportedAt: AT, ok: true, error: null, withdrawnAt: null };
    await store.settle("laptop", { ...sent, taken: false });
    expect(await store.pending("laptop")).toEqual([]);
    expect((await store.written("laptop")).map((s) => s.command.id)).toEqual(["c"]);
    await store.settle("laptop", { ...sent, taken: null });
    expect(await store.written("laptop")).toEqual([]);
    expect(await store.sentTo("w")).toEqual([{ ...sent, taken: null }]);
  });
});

describe("a request", () => {
  it("written from a stale reading is refused, so admitting and withdrawing cannot both land", async () => {
    const written = await store.putRequest(request());
    await store.putRequest({ ...written, state: "started" });
    await expect(store.putRequest({ ...written, state: "withdrawn" })).rejects.toBeInstanceOf(Stale);
    await expect(store.putRequest(request())).rejects.toBeInstanceOf(Stale);
  });
});

describe("usage", () => {
  it("keeps only a reading newer than the one on record", async () => {
    const window = { utilization: 0.5, resetsAt: AT, readAt: "2026-10-27T12:00:00.000Z", hostId: "a" };
    expect(await store.putUsage("fiveHour", window)).toBe(true);
    expect(await store.putUsage("fiveHour", { ...window, utilization: 0.9, readAt: "2026-10-27T11:00:00.000Z" })).toBe(false);
    expect(await store.putUsage("fiveHour", { ...window, utilization: 0.7, readAt: "2026-10-27T13:00:00.000Z" })).toBe(true);
    expect((await store.usage()).fiveHour?.utilization).toBe(0.7);
  });
});

describe("a ticket", () => {
  it("is good once", async () => {
    await store.putTicket("h", AT);
    expect(await store.takeTicket("h")).toBe(AT);
    expect(await store.takeTicket("h")).toBeNull();
  });
});

describe("pruning", () => {
  it("forgets commands' records, pending commands not durable, ended requests and spent tickets once they age out", async () => {
    const old = new Date(Date.parse(AT) - (KEPT_FOR + 60) * 1000).toISOString();
    await store.commit({
      queue: [
        { hostId: "laptop", queued: queued("old-create", "create", old) },
        { hostId: "laptop", queued: queued("old-message", "message", old) },
        { hostId: "laptop", queued: queued("new", "message", AT) },
      ],
    });
    await store.putTicket("spent", old);
    await store.putRequest(request({ id: "waiting" }));
    expect(store.prune(new Date(AT))).toBe(4);
    expect((await store.pending("laptop")).map((q) => q.command.id)).toEqual(["old-create", "new"]);
    expect((await store.sentTo("w")).map((s) => s.command.id)).toEqual(["new"]);
    expect((await store.listRequests()).map((r) => r.id)).toEqual(["waiting"]);
    expect(await store.takeTicket("spent")).toBeNull();
  });
});
