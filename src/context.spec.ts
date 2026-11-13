import { describe, expect, it } from "vitest";
import { body, CONTEXT_LIMIT, FETCH_LIMIT, HonedContext, laid, type SessionContext } from "./context.ts";
import { FakeStore } from "./fake-store.ts";

const token = (value: string | null) => ({ value: async () => value });

type File = { path: string; content: string; executable?: boolean };
const skill = (name: string, version: number, files: File[]) => ({ name, version, createdAt: "t", maxChars: null, files, versions: [], feedback: [] });

const GLOBAL = skill("workplace/global", 3, [
  { path: "SKILL.md", content: "---\nname: global\ndescription: Facts.\n---\n\n# Working here\n\nShip through the release service." },
]);
const GLOBAL_LAID: SessionContext = {
  key: "workplace/global",
  version: 3,
  files: [{ path: "CLAUDE.md", content: "# Working here\n\nShip through the release service.", executable: false }],
};

/** A honed answering for `skills` by name, 404 for any other; `seen` records each name asked for and its token. */
const honed = (skills: Record<string, unknown>, seen: string[] = []): typeof globalThis.fetch =>
  (async (url: string | URL | Request, init?: RequestInit) => {
    const name = String(url).split("/api/skills/")[1]!.split("/").map(decodeURIComponent).join("/");
    seen.push(`${name} ${new Headers(init?.headers).get("authorization")}`);
    const found = skills[name];
    return new Response(JSON.stringify(found ?? { error: `No skill is named ${name}.` }), { status: found ? 200 : 404 });
  }) as typeof globalThis.fetch;

const down = (async () => {
  throw new Error("connect ECONNREFUSED");
}) as typeof globalThis.fetch;

const source = (skills: Record<string, unknown>, seen?: string[], copies = new FakeStore()) =>
  new HonedContext({ url: "https://honed/", token: token("h") }, copies, honed(skills, seen));

describe("a honed skill as a session is given it", () => {
  it("takes workplace/global's SKILL.md, without its front matter, as CLAUDE.md, and its other files under skills/global/", () => {
    const withMore = skill("workplace/global", 3, [...GLOBAL.files, { path: "bin/check", content: "echo", executable: true }]);
    expect(laid(withMore).files).toEqual([...GLOBAL_LAID.files, { path: "skills/global/bin/check", content: "echo", executable: true }]);
    expect(body("No front matter.")).toBe("No front matter.");
  });

  it("lays any other skill whole as a Claude Code skill, under its name's last segment", () => {
    const planner = skill("workplace/planner", 2, [{ path: "SKILL.md", content: "---\nname: planner\n---\nPlan." }, { path: "reference/tracker.md", content: "Items." }]);
    expect(laid(planner)).toEqual({
      key: "workplace/planner",
      version: 2,
      files: [
        { path: "skills/planner/SKILL.md", content: "---\nname: planner\n---\nPlan.", executable: false },
        { path: "skills/planner/reference/tracker.md", content: "Items.", executable: false },
      ],
    });
  });
});

describe("a session's context from honed", () => {
  it("reads workplace/global and each skill the agent names, with honed's token, at its current version, in order", async () => {
    const seen: string[] = [];
    const planner = skill("workplace/planner", 7, [{ path: "SKILL.md", content: "Plan." }]);
    const read = await source({ "workplace/global": GLOBAL, "workplace/planner": planner }, seen).forSession(["workplace/planner"]);
    expect(read).toEqual({
      context: GLOBAL_LAID,
      documents: [laid(planner)],
      skills: [],
      note: null,
    });
    expect(seen.sort()).toEqual(["workplace/global Bearer h", "workplace/planner Bearer h"]);
  });

  it("asks for a prefixed name with its slash unescaped, as honed's route takes it", async () => {
    const urls: string[] = [];
    const fetchImpl = (async (url: string | URL | Request) => {
      urls.push(String(url));
      return new Response(JSON.stringify(GLOBAL));
    }) as typeof globalThis.fetch;
    await new HonedContext({ url: "https://honed:8443/", token: token("h") }, new FakeStore(), fetchImpl).forSession([]);
    expect(urls).toEqual(["https://honed:8443/api/skills/workplace/global"]);
  });

  it("with honed down, starts from the last good copy of each skill, and its context note says so", async () => {
    const copies = new FakeStore();
    const planner = skill("workplace/planner", 7, [{ path: "SKILL.md", content: "Plan." }]);
    await source({ "workplace/global": GLOBAL, "workplace/planner": planner }, undefined, copies).forSession(["workplace/planner"]);
    const offline = new HonedContext({ url: "https://honed", token: token("h") }, copies, down);
    const read = await offline.forSession(["workplace/planner"]);
    expect(read.context).toEqual(GLOBAL_LAID);
    expect(read.documents).toEqual([laid(planner)]);
    expect(read.note).toBe(
      "honed could not be read for workplace/global: connect ECONNREFUSED, so workplace/global is its last good copy, v3; " +
        "honed could not be read for workplace/planner: connect ECONNREFUSED, so workplace/planner is its last good copy, v7",
    );
  });

  it("keeps a newer version as the copy once honed answers again", async () => {
    const copies = new FakeStore();
    await source({ "workplace/global": GLOBAL }, undefined, copies).forSession([]);
    await source({ "workplace/global": { ...GLOBAL, version: 4 } }, undefined, copies).forSession([]);
    const read = await new HonedContext({ url: "https://honed", token: token("h") }, copies, down).forSession([]);
    expect(read.context?.version).toBe(4);
  });

  it("starts without context, saying why, when honed is down and no copy is kept, or global is too large", async () => {
    expect(await new HonedContext({ url: "https://honed", token: token("h") }, new FakeStore(), down).forSession([])).toEqual({
      context: null,
      documents: [],
      skills: [],
      note: "honed could not be read for workplace/global: connect ECONNREFUSED, and no copy of workplace/global is kept",
    });
    expect((await new HonedContext({ url: "https://honed", token: token(null) }, new FakeStore(), down).forSession([])).note).toBe(
      "honed's token could not be read, and no copy of workplace/global is kept",
    );
    const huge = skill("workplace/global", 3, [{ path: "SKILL.md", content: "x".repeat(CONTEXT_LIMIT) }]);
    expect((await source({ "workplace/global": huge }).forSession([])).note).toMatch(/^workplace\/global v3 is \d+ bytes, over the/);
  });

  it("gives no copy of a skill honed says it does not have", async () => {
    const copies = new FakeStore();
    const gone = skill("workplace/gone", 1, [{ path: "SKILL.md", content: "Old." }]);
    await source({ "workplace/global": GLOBAL, "workplace/gone": gone }, undefined, copies).forSession(["workplace/gone"]);
    const read = await source({ "workplace/global": GLOBAL }, undefined, copies).forSession(["workplace/gone"]);
    expect(read.documents).toEqual([]);
    expect(read.note).toBe("honed has no skill named workplace/gone");
  });

  it("gives none beside global without global, since its host then keeps what it wrote last", async () => {
    const planner = skill("workplace/planner", 7, [{ path: "SKILL.md", content: "Plan." }]);
    expect(await source({ "workplace/planner": planner }).forSession(["workplace/planner"])).toMatchObject({
      context: null,
      documents: [],
      note: "honed has no skill named workplace/global",
    });
  });

  it("leaves out one past the limit and one writing a file before it, saying so", async () => {
    const big = skill("workplace/big", 1, [{ path: "SKILL.md", content: "x".repeat(CONTEXT_LIMIT) }]);
    const first = skill("team/review", 1, [{ path: "SKILL.md", content: "Review." }]);
    const clash = skill("workplace/review", 2, [{ path: "SKILL.md", content: "Mine." }]);
    const read = await source({ "workplace/global": GLOBAL, "workplace/big": big, "team/review": first, "workplace/review": clash }).forSession([
      "workplace/big",
      "team/review",
      "workplace/review",
    ]);
    expect(read.documents.map((d) => d.key)).toEqual(["team/review"]);
    expect(read.note).toMatch(/^workplace\/big v1 is \d+ bytes, over the \d+ left of the \d+ a start can carry; workplace\/review v2 writes skills\/review\/SKILL.md, as a skill before it does$/);
  });

  it("refuses at creation a skill honed does not have, and lets through one it cannot be asked about only when a copy is kept", async () => {
    const copies = new FakeStore();
    const planner = skill("workplace/planner", 7, [{ path: "SKILL.md", content: "Plan." }]);
    expect(await source({ "workplace/planner": planner }, undefined, copies).refuse(["workplace/planner"])).toBeNull();
    expect(await source({}).refuse(["workplace/nope"])).toBe("honed has no skill named workplace/nope");
    expect(await source({}).refuse([])).toBeNull();
    const offline = new HonedContext({ url: "https://honed", token: token("h") }, copies, down);
    expect(await offline.refuse(["workplace/planner"])).toMatch(/no copy of workplace\/planner is kept/);
    await source({ "workplace/global": GLOBAL, "workplace/planner": planner }, undefined, copies).forSession(["workplace/planner"]);
    expect(await offline.refuse(["workplace/planner"])).toBeNull();
  });
});

describe("services' skills laid over global", () => {
  const WT = {
    key: "waypoint",
    version: 53,
    commit: "abc",
    files: [
      { path: "skills/x/bin/run", content: "echo deployed", executable: true },
      { path: "skills/x/reference/api.md", content: "# API", executable: false },
    ],
  };
  const GLOBAL_WITH_X = skill("workplace/global", 3, [...GLOBAL.files, { path: "bin/run", content: "echo", executable: true }]);

  it("adds each client's files, and records the skill", async () => {
    const read = await source({ "workplace/global": GLOBAL }).forSession([], [WT]);
    expect(read.context!.files).toEqual([...GLOBAL_LAID.files, ...WT.files]);
    expect(read).toMatchObject({ context: { key: "workplace/global", version: 3 }, skills: [{ key: "waypoint", version: 53, commit: "abc" }], note: null });
  });

  it("keeps global's copy, saying why, when a skill's client would take the start past its limit", async () => {
    const huge = { ...WT, files: [{ path: "skills/x/bin/run", content: "x".repeat(CONTEXT_LIMIT), executable: true }] };
    const read = await source({ "workplace/global": GLOBAL_WITH_X }).forSession([], [huge]);
    expect(read.context!.files.map((f) => f.path)).toEqual(["CLAUDE.md", "skills/global/bin/run"]);
    expect(read.skills).toEqual([]);
    expect(read.note).toMatch(/^the waypoint skill v53 would take workplace\/global to \d+ bytes/);
  });

  it("lays every client before any reference, and leaves out a reference past the limit, keeping its client", async () => {
    const big = { ...WT, files: [WT.files[0]!, { path: "skills/x/reference/api.md", content: "x".repeat(CONTEXT_LIMIT - 2000), executable: false }] };
    const approval = {
      key: "approval",
      version: 15,
      commit: "def",
      files: [
        { path: "skills/approval/bin/approval", content: "submit", executable: true },
        { path: "skills/approval/reference/api.md", content: "x".repeat(3000), executable: false },
      ],
    };
    const read = await source({ "workplace/global": GLOBAL }).forSession([], [big, approval]);
    expect(read.context!.files.map((f) => f.path)).toEqual(["CLAUDE.md", "skills/x/bin/run", "skills/approval/bin/approval", "skills/x/reference/api.md"]);
    expect(read.skills.map((s) => s.key)).toEqual(["waypoint", "approval"]);
    expect(read.note).toMatch(/^the approval skill's reference\/ would take workplace\/global to \d+ bytes, over the \d+ left for it, so only its bin\/ was laid$/);
  });

  it("says it cut for size, and lays everything within a larger limit", async () => {
    const big = { ...WT, files: [WT.files[0]!, { path: "skills/x/reference/api.md", content: "x".repeat(CONTEXT_LIMIT), executable: false }] };
    const role = skill("workplace/role", 1, [{ path: "SKILL.md", content: "Review." }]);
    const skills = { "workplace/global": GLOBAL, "workplace/role": role };
    expect(await source(skills).forSession(["workplace/role"], [big])).toMatchObject({ cut: true });
    const whole = await source(skills).forSession(["workplace/role"], [big], FETCH_LIMIT);
    expect(whole.context!.files).toEqual([...GLOBAL_LAID.files, ...big.files]);
    expect(whole.documents.map((d) => d.key)).toEqual(["workplace/role"]);
    expect(whole).toMatchObject({ note: null });
    expect(whole).not.toHaveProperty("cut");
    const gone = await source(skills).forSession(["workplace/role", "workplace/gone"], [WT]);
    expect(gone.note).toBe("honed has no skill named workplace/gone");
    expect(gone).not.toHaveProperty("cut");
  });

  it("gives a skill beside global room before any service's reference", async () => {
    const big = { ...WT, files: [WT.files[0]!, { path: "skills/x/reference/api.md", content: "x".repeat(CONTEXT_LIMIT / 2), executable: false }] };
    const role = skill("workplace/role", 1, [{ path: "SKILL.md", content: "x".repeat(CONTEXT_LIMIT / 2) }]);
    const read = await source({ "workplace/global": GLOBAL, "workplace/role": role }).forSession(["workplace/role"], [big]);
    expect(read.documents.map((d) => d.key)).toEqual(["workplace/role"]);
    expect(read.context!.files.map((f) => f.path)).toEqual(["CLAUDE.md", "skills/x/bin/run"]);
    expect(read.note).toMatch(/^the waypoint skill's reference\/ would take workplace\/global/);
  });

  it("leaves out a skill that writes a service's file", async () => {
    const x = skill("team/x", 1, [{ path: "reference/api.md", content: "mine" }]);
    const read = await source({ "workplace/global": GLOBAL, "team/x": x }).forSession(["team/x"], [WT]);
    expect(read.documents).toEqual([]);
    expect(read.note).toBe("team/x v1 writes skills/x/reference/api.md, as a skill before it does");
  });
});
