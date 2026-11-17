import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Command } from "./schema.ts";
import { start, type Running } from "./server.ts";

const TOKEN = "t";
let running: Running;
let stub: Server;
let stubUrl: string;
let honedUp = true;
const asked: string[] = [];

const ROLE = { label: "plan: new work", priority: 40, whenDone: "stop", services: null, brief: "Ask the person what they want.", summary: "Plans work." };
const PLANNER = {
  name: "agent-roles/planner",
  version: 5,
  files: [
    { path: "SKILL.md", content: "---\nname: planner\n---\nPlan it.", executable: false },
    { path: "role.json", content: JSON.stringify(ROLE), executable: false },
  ],
};

/** honed in a stand-in: its list, and its skills by name. */
beforeEach(async () => {
  honedUp = true;
  asked.length = 0;
  stub = createServer((req, res) => {
    asked.push(`${req.url} ${req.headers.authorization}`);
    const send = (status: number, body: unknown) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
    if (!honedUp) return send(502, { error: "down" });
    if (req.url === "/api/skills") return send(200, [{ name: PLANNER.name, version: PLANNER.version }]);
    if (req.url === "/api/skills/agent-roles/planner") return send(200, PLANNER);
    send(404, { error: "No skill has that name." });
  });
  await new Promise<void>((ready) => stub.listen(0, "127.0.0.1", ready));
  stubUrl = `http://127.0.0.1:${(stub.address() as AddressInfo).port}`;
  running = start({
    db: ":memory:",
    token: TOKEN,
    services: {
      honed: { url: stubUrl, urlVar: "HONED_URL", tokenVar: "HONED_TOKEN", tokenEnv: "TEST_HONED_TOKEN" },
      waypoint: { url: `${stubUrl}/waypoint`, urlVar: "WAYPOINT_URL", tokenVar: "WAYPOINT_TOKEN", tokenEnv: "TEST_WAYPOINT_TOKEN", mcp: "/mcp" },
    },
    env: { TEST_HONED_TOKEN: "honed-token", TEST_WAYPOINT_TOKEN: "waypoint-token" },
  });
});

afterEach(async () => {
  running.close();
  await new Promise((done) => stub.close(done));
});

const call = async (method: string, path: string, body?: unknown) => {
  const res = await running.api.fetch(
    new Request(`http://local${path}`, {
      method,
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    }),
  );
  return { status: res.status, body: (await res.json()) as any };
};

const startOf = async (id: string) => {
  return (await running.store.sentTo(id)).map((s) => s.command).findLast((c) => c.kind === "start") as Extract<Command, { kind: "start" }>;
};

const planner = async (name: string) => {
  await running.api.beat("laptop", { version: "t", labels: [], capacity: 4 });
  const made = await call("POST", "/agents", { name, hostId: "laptop", role: "planner" });
  expect(made.status, JSON.stringify(made.body)).toBe(201);
  return made.body.id as string;
};

describe("roles, as the served process reads them", () => {
  it("are honed's agent-roles/ skills, each with its role.json's settings", async () => {
    expect((await call("GET", "/roles")).body).toEqual({
      roles: [{ name: "planner", skills: ["agent-roles/planner"], credentials: null, whenDone: "stop", label: "plan: new work", description: "Plans work.", priority: 40, capability: 3, brief: "Ask the person what they want.", version: 5 }],
    });
  });
});

describe("a session started by the served process", () => {
  it("holds its role's skill at honed's current version and this service's clients, with no global, and starts on the role's brief", async () => {
    const id = await planner("planner-1");
    const begin = await startOf(id);
    expect(begin.text).toBe("Ask the person what they want.");
    expect(begin.documents).toEqual([
      {
        key: "agent-roles/planner",
        version: 5,
        files: [
          { path: "skills/planner/SKILL.md", content: "---\nname: planner\n---\nPlan it.", executable: false },
          { path: "skills/planner/role.json", content: JSON.stringify(ROLE), executable: false },
        ],
      },
    ]);
    expect(begin.context?.key).toBe("agency");
    expect(begin.context?.files.map((f) => f.path)).toEqual(expect.arrayContaining(["skills/page/SKILL.md", "skills/page/bin/page", "skills/title/bin/title"]));
    expect(JSON.stringify(begin)).not.toContain("workplace/global");
    expect(begin.env).toMatchObject({ HONED_URL: stubUrl, WAYPOINT_URL: `${stubUrl}/waypoint`, AG_URL: "http://local" });
    const [session] = await running.store.sessionsOf(id);
    expect(session).toMatchObject({ skills: [{ name: "agent-roles/planner", version: 5 }], clients: { commit: expect.any(String) }, contextNote: null });
    expect(asked).toContain("/api/skills/agent-roles/planner Bearer honed-token");
  });

  it("with honed down, starts in its role from the last good copies, and its context note says so", async () => {
    await planner("planner-1");
    honedUp = false;
    const id = await planner("planner-2");
    const begin = await startOf(id);
    expect(begin.documents?.map((d) => `${d.key} v${d.version}`)).toEqual(["agent-roles/planner v5"]);
    const [session] = await running.store.sessionsOf(id);
    expect(session!.contextNote).toBe("honed answered 502 for agent-roles/planner, so agent-roles/planner is its last good copy, v5");
  });

  it("names the MCP servers of the services it is given that serve one, with no token in the command", async () => {
    const id = await planner("planner-1");
    const begin = await startOf(id);
    expect(begin.mcpServers).toEqual({
      waypoint: { type: "http", url: "${WAYPOINT_URL}/mcp", headers: { Authorization: "Bearer ${WAYPOINT_TOKEN}", "x-actor": "planner-1" } },
    });
    expect(JSON.stringify(begin)).not.toContain("waypoint-token");
    const narrow = await call("POST", "/agents", { name: "plain-1", hostId: "laptop", brief: "Go.", credentials: ["honed"] });
    expect((await startOf(narrow.body.id)).mcpServers).toBeUndefined();
  });

  it("refuses an agent naming a skill honed does not have", async () => {
    await running.api.beat("laptop", { version: "t", labels: [], capacity: 4 });
    const made = await call("POST", "/agents", { name: "x-1", hostId: "laptop", skills: ["team/nothing"] });
    expect(made).toEqual({ status: 400, body: { code: "ValidationException", message: "honed has no skill named team/nothing" } });
  });
});
