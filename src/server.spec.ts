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

const GLOBAL = {
  name: "workplace/global",
  version: 3,
  files: [{ path: "SKILL.md", content: "---\nname: global\ndescription: Facts.\n---\n\n# Working here", executable: false }],
};
const PLANNER = { name: "workplace/planner", version: 5, files: [{ path: "SKILL.md", content: "---\nname: planner\n---\nPlan it.", executable: false }] };
const WAYPOINT_SKILL = {
  key: "waypoint",
  version: 12,
  commit: "abc",
  files: [
    { path: "skills/waypoint/bin/wp", content: "#!/bin/sh", executable: true },
    { path: "skills/waypoint/reference/api.md", content: "# API", executable: false },
  ],
};

/** honed and waypoint in one stand-in: honed's skills by name, and waypoint's `GET /skill`. */
beforeEach(async () => {
  honedUp = true;
  asked.length = 0;
  stub = createServer((req, res) => {
    asked.push(`${req.url} ${req.headers.authorization}`);
    const send = (status: number, body: unknown) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
    if (req.url === "/waypoint/skill") return send(200, WAYPOINT_SKILL);
    // honed has no client of its own to give.
    if (req.url === "/skill") return send(404, { error: "Not found." });
    if (!honedUp) return send(502, { error: "down" });
    const skills: Record<string, unknown> = { "/api/skills/workplace/global": GLOBAL, "/api/skills/workplace/planner": PLANNER };
    const found = skills[req.url ?? ""];
    send(found ? 200 : 404, found ?? { error: "No skill has that name." });
  });
  await new Promise<void>((ready) => stub.listen(0, "127.0.0.1", ready));
  stubUrl = `http://127.0.0.1:${(stub.address() as AddressInfo).port}`;
  running = start({
    db: ":memory:",
    token: TOKEN,
    adminToken: null,
    services: {
      honed: { url: stubUrl, urlVar: "HONED_URL", tokenVar: "HONED_TOKEN", tokenEnv: "TEST_HONED_TOKEN" },
      waypoint: { url: `${stubUrl}/waypoint`, urlVar: "WAYPOINT_URL", tokenVar: "WAYPOINT_TOKEN", tokenEnv: "TEST_WAYPOINT_TOKEN" },
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
  const { body } = await call("GET", `/agents/${id}/commands`);
  return body.commands.map((c: { command: Command }) => c.command).findLast((c: Command) => c.kind === "start") as Extract<Command, { kind: "start" }>;
};

const planner = async (name: string) => {
  expect((await call("POST", "/hosts/laptop/heartbeat", { version: "t", labels: [], capacity: 4 })).status).toBe(200);
  const made = await call("POST", "/agents", { name, hostId: "laptop", role: "planner" });
  expect(made.status, JSON.stringify(made.body)).toBe(201);
  return made.body.id as string;
};

describe("a session started by the served process", () => {
  it("holds workplace/global as CLAUDE.md and its role's skills at honed's current version, each service's client at its paths", async () => {
    const id = await planner("planner-1");
    const begin = await startOf(id);
    expect(begin.context).toEqual({
      key: "workplace/global",
      version: 3,
      files: expect.arrayContaining([
        { path: "CLAUDE.md", content: "# Working here", executable: false },
        { path: "skills/waypoint/bin/wp", content: "#!/bin/sh", executable: true },
        { path: "skills/waypoint/reference/api.md", content: "# API", executable: false },
        expect.objectContaining({ path: "skills/page/SKILL.md" }),
        expect.objectContaining({ path: "skills/page/bin/page", executable: true }),
        expect.objectContaining({ path: "skills/title/bin/title", executable: true }),
      ]),
    });
    expect(begin.documents).toEqual([
      { key: "workplace/planner", version: 5, files: [{ path: "skills/planner/SKILL.md", content: "---\nname: planner\n---\nPlan it.", executable: false }] },
    ]);
    expect(begin.env).toMatchObject({ HONED_URL: stubUrl, WAYPOINT_URL: `${stubUrl}/waypoint`, AG_URL: "http://local" });
    const [session] = (await call("GET", `/agents/${id}/sessions`)).body.sessions;
    expect(session).toMatchObject({
      context: { key: "workplace/global", version: 3 },
      documents: [{ key: "workplace/planner", version: 5 }],
      skills: expect.arrayContaining([expect.objectContaining({ key: "waypoint", version: 12, commit: "abc" }), expect.objectContaining({ key: "agent-service" })]),
      contextNote: null,
    });
    expect(asked).toContain("/api/skills/workplace/global Bearer honed-token");
    expect(asked).toContain("/waypoint/skill Bearer waypoint-token");
  });

  it("with honed down, starts from the last good copy, and its context note says so", async () => {
    await planner("planner-1");
    honedUp = false;
    const id = await planner("planner-2");
    const begin = await startOf(id);
    expect(begin.context?.files).toContainEqual({ path: "CLAUDE.md", content: "# Working here", executable: false });
    expect(begin.documents?.map((d) => `${d.key} v${d.version}`)).toEqual(["workplace/planner v5"]);
    const [session] = (await call("GET", `/agents/${id}/sessions`)).body.sessions;
    expect(session.contextNote).toBe(
      "honed answered 502 for workplace/global, so workplace/global is its last good copy, v3; " +
        "honed answered 502 for workplace/planner, so workplace/planner is its last good copy, v5",
    );
  });

  it("refuses an agent naming a skill honed does not have", async () => {
    await call("POST", "/hosts/laptop/heartbeat", { version: "t", labels: [], capacity: 4 });
    const made = await call("POST", "/agents", { name: "x-1", hostId: "laptop", documents: ["workplace/nothing"] });
    expect(made).toEqual({ status: 400, body: { error: "honed has no skill named workplace/nothing" } });
  });
});
