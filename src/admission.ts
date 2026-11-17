import type { Capability } from "./capabilities.ts";
import type { Role } from "./roles.ts";
import type { Usage, UsageWindow } from "./schema.ts";

/** At or above this share of either usage window, nothing is admitted. */
export const USAGE_LIMIT = 0.9;

/** A reading older than this, of a window that has not reset since, says nothing about now. */
export const FRESH_FOR_MS = 15 * 60_000;

/**
 * A request started this recently whose agent is not recorded yet is being made: it is still on its item.
 * Past this, its making failed without putting it back, and it holds the item no longer.
 */
export const MAKING_FOR_MS = 5 * 60_000;

export const REQUEST_STATES = ["waiting", "started", "withdrawn"] as const;

export type RequestState = (typeof REQUEST_STATES)[number];

/** An agent asked for by role, waiting until usage and a host allow it to start. */
export interface AgentRequest {
  /** Also the id of the agent it starts, so a token of its own kept for it is the agent's. */
  id: string;
  role: string;
  /** Null to start on the role's own brief. */
  brief: string | null;
  item: string | null;
  /** What it is for when it is no work item, such as `PR #41`; shown, never read. */
  subject: string | null;
  label: string | null;
  /** What the host it is placed on must all carry. */
  labels: string[];
  /** Names, in place of the role's; null for the role's. */
  credentials: string[] | null;
  /** In place of the role's; null, or absent on a request written before it, for the role's. */
  capability?: Capability | null;
  requester: string | null;
  state: RequestState;
  /** Why it has not started, as the last admission found; null once it has, or before any looked. */
  why: string | null;
  createdAt: string;
  startedAt: string | null;
  agentId: string | null;
  withdrawnAt: string | null;
  /** Replaced on every write, so admitting it and withdrawing it cannot both land. */
  rev?: string;
}

/**
 * A stale reading this far under `USAGE_LIMIT` still admits one request at a time: the agent it starts
 * gives the next reading, which nothing else would while no session is running.
 */
export const STALE_UNDER = USAGE_LIMIT - 0.2;

type WindowVerdict = { ok: true; stale: boolean } | { ok: false; why: string };

function windowVerdict(name: string, window: UsageWindow | null, now: number): WindowVerdict {
  if (window === null) return { ok: false, why: `no ${name} usage has been reported` };
  if (Date.parse(window.resetsAt) <= now) return { ok: true, stale: false };
  const percent = Math.round(window.utilization * 100);
  const age = now - Date.parse(window.readAt);
  if (age > FRESH_FOR_MS) {
    if (window.utilization < STALE_UNDER) return { ok: true, stale: true };
    const minutes = Math.round(age / 60_000);
    return { ok: false, why: `the ${name} usage reading is ${minutes} minutes old, read at ${percent}%, and its window has not reset` };
  }
  if (window.utilization >= USAGE_LIMIT) return { ok: false, why: `${name} usage is ${percent}%, at or over ${USAGE_LIMIT * 100}%` };
  return { ok: true, stale: false };
}

/** What usage lets start now: nothing (and why), one request alone, or as many as hosts allow. */
export type UsageAdmits = { none: string } | { one: true } | { any: true };

/**
 * `lastStart` is when a request last started: on a stale reading one starts only once none has
 * since that reading, or within the last `FRESH_FOR_MS`, so a burst never starts on a stale reading.
 */
export function usageAdmits(usage: Usage, now: Date, lastStart: Date | null = null): UsageAdmits {
  const verdicts = [windowVerdict("5-hour", usage.fiveHour, now.getTime()), windowVerdict("weekly", usage.sevenDay, now.getTime())];
  const why = verdicts.flatMap((each) => (each.ok ? [] : [each.why]));
  if (why.length) return { none: `Waits on usage: ${why.join("; ")}.` };
  if (!verdicts.some((each) => each.ok && each.stale)) return { any: true };
  const readAt = Math.max(...[usage.fiveHour, usage.sevenDay].map((each) => Date.parse(each!.readAt)));
  const since = lastStart === null ? -Infinity : lastStart.getTime();
  if (since > readAt && now.getTime() - since < FRESH_FOR_MS) {
    return { none: "Waits on usage: the last reading is stale, and the agent started since has not given a new one yet." };
  }
  return { one: true };
}

/** Why usage lets nothing start now, or null when it lets something. */
export function usageRefusal(usage: Usage, now: Date, lastStart: Date | null = null): string | null {
  const admits = usageAdmits(usage, now, lastStart);
  return "none" in admits ? admits.none : null;
}

/** The order waiting requests start in: their role's priority, highest first, then oldest first. */
export function inStartOrder(requests: AgentRequest[], roles: Role[]): AgentRequest[] {
  const priority = new Map(roles.map((role) => [role.name, role.priority]));
  return [...requests].sort(
    (a, b) => (priority.get(b.role) ?? 0) - (priority.get(a.role) ?? 0) || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
  );
}

/** The agent's name: its role and the start of its id, which is unique enough among agents not deleted. */
export const nameFor = (request: Pick<AgentRequest, "id" | "role">) => `${request.role.slice(0, 31)}-${request.id.slice(0, 8)}`;
