import { isLive, quiet, type Agent, type Session } from "./domain.ts";
import { conflicted, type Fleet, type Starting } from "./fleet.ts";
import { RESUME_TEXT } from "./schema.ts";
import type { Store } from "./store.ts";

/** Seconds between sweeps: prunes of what has aged out (`Store.prune`), retirements (`retireClosed`), and nudge's reconcile. */
export const PRUNE_SECONDS = 3600;

/** Days an agent stays closed before the sweep retires it, unless `--retire-closed-after` says otherwise. */
export const RETIRE_CLOSED_AFTER = 14;

const DAY_MS = 24 * 3600 * 1000;

/** Seconds between looks for agents whose usage limit has reset (`resumeLimited`). */
export const RESUME_SECONDS = 60;

/** Seconds past `limitedUntil` an agent is left, so its host's reading of the reset is not early. */
export const RESUME_AFTER = 60;

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

/**
 * Sends each agent not deleted whose `limitedUntil` is over `RESUME_AFTER` seconds past `RESUME_TEXT`, as
 * `SendMessage` does, clearing it in the same write. One that cannot be sent to, or was written since it was
 * read, keeps it for the next look. Answers the names resumed.
 */
export async function resumeLimited(fleet: Fleet, starting: Starting, log: (line: string) => void = console.log): Promise<string[]> {
  const before = fleet.now().getTime() - RESUME_AFTER * 1000;
  const resumed: string[] = [];
  for (const agent of await fleet.store.listAgents()) {
    const until = agent.limitedUntil ?? null;
    if (agent.state === "deleted" || until === null || new Date(until).getTime() >= before) continue;
    try {
      const sent = await fleet.message(agent, { text: RESUME_TEXT }, starting, { limitedUntil: null, resumed: until });
      if ("refused" in sent) {
        log(JSON.stringify({ resumed: "failed", agent: agent.name, error: sent.refused }));
        continue;
      }
      resumed.push(agent.name);
      log(JSON.stringify({ resumed: agent.name, limitedUntil: until }));
    } catch (err) {
      if (!conflicted(err)) log(JSON.stringify({ resumed: "failed", agent: agent.name, error: (err as Error).message }));
    }
  }
  return resumed;
}

export interface Timers {
  log?: (line: string) => void;
  now?: () => Date;
  /** Run on each sweep after the prune, such as `retireClosed`. */
  retire?: () => Promise<unknown>;
  /** Run on each sweep after `retire`, such as `AgentNotifier.reconcile`. */
  reconcile?: () => Promise<unknown>;
  /** Run every `RESUME_SECONDS`, such as `AgencyApi.resume`. */
  resume?: () => Promise<unknown>;
}

/**
 * Sweeps every `PRUNE_SECONDS`, and resumes every `RESUME_SECONDS`, until the answer is called; a failed
 * tick is logged and the next tried.
 */
export function startTimers(store: Store, { log = console.log, now = () => new Date(), retire, reconcile, resume }: Timers = {}): () => void {
  const sweep = () => {
    try {
      const n = store.prune(now());
      if (n) log(JSON.stringify({ pruned: n }));
    } catch (err) {
      log(JSON.stringify({ pruned: "failed", error: (err as Error).message }));
    }
    void (async () => {
      await retire?.().catch((err) => log(JSON.stringify({ retired: "failed", error: (err as Error).message })));
      await reconcile?.().catch((err) => log(JSON.stringify({ reconciled: "failed", error: (err as Error).message })));
    })();
  };
  sweep();
  const sweeping = setInterval(sweep, PRUNE_SECONDS * 1000);
  sweeping.unref();
  let resuming: ReturnType<typeof setInterval> | null = null;
  if (resume) {
    let running = false;
    // One look at a time: a slow one is not overlapped by the next, which would send twice.
    const look = async () => {
      if (running) return;
      running = true;
      await resume().catch((err) => log(JSON.stringify({ resumed: "failed", error: (err as Error).message })));
      running = false;
    };
    resuming = setInterval(() => void look(), RESUME_SECONDS * 1000);
    resuming.unref();
  }
  return () => {
    clearInterval(sweeping);
    if (resuming) clearInterval(resuming);
  };
}
