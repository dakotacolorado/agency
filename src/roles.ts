import { z } from "zod";
import { WHEN_DONE, type WhenDone } from "./domain.ts";

/** The honed group whose skills are the roles. */
export const ROLE_GROUP = "agent-roles";

/** `agent-roles/planner` for the role `planner`. */
export const roleSkill = (name: string) => `${ROLE_GROUP}/${name}`;

/**
 * What a kind of agent is started with: a caller names the role and says
 * what is particular to this one (its brief, its item), and the role gives
 * the rest. Its priority orders admission: higher starts first. Each is a
 * honed skill, `agent-roles/<name>`: its `SKILL.md` is what the agent is
 * told, and its `role.json` these settings.
 */
export interface Role {
  name: string;
  /** The honed skills each session is given: its own, first. */
  skills: string[];
  /** The services each session is given, by name; null for every one the stage has. */
  credentials: string[] | null;
  whenDone: WhenDone;
  label: string;
  /** What it is for and who starts it: markdown; null for none. */
  description: string | null;
  priority: number;
  /** The first message when the caller gives none; null when a caller must. */
  brief: string | null;
  /** The honed version it was read at. */
  version: number;
}

/** A role skill's `role.json`. */
export const RoleSettingsSchema = z.object({
  label: z.string().min(1).max(40),
  priority: z.number().int().min(0).max(100),
  whenDone: z.enum(WHEN_DONE),
  services: z.array(z.string().min(1)).nullable().default(null),
  brief: z.string().min(1).nullable().default(null),
  summary: z.string().nullable().default(null),
  /** Other honed skills each session is given beside the role's own. */
  skills: z.array(z.string().min(1)).default([]),
});

/** A role as honed has it, from its skill's files; or why it is not one. */
export function roleOf(skill: { name: string; version: number; files?: { path: string; content: string }[] }): Role | string {
  const name = skill.name.slice(ROLE_GROUP.length + 1);
  const file = skill.files?.find((f) => f.path === "role.json");
  if (!file) return `${skill.name} has no role.json`;
  let parsed: unknown;
  try {
    parsed = JSON.parse(file.content);
  } catch (err) {
    return `${skill.name}'s role.json is not JSON: ${(err as Error).message}`;
  }
  const settings = RoleSettingsSchema.safeParse(parsed);
  if (!settings.success) return `${skill.name}'s role.json: ${settings.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`;
  const { label, priority, whenDone, services, brief, summary, skills } = settings.data;
  return { name, skills: [skill.name, ...skills], credentials: services, whenDone, label, description: summary, priority, brief, version: skill.version };
}

/** Highest priority first, then by name. */
export const byPriority = (roles: Role[]) => [...roles].sort((a, b) => b.priority - a.priority || a.name.localeCompare(b.name));

export interface RoleSource {
  /** Every role, highest priority first. */
  list(): Promise<Role[]>;
}

/** No roles: a stage without honed. */
export const NO_ROLES: RoleSource = { list: async () => [] };

/** Fixed roles, for tests. */
export const fixedRoles = (roles: Role[]): RoleSource => ({ list: async () => byPriority(roles) });

export interface Service {
  url: string;
  token: { value(): Promise<string | null> };
}

/** Where the last list read whole is kept. */
export interface Copies {
  keepCopy(name: string, version: number, copy: unknown): Promise<void>;
  copyOf<T>(name: string): Promise<T | null>;
}

/** The copy's key: no skill can be named with two slashes. */
const COPY = "agent-roles//list";

/**
 * The roles in honed's `agent-roles/` group, read at each call, so a role
 * changed in honed is used at the next start. A list read whole is kept;
 * when honed does not answer, the last one is used. A skill in the group
 * that is not a role is left out, and logged.
 */
export class HonedRoles implements RoleSource {
  readonly #honed: Service;
  readonly #copies: Copies;
  readonly #fetch: typeof globalThis.fetch;
  readonly #log: (line: string) => void;

  constructor(honed: Service, copies: Copies, fetchImpl: typeof globalThis.fetch = globalThis.fetch, log: (line: string) => void = console.error) {
    this.#honed = honed;
    this.#copies = copies;
    this.#fetch = fetchImpl;
    this.#log = log;
  }

  async list(): Promise<Role[]> {
    try {
      const roles = await this.#read();
      await this.#copies.keepCopy(COPY, 0, roles);
      return roles;
    } catch (err) {
      const kept = await this.#copies.copyOf<Role[]>(COPY);
      this.#log(`roles could not be read from honed (${(err as Error).message}); ${kept ? "using the last good list" : "none are kept"}`);
      return kept ?? [];
    }
  }

  async #get(path: string): Promise<unknown> {
    const token = await this.#honed.token.value();
    if (!token) throw new Error("honed's token could not be read");
    const res = await this.#fetch(`${this.#honed.url.replace(/\/$/, "")}${path}`, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) throw new Error(`honed answered ${res.status} for ${path}`);
    return res.json();
  }

  async #read(): Promise<Role[]> {
    const listed = (await this.#get("/api/skills")) as { name: string }[] | { skills: { name: string }[] };
    const names = (Array.isArray(listed) ? listed : listed.skills).map((s) => s.name).filter((name) => name.startsWith(`${ROLE_GROUP}/`));
    const roles: Role[] = [];
    for (const name of names) {
      const role = roleOf((await this.#get(`/api/skills/${name}`)) as { name: string; version: number; files: { path: string; content: string }[] });
      if (typeof role === "string") this.#log(role);
      else roles.push(role);
    }
    return byPriority(roles);
  }
}
