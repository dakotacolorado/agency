import { LABEL_LIMIT } from "./domain.ts";
import { nameFor } from "./admission.ts";
import type { Store } from "./store.ts";

/** Seconds between looks at waypoint's ready tasks, so one is taken within a minute of being ready. */
export const PICK_UP_SECONDS = 30;

/** The most tasks one look takes: a burst of ready tasks is taken over a few ticks, not all at once. */
export const PER_TICK = 5;

/** Who asks for each agent, as its request and its waypoint task record it. */
export const PICKER = "agency";

export interface Waypoint {
  url: string;
  token: { value(): Promise<string | null> };
}

interface Task {
  id: string;
  shortId?: string;
  title: string;
  assignee?: string | null;
}

/** Calls this service's own API in-process, as its token. */
export type Self = (method: string, path: string, body?: unknown) => Promise<{ status: number; body: any }>;

const shorten = (text: string, limit: number) => {
  const chars = [...text];
  return chars.length <= limit ? text : `${chars.slice(0, limit - 1).join("")}…`;
};

/** What an agent started on a waypoint task is told first. */
export const briefFor = (task: Task) =>
  `You are started on waypoint task ${task.shortId ?? task.id}, "${task.title}" (id ${task.id}), in this host's waypoint. ` +
  "Read it with waypoint's MCP server (get_task), with its subtasks, criteria and comments, and see it through: move its status " +
  "as the work moves, mark each criterion met once you have seen it hold, and say on it, as a comment, what you did. " +
  "This task is the only work you are here for. Use the page skill to say where you are before you end each turn.";

/**
 * Finds work for agents: waypoint has no queue, so each look reads its ready
 * tasks with no assignee, oldest first, and for each asks for an agent in
 * `role` through admission, so usage and hosts still decide when it starts.
 * A task is taken by setting its `assignee` to the agent's name; one already
 * asked for (by its `item`) is never asked for again, and one whose
 * assignee cannot be set is let go, its request withdrawn. Looks never
 * overlap, and one that fails is logged and the next tried.
 */
export class Pickup {
  readonly #waypoint: Waypoint;
  readonly #store: Store;
  readonly #self: Self;
  readonly #role: string;
  readonly #fetch: typeof globalThis.fetch;
  readonly #log: (line: string) => void;
  #looking = false;

  constructor(waypoint: Waypoint, store: Store, self: Self, role: string, fetchImpl: typeof globalThis.fetch = globalThis.fetch, log: (line: string) => void = console.log) {
    this.#waypoint = waypoint;
    this.#store = store;
    this.#self = self;
    this.#role = role;
    this.#fetch = fetchImpl;
    this.#log = log;
  }

  /** One look: the tasks it took, by id. */
  async tick(): Promise<string[]> {
    if (this.#looking) return [];
    this.#looking = true;
    try {
      return await this.#look();
    } catch (err) {
      this.#log(JSON.stringify({ pickUp: "failed", error: (err as Error).message }));
      return [];
    } finally {
      this.#looking = false;
    }
  }

  /** Looks every `PICK_UP_SECONDS` until the answer is called. */
  start(): () => void {
    const timer = setInterval(() => void this.tick(), PICK_UP_SECONDS * 1000);
    timer.unref();
    return () => clearInterval(timer);
  }

  async #waypointCall(method: string, path: string, body?: unknown): Promise<Response> {
    const token = await this.#waypoint.token.value();
    if (!token) throw new Error("waypoint's token could not be read");
    return this.#fetch(`${this.#waypoint.url.replace(/\/$/, "")}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "x-actor": PICKER },
      ...(body !== undefined && { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(10_000),
    });
  }

  async #look(): Promise<string[]> {
    const res = await this.#waypointCall("GET", `/tasks?ready=true&assignee=none&maxResults=${PER_TICK * 4}`);
    if (!res.ok) throw new Error(`waypoint answered ${res.status} for its ready tasks`);
    const ready = ((await res.json()) as { tasks: Task[] }).tasks.filter((task) => !task.assignee);
    const asked = new Set((await this.#store.listRequests()).filter((r) => r.state !== "withdrawn" && r.item).map((r) => r.item!));
    const taken: string[] = [];
    for (const task of ready.filter((t) => !asked.has(t.id)).slice(0, PER_TICK)) {
      const made = await this.#self("POST", "/requests", {
        role: this.#role,
        brief: briefFor(task),
        item: task.id,
        subject: `waypoint ${task.shortId ?? task.id}`,
        label: shorten(`task: ${task.title}`, LABEL_LIMIT),
      });
      if (made.status !== 201) {
        this.#log(JSON.stringify({ pickUp: "refused", task: task.id, status: made.status, error: made.body?.error }));
        continue;
      }
      const name = nameFor({ id: made.body.id, role: this.#role });
      const assigned = await this.#waypointCall("PATCH", `/tasks/${encodeURIComponent(task.id)}`, { assignee: name }).catch((err: Error) => err);
      if (assigned instanceof Error || !assigned.ok) {
        const why = assigned instanceof Error ? assigned.message : `waypoint answered ${assigned.status}`;
        await this.#self("DELETE", `/requests/${made.body.id}`);
        this.#log(JSON.stringify({ pickUp: "let go", task: task.id, error: why }));
        continue;
      }
      this.#log(JSON.stringify({ pickUp: "took", task: task.id, agent: name }));
      taken.push(task.id);
    }
    return taken;
  }
}
