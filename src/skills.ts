import type { ContextFile, SessionContext } from "./context.ts";
import type { Credential } from "./credentials.ts";
import { SKILL_KEY, type Skill } from "./skill.ts";

/** A skill as a session records it. */
export interface SkillRead {
  key: string;
  version: number;
  commit: string;
}

/**
 * Only a client and its reference: a `SKILL.md` or `CLAUDE.md` is guidance,
 * which reaches an agent through honed. This service's own `page` and `title`
 * say when to use them, as no honed skill does, so its `SKILL.md`s are laid too.
 */
const CLIENT = /^skills\/[a-z0-9][a-z0-9-]*\/(bin|reference)(\/[A-Za-z0-9._-]+)+$/;
const OWN_GUIDANCE = /^skills\/[a-z0-9][a-z0-9-]*\/SKILL\.md$/;
const safe = (path: string) => !path.split("/").some((part) => part === "." || part === "..");
const client = (path: string, own: boolean) => (CLIENT.test(path) || (own && OWN_GUIDANCE.test(path))) && safe(path);

export interface SkillSource {
  /** The skills of the services `names`, in order, and why any was left out. */
  forSession(names: string[]): Promise<{ skills: Skill[]; notes: string[] }>;
}

export const NO_SKILLS: SkillSource = { forSession: async () => ({ skills: [], notes: [] }) };

/**
 * Reads each service's `GET /skill` at the address and with the token this
 * stage has for it, so an agent's client is the one deployed where its tokens
 * reach. This service's own is read in-process.
 */
export class ServiceSkills implements SkillSource {
  private readonly known: Record<string, Credential>;
  private readonly own: () => Skill;
  private readonly fetchImpl: typeof globalThis.fetch;

  constructor(known: Record<string, Credential>, own: () => Skill, fetchImpl: typeof globalThis.fetch = globalThis.fetch) {
    this.known = known;
    this.own = own;
    this.fetchImpl = fetchImpl;
  }

  async forSession(names: string[]): Promise<{ skills: Skill[]; notes: string[] }> {
    const read = await Promise.all(names.map((name) => this.read(name)));
    const notes: string[] = [];
    const skills: Skill[] = [];
    for (const r of read) {
      if (typeof r === "string") notes.push(r);
      else if (r) {
        const own = r.key === SKILL_KEY;
        const dropped = r.files.filter((f) => !client(f.path, own));
        if (dropped.length) notes.push(`${r.key} skill sent ${dropped.map((f) => f.path).join(", ")}, which only honed may write`);
        skills.push({ ...r, files: r.files.filter((f) => client(f.path, own)) });
      }
    }
    return { skills, notes };
  }

  /** The skill, why it could not be read, or null for a service that has none to give. */
  private async read(name: string): Promise<Skill | string | null> {
    const known = this.known[name];
    if (!known) return null;
    if (known.url === null) return this.own();
    try {
      const token = await known.token.value();
      if (!token) return `${name}'s token could not be read, so its skill was not`;
      const res = await this.fetchImpl(`${known.url.replace(/\/$/, "")}/skill`, {
        headers: { authorization: `Bearer ${token}` },
        // Before global is read (5s), inside the function's 10s, so a slow service cannot time out the start.
        signal: AbortSignal.timeout(3000),
      });
      // A service with no client to give, as honed, answers 404.
      if (res.status === 404) return null;
      if (!res.ok) return `${name} answered ${res.status} for its skill`;
      const skill = (await res.json()) as Partial<Skill>;
      if (typeof skill.key !== "string" || !Number.isInteger(skill.version) || !Array.isArray(skill.files)) {
        return `${name}'s skill is not a skill`;
      }
      return {
        key: skill.key,
        version: skill.version!,
        commit: String(skill.commit ?? "unknown"),
        files: skill.files.map(({ path, content, executable }) => ({ path: String(path), content: String(content), executable: Boolean(executable) })),
      };
    } catch (err) {
      return `${name}'s skill could not be read: ${(err as Error).message}`;
    }
  }
}

/** A skill's `reference/`: read when a call fails, so the first thing a start drops for room. */
export const isReference = (path: string) => path.split("/")[2] === "reference";

/**
 * `global` with each skill's client (`bin/`) in place of its own at the same
 * paths: the deployed client wins over any copy a document holds. A skill
 * whose client would take it past `limit` bytes is left out, with a note.
 * References are not laid here but returned, for `layReferences` to add once
 * the documents beside `global` have taken their room.
 */
export function overlay(
  global: SessionContext,
  skills: Skill[],
  limit: number,
): { context: SessionContext; taken: SkillRead[]; references: Skill[]; notes: string[] } {
  let files: ContextFile[] = global.files;
  const taken: SkillRead[] = [];
  const references: Skill[] = [];
  const notes: string[] = [];
  for (const skill of skills) {
    const client = skill.files.filter((f) => !isReference(f.path));
    const paths = new Set(client.map((f) => f.path));
    const next = [...files.filter((f) => !paths.has(f.path)), ...client];
    const bytes = Buffer.byteLength(JSON.stringify({ ...global, files: next }));
    if (bytes > limit) {
      notes.push(`the ${skill.key} skill v${skill.version} would take ${global.key} to ${bytes} bytes, over the ${limit} a start can carry, so ${global.key}'s copy was kept`);
      continue;
    }
    files = next;
    taken.push({ key: skill.key, version: skill.version, commit: skill.commit });
    references.push({ ...skill, files: skill.files.filter((f) => isReference(f.path)) });
  }
  return { context: { ...global, files }, taken, references, notes };
}

/**
 * `context` with each skill's `reference/` laid over it, in order, while the
 * start stays within `room` bytes; one that does not fit is left out with a
 * note, and its client stays.
 */
export function layReferences(
  context: SessionContext,
  skills: Skill[],
  room: number,
): { context: SessionContext; notes: string[] } {
  let files = context.files;
  const notes: string[] = [];
  for (const skill of skills) {
    if (!skill.files.length) continue;
    const paths = new Set(skill.files.map((f) => f.path));
    const next = [...files.filter((f) => !paths.has(f.path)), ...skill.files];
    const bytes = Buffer.byteLength(JSON.stringify({ ...context, files: next }));
    if (bytes > room) {
      notes.push(`the ${skill.key} skill's reference/ would take ${context.key} to ${bytes} bytes, over the ${room} left for it, so only its bin/ was laid`);
      continue;
    }
    files = next;
  }
  return { context: { ...context, files }, notes };
}
