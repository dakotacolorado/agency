import { describe, expect, it } from "vitest";
import { HonedContext, laid } from "./context.ts";
import { FakeStore } from "./fake-store.ts";
import { HonedRoles, roleOf } from "./roles.ts";

const token = (value: string | null) => ({ value: async () => value });

type File = { path: string; content: string; executable?: boolean };
const skill = (name: string, version: number, files: File[]) => ({ name, version, createdAt: "t", maxChars: null, files, versions: [], feedback: [] });

const ROLE_JSON = (fields: object = {}) => JSON.stringify({ label: "plan: new work", priority: 40, whenDone: "stop", services: null, brief: "Ask.", summary: "Plans.", ...fields });
const PLANNER = skill("agent-roles/planner", 2, [
  { path: "SKILL.md", content: "---\nname: planner\n---\nPlan." },
  { path: "role.json", content: ROLE_JSON() },
]);
const IMPLEMENTER = skill("agent-roles/implementer", 1, [
  { path: "SKILL.md", content: "Do it." },
  { path: "role.json", content: ROLE_JSON({ label: "ticket", priority: 10, brief: null, summary: null, skills: ["team/git-commits"] }) },
]);

/** A honed answering its list and each skill by name, 404 for any other; `seen` records each path asked for and its token. */
const honed = (skills: Record<string, ReturnType<typeof skill>>, seen: string[] = []): typeof globalThis.fetch =>
  (async (url: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(url)).pathname;
    seen.push(`${path} ${new Headers(init?.headers).get("authorization")}`);
    if (path === "/api/skills") return Response.json(Object.values(skills).map(({ name, version }) => ({ name, version })));
    const name = path.slice("/api/skills/".length).split("/").map(decodeURIComponent).join("/");
    const found = skills[name];
    return found ? Response.json(found) : Response.json({ error: `No skill is named ${name}.` }, { status: 404 });
  }) as typeof globalThis.fetch;

const down = (async () => {
  throw new Error("connect ECONNREFUSED");
}) as typeof globalThis.fetch;

const service = { url: "https://honed/", token: token("h") };

describe("a honed skill as a session is given it", () => {
  it("is laid whole as a Claude Code skill, under its name's last segment", () => {
    expect(laid(PLANNER)).toEqual({
      key: "agent-roles/planner",
      version: 2,
      files: [
        { path: "skills/planner/SKILL.md", content: "---\nname: planner\n---\nPlan.", executable: false },
        { path: "skills/planner/role.json", content: ROLE_JSON(), executable: false },
      ],
    });
  });
});

describe("a session's skills from honed", () => {
  it("are read with honed's token, at their current version, in order, with no global", async () => {
    const seen: string[] = [];
    const read = await new HonedContext(service, new FakeStore(), honed({ "agent-roles/planner": PLANNER, "agent-roles/implementer": IMPLEMENTER }, seen)).forSession([
      "agent-roles/implementer",
      "agent-roles/planner",
    ]);
    expect(read).toEqual({ skills: [laid(IMPLEMENTER), laid(PLANNER)], note: null });
    expect(seen.sort()).toEqual(["/api/skills/agent-roles/implementer Bearer h", "/api/skills/agent-roles/planner Bearer h"]);
  });

  it("come from the last good copy when honed is down, and the note says so", async () => {
    const copies = new FakeStore();
    await new HonedContext(service, copies, honed({ "agent-roles/planner": PLANNER })).forSession(["agent-roles/planner"]);
    const read = await new HonedContext(service, copies, down).forSession(["agent-roles/planner"]);
    expect(read).toEqual({
      skills: [laid(PLANNER)],
      note: "honed could not be read for agent-roles/planner: connect ECONNREFUSED, so agent-roles/planner is its last good copy, v2",
    });
  });

  it("leave out, saying why, one honed does not have, and one it cannot be asked about with no copy kept", async () => {
    expect(await new HonedContext(service, new FakeStore(), honed({})).forSession(["team/gone"])).toEqual({ skills: [], note: "honed has no skill named team/gone" });
    expect((await new HonedContext(service, new FakeStore(), down).forSession(["team/x"])).note).toBe(
      "honed could not be read for team/x: connect ECONNREFUSED, and no copy of team/x is kept",
    );
    expect((await new HonedContext({ url: "https://honed", token: token(null) }, new FakeStore(), down).forSession(["team/x"])).note).toBe(
      "honed's token could not be read, and no copy of team/x is kept",
    );
  });

  it("refuse at creation a skill honed does not have, and let through one it cannot be asked about only when a copy is kept", async () => {
    const copies = new FakeStore();
    expect(await new HonedContext(service, copies, honed({ "agent-roles/planner": PLANNER })).refuse(["agent-roles/planner"])).toBeNull();
    expect(await new HonedContext(service, copies, honed({})).refuse(["team/nope"])).toBe("honed has no skill named team/nope");
    const offline = new HonedContext(service, copies, down);
    expect(await offline.refuse(["agent-roles/planner"])).toMatch(/no copy of agent-roles\/planner is kept/);
    await new HonedContext(service, copies, honed({ "agent-roles/planner": PLANNER })).forSession(["agent-roles/planner"]);
    expect(await offline.refuse(["agent-roles/planner"])).toBeNull();
  });
});

describe("roles from honed", () => {
  it("are each skill in agent-roles/, its role.json its settings, its own skill first, highest priority first", async () => {
    const team = skill("team/git-commits", 3, [{ path: "SKILL.md", content: "Commit." }]);
    const roles = await new HonedRoles(service, new FakeStore(), honed({ "agent-roles/implementer": IMPLEMENTER, "agent-roles/planner": PLANNER, "team/git-commits": team })).list();
    expect(roles).toEqual([
      { name: "planner", skills: ["agent-roles/planner"], credentials: null, whenDone: "stop", label: "plan: new work", description: "Plans.", priority: 40, brief: "Ask.", version: 2 },
      { name: "implementer", skills: ["agent-roles/implementer", "team/git-commits"], credentials: null, whenDone: "stop", label: "ticket", description: null, priority: 10, brief: null, version: 1 },
    ]);
  });

  it("come from the last list read whole when honed is down, saying so", async () => {
    const copies = new FakeStore();
    const logged: string[] = [];
    await new HonedRoles(service, copies, honed({ "agent-roles/planner": PLANNER })).list();
    const roles = await new HonedRoles(service, copies, down, (line) => logged.push(line)).list();
    expect(roles.map((r) => r.name)).toEqual(["planner"]);
    expect(logged).toEqual(["roles could not be read from honed (connect ECONNREFUSED); using the last good list"]);
    expect(await new HonedRoles(service, new FakeStore(), down, () => {}).list()).toEqual([]);
  });

  it("leave out, saying why, a skill in the group that is not a role", async () => {
    const logged: string[] = [];
    const broken = skill("agent-roles/broken", 1, [{ path: "SKILL.md", content: "?" }, { path: "role.json", content: ROLE_JSON({ whenDone: "never" }) }]);
    const bare = skill("agent-roles/bare", 1, [{ path: "SKILL.md", content: "?" }]);
    const roles = await new HonedRoles(service, new FakeStore(), honed({ "agent-roles/planner": PLANNER, "agent-roles/broken": broken, "agent-roles/bare": bare }), (l) => logged.push(l)).list();
    expect(roles.map((r) => r.name)).toEqual(["planner"]);
    expect(logged.sort()).toEqual(["agent-roles/bare has no role.json", expect.stringMatching(/^agent-roles\/broken's role\.json: whenDone: /)]);
    expect(roleOf(skill("agent-roles/x", 1, [{ path: "role.json", content: "{" }]))).toMatch(/is not JSON/);
  });
});
