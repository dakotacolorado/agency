import type { Capability } from "./capabilities.ts";
import type { Role } from "./roles.ts";
import type { Usage, UsageWindow } from "./schema.ts";

/** At or above this share of either usage window, nothing is admitted. */
export const USAGE_LIMIT = 0.95;

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

type WindowVerdict = { ok: true } | { ok: false; why: string };

/** Judged on the window's newest reading however old it is; one whose window has since reset reads 0. */
function windowVerdict(name: string, window: UsageWindow | null, now: number): WindowVerdict {
  if (window === null) return { ok: false, why: `no ${name} usage has been reported` };
  if (Date.parse(window.resetsAt) <= now) return { ok: true };
  const percent = Math.round(window.utilization * 100);
  if (window.utilization >= USAGE_LIMIT) return { ok: false, why: `${name} usage is ${percent}%, at or over ${USAGE_LIMIT * 100}%` };
  return { ok: true };
}

/** What usage lets start now: nothing (and why), or as many as hosts allow. */
export type UsageAdmits = { none: string } | { any: true };

export function usageAdmits(usage: Usage, now: Date): UsageAdmits {
  const verdicts = [windowVerdict("5-hour", usage.fiveHour, now.getTime()), windowVerdict("weekly", usage.sevenDay, now.getTime())];
  const why = verdicts.flatMap((each) => (each.ok ? [] : [each.why]));
  if (why.length) return { none: `Waits on usage: ${why.join("; ")}.` };
  return { any: true };
}

/** Why usage lets nothing start now, or null when it lets something. */
export function usageRefusal(usage: Usage, now: Date): string | null {
  const admits = usageAdmits(usage, now);
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
