import type { Skill } from "./skill.ts";
import { layReferences, overlay, type SkillRead } from "./skills.ts";

/** The honed skill every session starts with, as its `CLAUDE.md`. */
export const CONTEXT_KEY = "workplace/global";

/**
 * A start carries the context inside one socket message; this leaves the rest
 * of `MESSAGE_LIMIT` for the command around it and JSON's escaping.
 */
export const CONTEXT_LIMIT = 96 * 1024;

/**
 * A context its host reads over HTTP, when it is too large for the start.
 */
export const FETCH_LIMIT = 1024 * 1024;

export interface ContextFile {
  path: string;
  content: string;
  executable: boolean;
}

/** A document's files at one version, as a session is given them. */
export interface SessionContext {
  key: string;
  version: number;
  files: ContextFile[];
}

/**
 * What a session starts with: its context, the documents it was made with
 * beside it, the environment its scripts need, and why any of them was left
 * out, if one was.
 */
export interface Attached extends Read {
  /** The addresses of the services it is given; their tokens go only to its host, with `credentials`. */
  env: Record<string, string>;
  credentials: string[];
  /** Of `credentials`, those the agent has a token of its own for. */
  ownCredentials: string[];
}

/** What honed gave a session, and why it left out what it did. */
export interface Read {
  context: SessionContext | null;
  documents: SessionContext[];
  /** The services' skills laid over `context`'s files. */
  skills: SkillRead[];
  note: string | null;
  /** True when a document, a skill or a reference was left out for size. */
  cut?: true;
}

export interface ContextSource {
  /**
   * `documents` are read after `global`, in order; `skills` replace `global`'s files at their paths;
   * the whole is kept within `limit` bytes, `CONTEXT_LIMIT` unless said.
   */
  forSession(documents: string[], skills?: Skill[], limit?: number): Promise<Read>;
  /** Why an agent may not be made with `documents`, the honed skills it names; null when it may. */
  refuse(documents: string[]): Promise<string | null>;
}

/** Nothing attached: tests, the dev server, and a stage deployed without the services' addresses. */
export const NO_CONTEXT: ContextSource = {
  forSession: async () => ({ context: null, documents: [], skills: [], note: "no context is configured" }),
  refuse: async (documents) => (documents.length ? "no honed is configured, so no skill can be given" : null),
};

export interface Service {
  url: string;
  token: { value(): Promise<string | null> };
}

/** Where the last copy of each skill read whole is kept. */
export interface Copies {
  keepCopy(name: string, version: number, copy: SessionContext): Promise<void>;
  copyOf<T>(name: string): Promise<T | null>;
}

/** honed's `GET /api/skills/{name}`, as much of it as a start needs. */
export interface HonedSkill {
  name: string;
  version: number;
  files?: { path: string; content: string; executable?: boolean }[];
}

/** A `SKILL.md`'s text without its front matter, which says when to use a skill, not what to do. */
export const body = (skill: string) => skill.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "").replace(/^\s+/, "");

/** The last segment of a skill's name: `workplace/planner` is laid as `skills/planner/`. */
const folder = (name: string) => name.split("/").pop()!;

/**
 * A skill as a session is given it. `workplace/global`'s `SKILL.md` is its
 * `CLAUDE.md`, and any other file of it goes under `skills/global/`; every
 * other skill is laid whole as a Claude Code skill, `skills/<last segment>/`.
 */
export function laid(skill: HonedSkill): SessionContext {
  const files = (skill.files ?? []).map(({ path, content, executable }) => ({ path, content, executable: Boolean(executable) }));
  return {
    key: skill.name,
    version: skill.version,
    files:
      skill.name === CONTEXT_KEY
        ? files.map((f) => (f.path === "SKILL.md" ? { ...f, path: "CLAUDE.md", content: body(f.content), executable: false } : { ...f, path: `skills/${folder(skill.name)}/${f.path}` }))
        : files.map((f) => ({ ...f, path: `skills/${folder(skill.name)}/${f.path}` })),
  };
}

/**
 * Reads the context from honed: `workplace/global`, then each skill the agent
 * names. A skill read whole is kept, so when honed does not answer a start
 * is given the last copy, saying so; one honed says it does not have is left
 * out. A skill that would take the start past its limit, or would write a
 * file one before it writes, is left out too, and the session starts without it.
 */
export class HonedContext implements ContextSource {
  private readonly honed: Service;
  private readonly copies: Copies;
  private readonly fetchImpl: typeof globalThis.fetch;

  constructor(honed: Service, copies: Copies, fetchImpl: typeof globalThis.fetch = globalThis.fetch) {
    this.honed = honed;
    this.copies = copies;
    this.fetchImpl = fetchImpl;
  }

  async forSession(documents: string[], skills: Skill[] = [], limit = CONTEXT_LIMIT): Promise<Read> {
    const [read, given] = await Promise.all([this.read(CONTEXT_KEY), Promise.all(documents.map((key) => this.read(key)))]);
    const notes: string[] = [];
    const note = (r: Fetched) => {
      if (typeof r !== "string" && r.note) notes.push(r.note);
    };
    // A start without global keeps the context its host wrote last, so it is given nothing beside it.
    if (typeof read === "string") return { context: null, documents: [], skills: [], note: read };
    note(read);
    const global = read.skill;
    if (Buffer.byteLength(JSON.stringify(global)) > limit) {
      const bytes = Buffer.byteLength(JSON.stringify(global));
      return { context: null, documents: [], skills: [], note: [...notes, `${CONTEXT_KEY} v${global.version} is ${bytes} bytes, over the ${limit} a start can carry`].join("; "), cut: true };
    }
    // Clients first, then the skills beside global, then references with what room is left:
    // an agent can call a service without its reference, but not without its client or its role.
    const overlaid = overlay(global, skills, limit);
    notes.push(...overlaid.notes);
    let cut = overlaid.notes.length > 0;
    const taken: SessionContext[] = [];
    const paths = new Set([...overlaid.context.files, ...overlaid.references.flatMap((s) => s.files)].map((f) => f.path));
    let left = limit - Buffer.byteLength(JSON.stringify(overlaid.context));
    for (const r of given) {
      if (typeof r === "string") {
        notes.push(r);
        continue;
      }
      note(r);
      const doc = r.skill;
      const bytes = Buffer.byteLength(JSON.stringify(doc));
      const clash = doc.files.find((f) => f.path !== "CLAUDE.md" && paths.has(f.path));
      if (bytes > left) {
        notes.push(`${doc.key} v${doc.version} is ${bytes} bytes, over the ${left} left of the ${limit} a start can carry`);
        cut = true;
      } else if (clash) {
        notes.push(`${doc.key} v${doc.version} writes ${clash.path}, as a skill before it does`);
      } else {
        taken.push(doc);
        left -= bytes;
        for (const f of doc.files) paths.add(f.path);
      }
    }
    const { context, notes: dropped } = layReferences(overlaid.context, overlaid.references, limit - taken.reduce((n, doc) => n + Buffer.byteLength(JSON.stringify(doc)), 0));
    notes.push(...dropped);
    if (dropped.length) cut = true;
    return { context, documents: taken, skills: overlaid.taken, note: notes.length ? notes.join("; ") : null, ...(cut && { cut: true as const }) };
  }

  /** A name honed does not have is refused; one it cannot be asked about is let through when a copy is kept. */
  async refuse(documents: string[]): Promise<string | null> {
    for (const name of documents) {
      const got = await this.fetch(name);
      if (got.kind === "skill") continue;
      if (got.kind === "missing") return got.why;
      if (!(await this.copies.copyOf(name))) return `${got.why}, and no copy of ${name} is kept, so it cannot be given`;
    }
    return null;
  }

  /** The skill as honed has it now, else its last copy with a note saying so, else why neither. */
  private async read(name: string): Promise<Fetched> {
    const got = await this.fetch(name);
    if (got.kind === "skill") {
      const skill = laid(got.skill);
      await this.copies.keepCopy(name, skill.version, skill);
      return { skill, note: null };
    }
    if (got.kind === "missing") return got.why;
    const copy = await this.copies.copyOf<SessionContext>(name);
    if (!copy) return `${got.why}, and no copy of ${name} is kept`;
    return { skill: copy, note: `${got.why}, so ${name} is its last good copy, v${copy.version}` };
  }

  private async fetch(name: string): Promise<{ kind: "skill"; skill: HonedSkill } | { kind: "missing" | "down"; why: string }> {
    let token: string | null;
    try {
      token = await this.honed.token.value();
    } catch {
      token = null;
    }
    if (!token) return { kind: "down", why: "honed's token could not be read" };
    try {
      const res = await this.fetchImpl(`${this.honed.url.replace(/\/$/, "")}/api/skills/${name.split("/").map(encodeURIComponent).join("/")}`, {
        headers: { authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(5000),
      });
      if (res.status === 404) return { kind: "missing", why: `honed has no skill named ${name}` };
      if (!res.ok) return { kind: "down", why: `honed answered ${res.status} for ${name}` };
      const skill = (await res.json()) as Partial<HonedSkill>;
      if (typeof skill.name !== "string" || !Number.isInteger(skill.version)) return { kind: "down", why: `honed's answer for ${name} is not a skill` };
      return { kind: "skill", skill: skill as HonedSkill };
    } catch (err) {
      return { kind: "down", why: `honed could not be read for ${name}: ${(err as Error).message}` };
    }
  }
}

type Fetched = { skill: SessionContext; note: string | null } | string;
