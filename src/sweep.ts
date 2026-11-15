import { isLive, quiet, type Agent, type Session } from "./domain.ts";
import { conflicted, type Fleet } from "./fleet.ts";
import type { Store } from "./store.ts";

/** Seconds between sweeps: prunes of what has aged out (`Store.prune`), and retirements (`retireClosed`). */
export const PRUNE_SECONDS = 3600;

/** Days an agent stays closed before the sweep retires it, unless `--retire-closed-after` says otherwise. */
export const RETIRE_CLOSED_AFTER = 3;

const DAY_MS = 24 * 3600 * 1000;

/** When it closed: the later of when it said `done` and when its last session ended; null while either is unknown. */
export function closedSince(agent: Agent, sessions: Session[]): string | null {
  const ended = sessions.at(-1)?.endedAt ?? null;
  const said = agent.saidAt ?? null;
  if (!said && !ended) return null;
  return [said, ended].filter((at) => at !== null).sort().at(-1)!;
}

/** `done`, not deleted, with no live session and nothing running. */
export const closed = (agent: Agent): boolean =>
  agent.status === "done" && agent.state !== "deleted" && agent.session === null && !isLive(agent.state) && quiet(agent);

/**
 * Deletes, as `DeleteAgent` does, each agent `closed` for longer than `days`; `0` retires none.
 * One written since it was read is left for the next sweep. Answers the names retired.
 */
export async function retireClosed(fleet: Fleet, days: number, log: (line: string) => void = console.log): Promise<string[]> {
  if (!(days > 0)) return [];
  const before = fleet.now().getTime() - days * DAY_MS;
  const retired: string[] = [];
  for (const agent of await fleet.store.listAgents()) {
    if (!closed(agent)) continue;
    const since = closedSince(agent, await fleet.store.sessionsOf(agent.id));
    if (!since || new Date(since).getTime() >= before) continue;
    try {
      await fleet.deleteAgent(agent);
      retired.push(agent.name);
      log(JSON.stringify({ retired: agent.name, closedSince: since }));
    } catch (err) {
      if (!conflicted(err)) log(JSON.stringify({ retired: "failed", agent: agent.name, error: (err as Error).message }));
    }
  }
  return retired;
}

export interface Timers {
  log?: (line: string) => void;
  now?: () => Date;
  /** Run on each sweep after the prune, such as `retireClosed`. */
  retire?: () => Promise<unknown>;
}

/** Sweeps every `PRUNE_SECONDS` until the answer is called; a failed tick is logged and the next tried. */
export function startTimers(store: Store, { log = console.log, now = () => new Date(), retire }: Timers = {}): () => void {
  const sweep = () => {
    try {
      const n = store.prune(now());
      if (n) log(JSON.stringify({ pruned: n }));
    } catch (err) {
      log(JSON.stringify({ pruned: "failed", error: (err as Error).message }));
    }
    retire?.().catch((err) => log(JSON.stringify({ retired: "failed", error: (err as Error).message })));
  };
  sweep();
  const sweeping = setInterval(sweep, PRUNE_SECONDS * 1000);
  sweeping.unref();
  return () => clearInterval(sweeping);
}
