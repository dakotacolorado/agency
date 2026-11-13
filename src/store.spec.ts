import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { KEPT_FOR, type Host, type Queued, type Agent } from "./domain.ts";
import { Conflict, NameTaken, Stale, Store } from "./store.ts";
import type { AgentRequest } from "./admission.ts";

const AT = "2026-10-27T12:00:00.000Z";
const host: Host = { id: "laptop", heartbeatAt: AT, version: null, labels: [], capacity: 2 };
const agent = (fields: Partial<Agent> = {}): Agent => ({
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
  command: kind === "create" ? { kind, id, agentId: "w", name: "a" } : { kind, id, agentId: "w", text: "hi" },
  queuedAt,
});
const request = (fields: Partial<AgentRequest> = {}): AgentRequest => ({
  id: "r",
  role: "implementer",
  brief: null,
  item: null,
  subject: null,
  label: null,
  labels: [],
  credentials: null,
  requester: null,
  state: "waiting",
  why: null,
  createdAt: AT,
  startedAt: null,
  agentId: null,
  withdrawnAt: null,
  ...fields,
});

let dir: string;
let file: string;
let store: Store;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "agency-store-"));
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
  it("keeps hosts, agents, their sessions, transcripts, roles, requests, usage and every command still pending", async () => {
    await store.putHost(host);
    await store.commit({
      agents: [agent({ state: "working", session: { id: "s", startedAt: AT } })],
      sessions: [{ id: "s", agentId: "w", startedAt: AT, endedAt: null, ended: null }],
      queue: [{ hostId: "laptop", queued: queued("c1", "create") }, { hostId: "laptop", queued: queued("c2") }],
      claim: { name: "a", agentId: "w" },
    });
    await store.putLines("w", [{ seq: 0, at: AT, sessionId: "s", from: "agent" as const, text: "Hello." }]);
    await store.putUsage("fiveHour", { utilization: 0.5, resetsAt: AT, readAt: AT, hostId: "laptop" });
    await store.putRequest(request());
    await store.putConnection({ connectionId: "c", kind: "host", hostId: "laptop", connectedAt: AT });
    reopen();
    expect(await store.listHosts()).toEqual([host]);
    expect(await store.getAgent("w")).toMatchObject({ state: "working", session: { id: "s" } });
    expect((await store.sessionsOf("w")).map((s) => s.id)).toEqual(["s"]);
    expect(await store.readLines("w", -1, 10)).toEqual([{ seq: 0, at: AT, sessionId: "s", from: "agent" as const, text: "Hello." }]);
    expect((await store.pending("laptop")).map((q) => q.command.id)).toEqual(["c1", "c2"]);
    expect((await store.sentTo("w")).map((s) => s.command.id)).toEqual(["c1", "c2"]);
    expect((await store.usage()).fiveHour?.utilization).toBe(0.5);
    expect((await store.listRequests()).map((r) => r.id)).toEqual(["r"]);
    await expect(store.commit({ claim: { name: "a", agentId: "other" } })).rejects.toBeInstanceOf(NameTaken);
    // Kept for a backup's open of a served database; forgotten only by the process that serves.
    expect((await store.connections()).map((c) => c.connectionId)).toEqual(["c"]);
    store.forgetConnections();
    expect(await store.connections()).toEqual([]);
  });
});

describe("a change", () => {
  it("is refused whole when the name is taken, and writes nothing", async () => {
    await store.commit({ claim: { name: "a", agentId: "w" } });
    await expect(store.commit({ agents: [agent({ id: "x" })], claim: { name: "a", agentId: "x" } })).rejects.toBeInstanceOf(NameTaken);
    expect(await store.getAgent("x")).toBeNull();
  });

  it("frees a released name for the next to claim it", async () => {
    await store.commit({ claim: { name: "a", agentId: "w" } });
    await store.commit({ claim: { name: "b", agentId: "w" }, release: "a" });
    await store.commit({ claim: { name: "a", agentId: "x" } });
  });

  it("guarded, is refused as a conflict when an agent was written since it was read", async () => {
    await store.commit({ agents: [agent()], guarded: true });
    const read = (await store.getAgent("w"))!;
    await store.commit({ agents: [{ ...read, state: "working" }], guarded: true });
    await expect(store.commit({ agents: [{ ...read, state: "interrupted" }], guarded: true })).rejects.toBeInstanceOf(Conflict);
    expect((await store.getAgent("w"))!.state).toBe("working");
  });

  it("guarded, refuses a new agent that another write made first", async () => {
    await store.commit({ agents: [agent()] });
    await expect(store.commit({ agents: [agent()], guarded: true })).rejects.toBeInstanceOf(Conflict);
  });

  it("writes only a session's ending over what it began with", async () => {
    const skills = [{ name: "agent-roles/planner", version: 3 }];
    const clients = { version: 7, commit: "abc" };
    await store.commit({ sessions: [{ id: "s", agentId: "w", startedAt: AT, endedAt: null, ended: null, skills, clients, contextNote: null }] });
    await store.commit({ sessions: [{ id: "s", agentId: "w", startedAt: AT, endedAt: AT, ended: "stopped" }] });
    expect(await store.sessionsOf("w")).toEqual([{ id: "s", agentId: "w", startedAt: AT, endedAt: AT, ended: "stopped", skills, clients, contextNote: null }]);
  });
});

describe("a command", () => {
  it("settled is taken off its host's queue and kept on its agent's record", async () => {
    await store.commit({ queue: [{ hostId: "laptop", queued: queued("c") }] });
    const sent = { ...queued("c"), reportedAt: AT, ok: true, error: null, withdrawnAt: null };
    await store.settle("laptop", sent);
    expect(await store.pending("laptop")).toEqual([]);
    expect(await store.sentTo("w")).toEqual([sent]);
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

describe("a database from before roles moved to honed", () => {
  it("loses its roles and per-agent secrets tables, and nothing else", async () => {
    store.db.exec("CREATE TABLE roles (name TEXT PRIMARY KEY, record TEXT NOT NULL); CREATE TABLE agent_secrets (agent_id TEXT, name TEXT, value TEXT);");
    await store.putHost(host);
    reopen();
    const tables = (store.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((t) => t.name);
    expect(tables).not.toContain("roles");
    expect(tables).not.toContain("agent_secrets");
    expect(await store.listHosts()).toEqual([host]);
  });
});

describe("a database from when agents were retired", () => {
  it("says deleted and delete where its records said retired and retire", async () => {
    store.db.prepare("INSERT INTO agents (id, rev, record) VALUES (?, ?, ?)").run("w", "r", JSON.stringify(agent({ state: "retired" as never, whenDone: "retire" as never })));
    const old = { command: { kind: "retire", id: "c", agentId: "w" }, queuedAt: AT };
    store.db.prepare("INSERT INTO pending (host_id, id, queued_at, durable, record) VALUES (?, ?, ?, 1, ?)").run("laptop", "c", AT, JSON.stringify(old));
    reopen();
    expect(await store.getAgent("w")).toMatchObject({ state: "deleted", whenDone: "delete" });
    expect((await store.pending("laptop")).map((q) => q.command.kind)).toEqual(["delete"]);
  });
});
