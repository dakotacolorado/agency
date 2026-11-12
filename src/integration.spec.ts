import { afterAll, describe, expect, it } from "vitest";
import type { Host } from "./domain.ts";
import type { Command, SocketOutbound } from "./schema.ts";

/** Runs against a running instance, never prod: `INTEGRATION_AG_URL=... INTEGRATION_AG_TOKEN=... npm test` */

const url = process.env.INTEGRATION_AG_URL?.replace(/\/$/, "");
const token = process.env.INTEGRATION_AG_TOKEN;

/**
 * Each run sends heartbeats as hosts of its own and names its agents after
 * itself, so a run that dies cannot leave the next one refused as full or by
 * a name in use. A host stays listed until it is deregistered and an agent
 * holds its name until retired, so the run undoes both on the way out.
 */
const run = process.env.GITHUB_RUN_ID
  ? `${process.env.GITHUB_RUN_ID}-${process.env.GITHUB_RUN_ATTEMPT ?? 1}`
  : `${Date.now()}`;
const sentAs = new Set<string>();
const made = new Set<string>();
const hostOf = (name: string) => `integration-${name}-${run}`;

const EMPTY = { version: "integration", labels: [] };

const heartbeat = (body: object = {}, host = hostOf("test")) => {
  sentAs.add(host);
  return fetch(`${url}/hosts/${host}/heartbeat`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ ...EMPTY, ...body }),
  });
};

const beat = async (body: object, host: string) => {
  const res = await heartbeat(body, host);
  expect(res.status, await res.clone().text()).toBe(200);
  return (await res.json()) as { heartbeatInterval: number; socketUrl: string };
};

/**
 * A host's socket, as agent-host opens it: the token in a header, which
 * Node's WebSocket (undici's) takes and a browser's does not. Commands are
 * kept as they arrive, for `next` to take in order.
 */
async function hostSocket(socketUrl: string, host: string) {
  const ws = new WebSocket(`${socketUrl}?hostId=${host}`, {
    headers: { Authorization: `Bearer ${token}` },
  } as unknown as string[]);
  const inbox: Command[] = [];
  const errors: string[] = [];
  ws.onmessage = (event) => {
    const message = JSON.parse(String(event.data)) as SocketOutbound;
    if (message.type === "command") inbox.push(message.command);
    if (message.type === "error") errors.push(message.error);
  };
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = () => reject(new Error(`${host}'s socket did not open.`));
  });
  return {
    send: (message: object) => ws.send(JSON.stringify(message)),
    report: (body: object) => ws.send(JSON.stringify({ type: "report", ...body })),
    async next(kind: Command["kind"]): Promise<Command> {
      for (let waited = 0; waited < 15_000; waited += 100) {
        const at = inbox.findIndex((c) => c.kind === kind);
        if (at >= 0) return inbox.splice(at, 1)[0]!;
        expect(errors).toEqual([]);
        await new Promise((r) => setTimeout(r, 100));
      }
      throw new Error(`No ${kind} came down ${host}'s socket.`);
    },
    close: () => ws.close(),
  };
}

/** Until `check` passes, since a report on the socket is answered with nothing. */
async function eventually(check: () => Promise<void>): Promise<void> {
  for (let tries = 0; ; tries++) {
    try {
      return await check();
    } catch (err) {
      if (tries >= 30) throw err;
      await new Promise((r) => setTimeout(r, 500));
    }
  }
}

const call = (method: string, path: string, body?: unknown, bearer = token) =>
  fetch(`${url}${path}`, {
    method,
    headers: { Authorization: `Bearer ${bearer}`, "Content-Type": "application/json" },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });

const read = async (path: string, bearer = token): Promise<any> => {
  const res = await call("GET", path, undefined, bearer);
  expect(res.status, await res.clone().text()).toBe(200);
  return res.json();
};

const ack = (commands: Command[]) => commands.map((c) => ({ commandId: c.id, ok: true }));

describe.skipIf(!url || !token)("deployed stage", () => {
  afterAll(async () => {
    for (const id of made) await call("DELETE", `/agents/${id}`);
    for (const host of sentAs) await call("DELETE", `/hosts/${host}`);
  });

  it("serves health without a token", async () => {
    const res = await fetch(`${url}/health`);
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ ok: true });
  });

  it("refuses a read without the token, or with the wrong one", async () => {
    expect((await fetch(`${url}/hosts`)).status).toBe(401);
    expect((await call("GET", "/hosts", undefined, "wrong")).status).toBe(401);
  });

  it("accepts a heartbeat, lists the host, and says where its socket is", async () => {
    const res = await heartbeat({ labels: ["integration"] });
    expect(res.status, await res.clone().text()).toBe(200);
    const body = (await res.json()) as { socketUrl: string | null };
    expect(body.socketUrl).toMatch(/^wss:\/\//);

    const { hosts } = (await read("/hosts")) as { hosts: Host[] };
    expect(hosts.find((h) => h.id === hostOf("test"))).toMatchObject({
      version: "integration",
      labels: ["integration"],
    });
    expect((await call("GET", `/hosts/${hostOf("never")}`)).status).toBe(404);
  });

  it("gives a page a one-time socket ticket", async () => {
    const res = await call("POST", "/socket-tickets");
    expect(res.status, await res.clone().text()).toBe(201);
    expect(await res.json()).toMatchObject({ ticket: expect.any(String), socketUrl: expect.stringMatching(/^wss:\/\//) });
  });

  it("refuses a report on the heartbeat, which goes by the socket alone", async () => {
    expect((await heartbeat({ agents: [] })).status).toBe(400);
  });

  it("carries an agent from creation through a session to retirement, by socket", async () => {
    const host = hostOf("agents");
    const { socketUrl } = await beat({ capacity: 1 }, host);
    expect(socketUrl).toMatch(/^wss:\/\//);

    // Made before its host's socket is open, its create is replayed when it opens.
    const res = await call("POST", "/agents", {
      name: `it-${run}`,
      hostId: host,
    });
    expect(res.status, await res.clone().text()).toBe(201);
    const agent = (await res.json()) as { id: string; state: string; reportedAt: string | null };
    made.add(agent.id);
    expect(agent).toMatchObject({ state: "idle", reportedAt: null });

    const socket = await hostSocket(socketUrl, host);
    try {
      socket.report({ agents: [] });
      const home = await socket.next("create");
      expect(home).toMatchObject({ kind: "create", agentId: agent.id });
      socket.report({ commandResults: ack([home]), agents: [{ id: agent.id, state: "idle", sessionId: null }] });
      await eventually(async () => {
        const sent = await read(`/agents/${agent.id}/commands`);
        expect(sent.commands[0]).toMatchObject({ delivery: "done" });
        expect((await read(`/agents/${agent.id}`)).reportedAt).not.toBeNull();
      });

      // A message to an idle agent starts its session, pushed as it is written.
      const told = await call("POST", `/agents/${agent.id}/messages`, { text: "Say hello." });
      expect(told.status, await told.clone().text()).toBe(202);
      const start = (await socket.next("start")) as Extract<Command, { kind: "start" }>;
      expect(start).toMatchObject({ kind: "start", resume: false, text: "Say hello." });
      // The session can reach this service as the agent, and says it waits on its own subagents.
      // The address is on record; the token comes only as the start is pushed, never in env.
      expect(start.env).toMatchObject({ AG_URL: url });
      expect(start.env).not.toHaveProperty("AG_TOKEN");
      expect(start.secrets?.AG_TOKEN === token).toBe(true);
      const paged = await fetch(`${start.env!.AG_URL}/agents/${agent.id}/status`, {
        method: "PUT",
        headers: { Authorization: `Bearer ${start.secrets!.AG_TOKEN}`, "Content-Type": "application/json" },
        body: JSON.stringify({ status: "working", summary: "Waiting on a background subagent", headline: "On a subagent" }),
      });
      expect(paged.status, await paged.clone().text()).toBe(200);
      const titled = await fetch(`${start.env!.AG_URL}/agents/${agent.id}/title`, {
        method: "PUT",
        headers: { Authorization: `Bearer ${start.secrets!.AG_TOKEN}`, "Content-Type": "application/json" },
        body: JSON.stringify({ title: "Integration check" }),
      });
      expect(titled.status, await titled.clone().text()).toBe(200);
      const line = { agentId: agent.id, sessionId: start.sessionId, seq: 0, at: new Date().toISOString(), from: "agent", text: "Hello." };
      socket.report({
        commandResults: ack([start]),
        agents: [{ id: agent.id, state: "waiting", sessionId: start.sessionId, tasks: 1, told: true }],
        lines: [line],
      });
      await eventually(async () => {
        // Its turn ended with a background subagent open, so it reads working, not waiting on the person.
        expect(await read(`/agents/${agent.id}`)).toMatchObject({
          state: "waiting",
          status: "working",
          tasks: 1,
          summary: "Waiting on a background subagent",
          headline: "On a subagent",
          title: "Integration check",
        });
        const { lines } = await read(`/agents/${agent.id}/transcript`);
        expect(lines).toEqual([{ seq: 0, at: line.at, sessionId: start.sessionId, from: "agent", text: "Hello." }]);
      });
      // The subagent done and nothing paged since, it is idle: still not waiting on the person.
      socket.report({ agents: [{ id: agent.id, state: "waiting", sessionId: start.sessionId, tasks: 0, told: true }] });
      await eventually(async () => {
        expect(await read(`/agents/${agent.id}`)).toMatchObject({ status: "idle", tasks: 0, told: true });
      });

      // Stopped, it is idle with its session on record.
      expect((await call("POST", `/agents/${agent.id}/stop`, {})).status).toBe(202);
      const stop = await socket.next("stop");
      socket.report({ commandResults: ack([stop]) });
      await eventually(async () => {
        expect((await read(`/agents/${agent.id}`)).state).toBe("idle");
      });
      expect((await read(`/agents/${agent.id}/sessions`)).sessions).toMatchObject([{ id: start.sessionId, ended: "stopped" }]);

      // Retired, it leaves the default list.
      expect((await call("DELETE", `/agents/${agent.id}`)).status).toBe(202);
      const retire = await socket.next("retire");
      socket.report({ commandResults: ack([retire]) });
      await eventually(async () => {
        const sent = await read(`/agents/${agent.id}/commands`);
        expect(sent.commands.at(-1)).toMatchObject({ delivery: "done" });
        // Compared, not shown, so a failure does not print it.
        expect(JSON.stringify(sent).includes(token!)).toBe(false);
      });
      made.delete(agent.id);
      const { agents } = await read("/agents");
      expect(agents.filter((w: { hostId: string }) => w.hostId === host)).toEqual([]);
    } finally {
      socket.close();
    }
  }, 120_000);
});
