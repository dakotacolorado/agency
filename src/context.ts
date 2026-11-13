import type { McpServer } from "./credentials.ts";
import type { Copies, Service } from "./roles.ts";

export interface ContextFile {
  path: string;
  content: string;
  executable: boolean;
}

/** A set of files at one version, written into a session's Claude Code folder, as its host takes them. */
export interface SessionContext {
  key: string;
  version: number;
  files: ContextFile[];
}

/** The honed skills a session was given, and why any it names was left out. */
export interface Read {
  skills: SessionContext[];
  note: string | null;
}

/**
 * What a session starts with: its clients, its honed skills, the environment
 * its scripts need, and why anything was left out.
 */
export interface Attached extends Read {
  /** agency's own clients, `page` and `title`, and the build they came from. */
  clients: SessionContext & { commit: string };
  /** The addresses of the services it is given; their tokens go only to its host, with `credentials`. */
  env: Record<string, string>;
  credentials: string[];
  /** The MCP servers of `credentials` that serve one. */
  mcpServers?: Record<string, McpServer>;
}

export interface ContextSource {
  /** `skills`, in order, each at its current version. */
  forSession(skills: string[]): Promise<Read>;
  /** Why an agent may not be given `skills`; null when it may. */
  refuse(skills: string[]): Promise<string | null>;
}

/** No honed: no skill can be given. */
export const NO_CONTEXT: ContextSource = {
  forSession: async (skills) => ({ skills: [], note: skills.length ? "no honed is configured, so no skill was given" : null }),
  refuse: async (skills) => (skills.length ? "no honed is configured, so no skill can be given" : null),
};

/** honed's `GET /api/skills/{name}`, as much of it as a start needs. */
export interface HonedSkill {
  name: string;
  version: number;
  files?: { path: string; content: string; executable?: boolean }[];
}

/** The last segment of a skill's name: `agent-roles/planner` is laid as `skills/planner/`. */
const folder = (name: string) => name.split("/").pop()!;

/** A honed skill laid whole as a Claude Code skill, `skills/<last segment>/`. */
export function laid(skill: HonedSkill): SessionContext {
  return {
    key: skill.name,
    version: skill.version,
    files: (skill.files ?? []).map(({ path, content, executable }) => ({ path: `skills/${folder(skill.name)}/${path}`, content, executable: Boolean(executable) })),
  };
}

/**
 * Reads each skill a session is given from honed. A skill read whole is
 * kept, so when honed does not answer a start is given the last copy,
 * saying so; one honed says it does not have is left out, saying so.
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

  async forSession(names: string[]): Promise<Read> {
    const read = await Promise.all(names.map((name) => this.read(name)));
    const notes: string[] = [];
    const skills: SessionContext[] = [];
    for (const r of read) {
      if (typeof r === "string") notes.push(r);
      else {
        skills.push(r.skill);
        if (r.note) notes.push(r.note);
      }
    }
    return { skills, note: notes.length ? notes.join("; ") : null };
  }

  /** A name honed does not have is refused; one it cannot be asked about is let through when a copy is kept. */
  async refuse(names: string[]): Promise<string | null> {
    for (const name of names) {
      const got = await this.fetch(name);
      if (got.kind === "skill") continue;
      if (got.kind === "missing") return got.why;
      if (!(await this.copies.copyOf(name))) return `${got.why}, and no copy of ${name} is kept, so it cannot be given`;
    }
    return null;
  }

  /** The skill as honed has it now, else its last copy with a note saying so, else why neither. */
  private async read(name: string): Promise<{ skill: SessionContext; note: string | null } | string> {
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
