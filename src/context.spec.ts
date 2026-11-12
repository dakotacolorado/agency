import { describe, expect, it } from "vitest";
import { CONTEXT_LIMIT, FETCH_LIMIT, ServiceContext } from "./context.ts";

const token = (value: string | null) => ({ value: async () => value });
const serving = (status: number, body: unknown, seen: string[] = []): typeof globalThis.fetch =>
  (async (url: string | URL | Request, init?: RequestInit) => {
    seen.push(`${url} ${new Headers(init?.headers).get("authorization")}`);
    return new Response(JSON.stringify(body), { status });
  }) as typeof globalThis.fetch;

const GLOBAL = { key: "global", version: 3, files: [{ path: "skills/x/bin/run", content: "echo", executable: true }], title: "Global" };

describe("a session's context from document-service", () => {
  it("reads global with its token", async () => {
    const seen: string[] = [];
    const source = new ServiceContext({ url: "https://ds/", token: token("d") }, serving(200, GLOBAL, seen));
    expect(await source.forSession([])).toEqual({
      context: { key: "global", version: 3, files: GLOBAL.files },
      documents: [],
      skills: [],
      note: null,
    });
    expect(seen).toEqual(["https://ds/documents/global Bearer d"]);
  });

  it("starts without it, saying why, when it is missing, unreachable, too large or its token unreadable", async () => {
    const ds = (fetch: typeof globalThis.fetch, value: string | null = "d") => new ServiceContext({ url: "https://ds", token: token(value) }, fetch);
    expect(await ds(serving(404, { error: "no document global" })).forSession([])).toMatchObject({
      context: null,
      note: "document-service answered 404 for global",
    });
    const down = (async () => {
      throw new Error("timed out");
    }) as typeof globalThis.fetch;
    expect((await ds(down).forSession([])).note).toBe("document-service could not be read for global: timed out");
    const huge = { ...GLOBAL, files: [{ path: "big", content: "x".repeat(CONTEXT_LIMIT), executable: false }] };
    expect((await ds(serving(200, huge)).forSession([])).note).toMatch(/^global v3 is \d+ bytes, over the/);
    expect(await ds(serving(200, GLOBAL), null).forSession([])).toEqual({ context: null, documents: [], skills: [], note: "document-service's token could not be read" });
  });
});

describe("documents beside global", () => {
  const doc = (key: string, version: number, files: { path: string; content: string; executable?: boolean }[]) => ({ key, version, files });
  const APPROVAL = doc("approval", 2, [{ path: "CLAUDE.md", content: "Approve." }, { path: "skills/approve/SKILL.md", content: "How." }]);
  const serve = (docs: Record<string, unknown>, seen: string[] = []): typeof globalThis.fetch =>
    (async (url: string | URL | Request) => {
      const key = decodeURIComponent(String(url).split("/documents/")[1]!);
      seen.push(key);
      const found = docs[key];
      return new Response(JSON.stringify(found ?? { error: `no document ${key}` }), { status: found ? 200 : 404 });
    }) as typeof globalThis.fetch;
  const source = (docs: Record<string, unknown>, seen?: string[]) => new ServiceContext({ url: "https://ds", token: token("d") }, serve(docs, seen));

  it("reads each after global, at its latest version, in order", async () => {
    const seen: string[] = [];
    const attached = await source({ global: GLOBAL, approval: APPROVAL, "role.reviewer": doc("role.reviewer", 1, []) }, seen).forSession(["approval", "role.reviewer"]);
    expect(attached.context?.key).toBe("global");
    expect(attached.documents.map((d) => `${d.key} v${d.version}`)).toEqual(["approval v2", "role.reviewer v1"]);
    expect(attached.documents[0]!.files).toEqual(APPROVAL.files.map((f) => ({ ...f, executable: false })));
    expect(attached.note).toBeNull();
    expect(seen.sort()).toEqual(["approval", "global", "role.reviewer"]);
  });

  it("leaves out one it cannot read, one past the limit and one writing a file before it, saying so", async () => {
    const big = doc("big", 1, [{ path: "skills/big/SKILL.md", content: "x".repeat(CONTEXT_LIMIT) }]);
    const clash = doc("clash", 1, [{ path: "skills/x/bin/run", content: "mine" }]);
    const attached = await source({ global: GLOBAL, approval: APPROVAL, big, clash }).forSession(["gone", "big", "clash", "approval"]);
    expect(attached.documents.map((d) => d.key)).toEqual(["approval"]);
    expect(attached.note).toMatch(
      /^document-service answered 404 for gone; big v1 is \d+ bytes, over the \d+ left of the \d+ a start can carry; clash v1 writes skills\/x\/bin\/run, as a document before it does$/,
    );
  });

  it("gives none without global, since its host then keeps what it wrote last", async () => {
    expect(await source({ approval: APPROVAL }).forSession(["approval"])).toMatchObject({ context: null, documents: [], note: "document-service answered 404 for global" });
  });

  it("refuses at creation a key document-service does not know, in its words", async () => {
    expect(await source({ approval: APPROVAL }).refuse(["approval"])).toBeNull();
    expect(await source({ approval: APPROVAL }).refuse(["approval", "nope"])).toBe("document-service answered 404 for nope: no document nope");
    expect(await source({}).refuse([])).toBeNull();
    expect(await new ServiceContext({ url: "https://ds", token: token(null) }).refuse(["approval"])).toMatch(/token could not be read/);
  });
});

describe("services' skills laid over global", () => {
  const source = (docs: Record<string, unknown>) =>
    new ServiceContext({ url: "https://ds", token: token("d") }, (async (url: string | URL | Request) => {
      const key = decodeURIComponent(String(url).split("/documents/")[1]!);
      return docs[key] ? new Response(JSON.stringify(docs[key])) : new Response("{}", { status: 404 });
    }) as typeof globalThis.fetch);
  const WT = { key: "work-tracker", version: 53, commit: "abc", files: [{ path: "skills/x/bin/run", content: "echo deployed", executable: true }, { path: "skills/x/reference/api.md", content: "# API", executable: false }] };

  it("replaces global's file at each path a skill writes, adds the rest, and records the skill", async () => {
    const read = await source({ global: GLOBAL }).forSession([], [WT]);
    expect(read.context!.files).toEqual(WT.files);
    expect(read).toMatchObject({ context: { key: "global", version: 3 }, skills: [{ key: "work-tracker", version: 53, commit: "abc" }], note: null });
  });

  it("keeps global's copy, saying why, when a skill's client would take the start past its limit", async () => {
    const huge = { ...WT, files: [{ path: "skills/x/bin/run", content: "x".repeat(CONTEXT_LIMIT), executable: true }] };
    const read = await source({ global: GLOBAL }).forSession([], [huge]);
    expect(read.context!.files).toEqual(GLOBAL.files);
    expect(read.skills).toEqual([]);
    expect(read.note).toMatch(/^the work-tracker skill v53 would take global to \d+ bytes/);
  });

  it("lays every client before any reference, and leaves out a reference past the limit, keeping its client", async () => {
    const big = { ...WT, files: [WT.files[0]!, { path: "skills/x/reference/api.md", content: "x".repeat(CONTEXT_LIMIT - 2000), executable: false }] };
    const approval = { key: "approval", version: 15, commit: "def", files: [{ path: "skills/approval/bin/approval", content: "submit", executable: true }, { path: "skills/approval/reference/api.md", content: "x".repeat(3000), executable: false }] };
    const read = await source({ global: GLOBAL }).forSession([], [big, approval]);
    expect(read.context!.files.map((f) => f.path)).toEqual(["skills/x/bin/run", "skills/approval/bin/approval", "skills/x/reference/api.md"]);
    expect(read.skills.map((s) => s.key)).toEqual(["work-tracker", "approval"]);
    expect(read.note).toMatch(/^the approval skill's reference\/ would take global to \d+ bytes, over the \d+ left for it, so only its bin\/ was laid$/);
  });

  it("says it cut for size, and lays everything within a larger limit", async () => {
    const big = { ...WT, files: [WT.files[0]!, { path: "skills/x/reference/api.md", content: "x".repeat(CONTEXT_LIMIT), executable: false }] };
    const role = { key: "role", version: 1, files: [{ path: "CLAUDE.md", content: "Review." }] };
    expect(await source({ global: GLOBAL, role }).forSession(["role"], [big])).toMatchObject({ cut: true });
    const whole = await source({ global: GLOBAL, role }).forSession(["role"], [big], FETCH_LIMIT);
    expect(whole.context!.files).toEqual(big.files);
    expect(whole.documents.map((d) => d.key)).toEqual(["role"]);
    expect(whole).toMatchObject({ note: null });
    expect(whole).not.toHaveProperty("cut");
    const gone = await source({ global: GLOBAL, role }).forSession(["role", "gone"], [WT]);
    expect(gone.note).toBe("document-service answered 404 for gone");
    expect(gone).not.toHaveProperty("cut");
  });

  it("reads a proposal.global document in place of global, not beside it", async () => {
    const trial = { key: "proposal.global.efa8e499", version: 1, files: [{ path: "CLAUDE.md", content: "Proposed." }] };
    const role = { key: "role", version: 1, files: [{ path: "CLAUDE.md", content: "Review." }] };
    const read = await source({ global: GLOBAL, [trial.key]: trial, role }).forSession(["role", trial.key], [WT]);
    expect(read.context).toMatchObject({ key: "proposal.global.efa8e499", version: 1 });
    expect(read.context!.files.map((f) => f.content)).toContain("Proposed.");
    expect(read.documents.map((d) => d.key)).toEqual(["role"]);
    expect(read.note).toBeNull();
  });

  it("gives a document beside global room before any skill's reference", async () => {
    const big = { ...WT, files: [WT.files[0]!, { path: "skills/x/reference/api.md", content: "x".repeat(CONTEXT_LIMIT / 2), executable: false }] };
    const role = { key: "role", version: 1, files: [{ path: "CLAUDE.md", content: "x".repeat(CONTEXT_LIMIT / 2) }] };
    const read = await source({ global: GLOBAL, role }).forSession(["role"], [big]);
    expect(read.documents.map((d) => d.key)).toEqual(["role"]);
    expect(read.context!.files.map((f) => f.path)).toEqual(["skills/x/bin/run"]);
    expect(read.note).toMatch(/^the work-tracker skill's reference\/ would take global/);
  });

  it("leaves out a document that writes a skill's file, as one that writes global's", async () => {
    const doc = { key: "role", version: 1, files: [{ path: "skills/x/reference/api.md", content: "mine", executable: false }] };
    const read = await source({ global: GLOBAL, role: doc }).forSession(["role"], [WT]);
    expect(read.documents).toEqual([]);
    expect(read.note).toBe("role v1 writes skills/x/reference/api.md, as a document before it does");
  });
});
