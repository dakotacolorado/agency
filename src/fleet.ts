import { randomUUID } from "node:crypto";
import type { Attached } from "./context.ts";
import type { Credentials } from "./credentials.ts";
import {
  activityOf,
  afterSession,
  available,
  cut,
  delivery,
  hostStatus,
  isLive,
  onceQuiet,
  quiet,
  highest,
  NO_TOKENS,
  statusOf,
  summed,
  TOKEN_FIELDS,
  withdrawn,
  type Activity,
  type Host,
  type Queued,
  type Sent,
  type Session,
  type SessionEnding,
  type Agent,
  unreported,
} from "./domain.ts";
import type { Push } from "./push.ts";
import {
  USAGE_WINDOWS,
  type Command,
  type Report,
  type SocketOutbound,
  type TranscriptLine,
  type Usage,
  type UsageReport,
} from "./schema.ts";
import { Conflict, type Change, type SessionWrite, type Store } from "./store.ts";

/**
 * What the HTTP API and the socket share: writing a change then pushing it,
 * and applying what a host reports on its socket.
 */
const ATTEMPTS = 4;

/** A `guarded` change that found an agent written since it was read. */
export const conflicted = (err: unknown): boolean => err instanceof Conflict;

/** Runs `attempt`, which reads what it writes, again while it is `conflicted`. */
export async function afresh<T>(attempt: () => Promise<T>): Promise<T> {
  for (let n = 1; ; n++) {
    try {
      return await attempt();
    } catch (err) {
      if (n >= ATTEMPTS || !conflicted(err)) throw err;
      await new Promise((resolve) => setTimeout(resolve, 20 * n + Math.random() * 30));
    }
  }
}

export class Fleet {
  readonly store: Store;
  readonly push: Push;
  readonly now: () => Date;
  readonly credentials: Credentials;

  constructor(store: Store, push: Push, now: () => Date, credentials: Credentials) {
    this.store = store;
    this.push = push;
    this.now = now;
    this.credentials = credentials;
  }

  /**
   * Writes `change`, then pushes its commands to their host's sockets and the
   * agents it names to viewers. Written first, so a push never announces
   * what the table does not hold.
   */
  async apply(change: Change): Promise<void> {
    await this.store.commit(change);
    const byHost = new Map<string, SocketOutbound[]>();
    for (const { hostId, queued } of change.queue ?? []) {
      const command = await this.credentials.seal(queued.command);
      byHost.set(hostId, [...(byHost.get(hostId) ?? []), { type: "command", command }]);
    }
    for (const [hostId, messages] of byHost) await this.push.toHost(hostId, messages);
    await this.announce(change.agents ?? []);
    await this.tell([
      ...(change.queue ?? []).map(({ queued }) => unreported(queued)),
      ...(change.settled ?? []).map(({ sent }) => sent),
    ]);
  }

  /** Off its host's queue, or its written record settled, and every viewer told. */
  async settle(hostId: string, sent: Sent): Promise<void> {
    await this.store.settle(hostId, sent);
    await this.tell([sent]);
  }

  /** Only what a conversation shows: the commands that carry something said to the agent. */
  private async tell(sent: Sent[]): Promise<void> {
    const now = this.now();
    await this.push.toViewers(
      sent.filter((s) => "text" in s.command && s.command.text !== undefined).map((s) => ({ type: "sent", agentId: s.command.agentId, sent: sentView(s, now) })),
    );
  }

  async announce(agents: Agent[]): Promise<void> {
    if (!agents.length) return;
    const hosts = new Map((await this.store.listHosts()).map((h) => [h.id, h]));
    const now = this.now();
    await this.push.toViewers(
      agents.map((w) => ({ type: "agent", agent: agentView(w, hosts.get(w.hostId) ?? null, now) })),
    );
  }

  /**
   * Stops the agent's session and retires it, releasing its name; the id of the `retire` its host is sent.
   * Guarded: `conflicted` when the agent was written since it was read, for the caller to read it again.
   */
  async retire(agent: Agent): Promise<string> {
    const now = this.now();
    const at = now.toISOString();
    const commands: Command[] = [];
    const sessions: SessionWrite[] = [];
    if (agent.session) {
      sessions.push({ ...agent.session, agentId: agent.id, endedAt: at, ended: "stopped" });
      commands.push({ kind: "stop", id: randomUUID(), agentId: agent.id });
    }
    const retire: Command = { kind: "retire", id: randomUUID(), agentId: agent.id };
    commands.push(retire);
    await this.apply({
      agents: [{ ...agent, state: "retired", session: null, ...afterSession(agent) }],
      sessions,
      queue: inOrder(agent.hostId, commands, now),
      release: agent.name,
      guarded: true,
    });
    try {
      await this.credentials.own.remove(agent.id, agent.ownCredentials ?? []);
    } catch (err) {
      console.error(`Could not delete ${agent.id}'s own credentials:`, (err as Error).name);
    }
    return retire.id;
  }

  /**
   * Only agents on this host are touched. One the host reports that nobody
   * put there is ignored: a host runs what it was given and cannot bring a
   * agent onto the record by claiming it, nor write into the transcript of
   * one it was not given. Lines are stored whatever the state, so the last
   * words of a session are kept with the rest. A retired agent's state is
   * the service's alone.
   */
  /**
   * Each window the reading carries, unless one read later is already on
   * record; viewers hear only when one was kept.
   */
  async reportUsage(hostId: string, reading: UsageReport): Promise<void> {
    const readAt = new Date(reading.readAt).toISOString();
    const kept = await Promise.all(
      USAGE_WINDOWS.map(async (name) => {
        const window = reading[name];
        if (!window) return false;
        const resetsAt = new Date(window.resetsAt).toISOString();
        return this.store.putUsage(name, { utilization: window.utilization, resetsAt, readAt, hostId });
      }),
    );
    if (kept.some(Boolean)) await this.push.toViewers([{ type: "usage", usage: await this.usage() }]);
  }

  async usage(): Promise<Usage> {
    const held = await this.store.usage();
    const fiveHour = held.fiveHour ?? null;
    const sevenDay = held.sevenDay ?? null;
    const readAt = [fiveHour?.readAt, sevenDay?.readAt].filter((at) => at !== undefined).sort().at(-1) ?? null;
    return { readAt, fiveHour, sevenDay };
  }

  async report(hostId: string, report: Report): Promise<void> {
    // A host's reports can land in two invocations at once and race on the
    // same records, and with the API's writes; the loser reads again and applies its report afresh.
    return afresh(() => this.applyReport(hostId, report));
  }

  private async applyReport(hostId: string, report: Report): Promise<void> {
    const at = this.now().toISOString();
    const now = this.now();
    // Pending before agents: a start settled by a concurrent report is then either still pending
    // here, or settled with its agent's `begun` in one write that the agents read after sees.
    let pending = await this.store.pending(hostId);
    let written = await this.store.written(hostId);
    const agents = new Map(
      (await this.store.listAgents()).filter((w) => w.hostId === hostId).map((w) => [w.id, w]),
    );
    const changed = new Map<string, Agent>();
    const sessions: SessionWrite[] = [];
    const queue: Change["queue"] = [];
    const settled: NonNullable<Change["settled"]> = [];
    const retiring = new Set<string>();

    const end = (agent: Agent, ended: SessionEnding) => {
      if (!agent.session) return;
      sessions.push({ ...agent.session, agentId: agent.id, endedAt: at, ended });
      // Its text was in a session that is gone; a host that restarted cannot say so itself.
      for (const sent of written.filter((s) => s.command.agentId === agent.id)) {
        settled.push({ hostId, sent: { ...sent, reportedAt: at, ok: false, error: NEVER_TAKEN, taken: null } });
      }
      written = written.filter((s) => s.command.agentId !== agent.id);
      const next: Agent = {
        ...agent,
        state: ended === "stopped" ? "idle" : "interrupted",
        session: null,
        reportedAt: at,
        ...afterSession(agent),
      };
      agents.set(agent.id, next);
      changed.set(agent.id, next);
      if (onceQuiet(next) === "retire") retiring.add(agent.id);
    };
    const update = (agent: Agent, fields: Partial<Agent>) => {
      const next = { ...agent, ...fields };
      agents.set(agent.id, next);
      changed.set(agent.id, next);
    };

    // As they were before this report: what an earlier report confirmed.
    const begun = new Map([...agents].map(([id, w]) => [id, w.begun ?? null]));

    for (const result of report.commandResults) {
      const taken = result.ok && result.taken === false ? false : null;
      const held = written.find((s) => s.command.id === result.commandId);
      if (held) {
        // Written already, it is settled by the report that it was taken, or never will be.
        if (taken === false) continue;
        written = written.filter((s) => s !== held);
        await this.settle(hostId, { ...held, reportedAt: at, ok: result.ok, error: result.error ?? null, taken });
        continue;
      }
      const queued = pending.find((q) => q.command.id === result.commandId);
      if (!queued) continue;
      pending = pending.filter((q) => q !== queued);
      const { command } = queued;
      const agent = agents.get(command.agentId);
      const sent: Sent = { ...queued, reportedAt: at, ok: result.ok, error: result.error ?? null, withdrawnAt: null, taken };
      if (taken === false) written.push(sent);
      // A start or stop is settled in the write that records what it did to its agent.
      if (command.kind === "start" || command.kind === "stop") settled.push({ hostId, sent });
      else await this.settle(hostId, sent);
      if (agent && agent.state !== "retired") {
        // A start the host could not do is a session that died before it began.
        if (command.kind === "start" && !result.ok && agent.session?.id === command.sessionId) {
          end(agent, "interrupted");
        }
        if (command.kind === "stop" && result.ok) end(agent, "stopped");
        if (command.kind === "start" && result.ok && agent.session?.id === command.sessionId) {
          update(agent, { begun: command.sessionId });
        }
      }
    }
    const offered = pending.filter((q) => !withdrawn(q, now));

    for (const { id, state, sessionId, tasks = 0, told = null } of report.agents) {
      const agent = agents.get(id);
      if (!agent || agent.state === "retired") continue;
      const session = agent.session;
      if (!session) {
        // Force-stopped while its host could not hear it: told to stop, once until taken.
        if (isLive(state) && !stopping(offered, id)) {
          const stop: Queued = { command: { kind: "stop", id: randomUUID(), agentId: id }, queuedAt: at };
          queue.push({ hostId, queued: stop });
          offered.push(stop);
        } else if (!isLive(state) && agent.reportedAt === null) {
          update(agent, { reportedAt: at });
        }
        continue;
      }
      if (sessionId === session.id) {
        if (state === "idle") end(agent, "stopped");
        else if (state === "interrupted") end(agent, "interrupted");
        else if (state !== agent.state || tasks !== (agent.tasks ?? 0) || told !== (agent.told ?? null) || agent.reportedAt === null) {
          const next: Agent = { ...agent, state, tasks, told, reportedAt: at };
          update(agent, next);
          const then = onceQuiet(next);
          if (then && quiet(next) && !quiet(agent)) {
            if (then === "retire") retiring.add(id);
            else if (!stopping(offered, id)) {
              const stop: Queued = { command: { kind: "stop", id: randomUUID(), agentId: id }, queuedAt: at };
              queue.push({ hostId, queued: stop });
              offered.push(stop);
            }
          }
        }
        continue;
      }
      // A session not yet begun is not missing; nor is one the host reports beside another it runs.
      if (starting(offered, session.id) || isLive(state)) continue;
      // Reports are applied as they arrive, not as they were sent: a snapshot from before an earlier
      // report's start says idle with no session, where a session that died is reported interrupted.
      if (state === "idle" && sessionId === null && begun.get(id) === session.id) continue;
      end(agent, "interrupted");
    }

    const lines = new Map<string, TranscriptLine[]>();
    for (const { agentId, ...line } of report.lines) {
      if (!agents.has(agentId)) continue;
      lines.set(agentId, [...(lines.get(agentId) ?? []), { ...line, text: cut(line.text) }]);
    }
    for (const [agentId, written] of lines) {
      await this.store.putLines(agentId, written);
      const agent = agents.get(agentId)!;
      const latest = [...written]
        .sort((a, b) => b.seq - a.seq)
        .map((line) => ({ text: activityOf(line.from, line.text), at: line.at }))
        .find((a): a is Activity => a.text !== null);
      if (agent.state !== "retired" && latest && latest.at >= (agent.activity?.at ?? "")) update(agent, { activity: latest });
    }

    // Counted on a retired agent too: its last turn's total can arrive in the report that retires it.
    for (const { agentId, sessionId, ...reported } of report.tokens ?? []) {
      const agent = agents.get(agentId);
      if (!agent) continue;
      const held = agent.sessionTokens?.[sessionId] ?? NO_TOKENS;
      const kept = highest(held, reported);
      if (TOKEN_FIELDS.every((f) => kept[f] === held[f]) && agent.sessionTokens?.[sessionId]) continue;
      update(agent, { sessionTokens: { ...agent.sessionTokens, [sessionId]: kept } });
    }

    // Guarded, so a status said, or anything else written, since these agents were read is never put back.
    await this.apply({ agents: [...changed.values()], sessions, queue, settled, guarded: true });
    // Read again, as what this report wrote has a new rev, and retired even if written since.
    for (const id of retiring) {
      await afresh(async () => {
        const agent = await this.store.getAgent(id);
        if (agent && agent.state !== "retired") await this.retire(agent);
      });
    }
    await this.push.toViewers(
      [...lines].map(([agentId, written]): SocketOutbound => ({
        type: "lines",
        agentId,
        lines: written.sort((a, b) => a.seq - b.seq),
      })),
    );
  }
}

const NEVER_TAKEN = "Its session ended before it took the message.";

/** A command as it is served, on `ListCommands` and to viewers. */
export const sentView = (sent: Sent, now: Date) => ({
  command: sent.command,
  queuedAt: sent.queuedAt,
  delivery: delivery(sent, now),
  reportedAt: sent.reportedAt,
  error: sent.error,
});

const stopping = (offered: Queued[], agentId: string) =>
  offered.some((q) => q.command.kind === "stop" && q.command.agentId === agentId);

const starting = (offered: Queued[], sessionId: string) =>
  offered.some((q) => q.command.kind === "start" && q.command.sessionId === sessionId);

/** An agent as it is served, which `hadSession` and `begun` are not. */
export const agentView = (agent: Agent, host: Host | null, now: Date) => {
  const { hadSession: _, begun: __, ownCredentials: ____, rev: ________, sessionTokens, item, role, title, label, createdBy, whenDone, documents, credentials, status: _____, summary, headline, saidAt, activity, tasks, ...served } =
    // Records written before `turn` and `paged` were dropped still hold them.
    agent as Agent & { turn?: unknown; paged?: unknown };
  const { turn: ______, paged: _______, ...rest } = served as typeof served & { turn?: unknown; paged?: unknown };
  return {
    ...rest,
    title: title ?? null,
    label: label ?? null,
    item: item ?? null,
    role: role ?? null,
    tokens: summed(sessionTokens),
    createdBy: createdBy ?? null,
    whenDone: whenDone ?? "keep",
    documents: documents ?? [],
    // An agent made before credentials were chosen was given today's defaults at each start.
    credentials: credentials ?? null,
    status: statusOf(agent),
    summary: summary ?? null,
    headline: headline ?? null,
    saidAt: saidAt ?? null,
    activity: activity ?? null,
    tasks: tasks ?? 0,
    told: agent.told ?? null,
    hostStatus: host ? hostStatus(host.heartbeatAt, now) : ("lost" as const),
  };
};

export const hostView = (host: Host, agents: Agent[], now: Date) => ({
  ...host,
  status: hostStatus(host.heartbeatAt, now),
  available: available(host, agents),
});

/** The start of a new session, and the agent with it live, given what is attached to it. */
export function begin(
  agent: Agent,
  at: string,
  text?: string,
  attached: Attached = { context: null, documents: [], skills: [], env: {}, credentials: [], ownCredentials: [], note: null },
): { agent: Agent; session: Session; command: Command } {
  const { context, documents, skills, env, credentials, ownCredentials, note, mcpServers = {} } = attached;
  const session: Session = {
    id: randomUUID(),
    agentId: agent.id,
    startedAt: at,
    endedAt: null,
    ended: null,
    context: context && { key: context.key, version: context.version },
    documents: documents.map(({ key, version }) => ({ key, version })),
    skills,
    contextNote: note,
  };
  return {
    agent: {
      ...agent,
      state: "working",
      session: { id: session.id, startedAt: at },
      hadSession: true,
      status: "working",
      summary: null,
      headline: null,
      saidAt: null,
      tasks: 0,
      told: null,
    },
    session,
    command: {
      kind: "start",
      id: randomUUID(),
      agentId: agent.id,
      sessionId: session.id,
      resume: agent.hadSession,
      ...(text !== undefined && { text }),
      ...(context && { context }),
      ...(documents.length && { documents }),
      ...(Object.keys(env).length && { env }),
      ...(credentials.length && { credentials }),
      ...(ownCredentials.length && { ownCredentials }),
      ...(Object.keys(mcpServers).length && { mcpServers }),
    },
  };
}

/**
 * A millisecond apart, so commands written together keep their order on a
 * queue sorted by `queuedAt`: a `create` must reach its host before its `start`.
 */
export const inOrder = (hostId: string, commands: Command[], now: Date): NonNullable<Change["queue"]> =>
  commands.map((command, i) => ({
    hostId,
    queued: { command, queuedAt: new Date(now.getTime() + i).toISOString() } satisfies Queued,
  }));
