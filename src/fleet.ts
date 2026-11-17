import { randomUUID } from "node:crypto";
import type { Attached } from "./context.ts";
import { capabilityOf, DEFAULT_CAPABILITIES, type CapabilityMap, type CapabilityModel } from "./capabilities.ts";
import type { Credentials } from "./credentials.ts";
import { KeyringUnreachable, NO_SECRETS, type SecretSource } from "./keyring.ts";
import {
  activityOf,
  afterSession,
  available,
  cleared,
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
  unreachable,
  unreported,
} from "./domain.ts";
import { NO_NOTIFIER, type AgentNotifier } from "./nudge.ts";
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
import { sessionView, type Tally } from "./sessions.ts";
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

const RESOLVED_MS = 10 * 60_000;

export class Fleet {
  readonly store: Store;
  readonly push: Push;
  readonly now: () => Date;
  readonly credentials: Credentials;
  readonly notifier: AgentNotifier;
  readonly capabilities: CapabilityMap;
  private readonly keyring: SecretSource;
  /** Secrets resolved as a start was made, by its command's id, until the command is pushed: in memory only. */
  private readonly resolved = new Map<string, { secrets: Record<string, string>; until: number }>();

  constructor(
    store: Store,
    push: Push,
    now: () => Date,
    credentials: Credentials,
    notifier: AgentNotifier = NO_NOTIFIER,
    capabilities: CapabilityMap = DEFAULT_CAPABILITIES,
    keyring: SecretSource = NO_SECRETS,
  ) {
    this.keyring = keyring;
    this.capabilities = capabilities;
    this.store = store;
    this.push = push;
    this.now = now;
    this.credentials = credentials;
    this.notifier = notifier;
  }

  /**
   * Writes `change`, then pushes its commands to their host's sockets and the
   * agents it names to viewers. Written first, so a push never announces
   * what the table does not hold.
   */
  async apply(change: Change): Promise<void> {
    await this.store.commit(change);
    // Every write of an agent passes here, so whatever moves it out of waiting or review takes its nudge back.
    this.notifier.wrote(change.agents ?? []);
    const byHost = new Map<string, SocketOutbound[]>();
    for (const { hostId, queued } of change.queue ?? []) {
      const command = await this.seal(queued.command);
      // One that cannot be sealed stays pending, for the host's next replay.
      if (command) byHost.set(hostId, [...(byHost.get(hostId) ?? []), { type: "command", command }]);
    }
    for (const [hostId, messages] of byHost) await this.push.toHost(hostId, messages);
    await this.announce(change.agents ?? []);
    await this.tell([
      ...(change.queue ?? []).map(({ queued }) => unreported(queued)),
      ...(change.settled ?? []).map(({ sent }) => sent),
    ]);
  }

  /**
   * Resolves the secrets keyring grants the session `command` starts, and holds them in memory for `seal`.
   * Answers their variable names. Throws `KeyringUnreachable`, before anything is written.
   */
  async grant(agent: Agent, command: Command): Promise<string[]> {
    const secrets = await this.granted(agent);
    this.resolved.set(command.id, { secrets, until: this.now().getTime() + RESOLVED_MS });
    return Object.keys(secrets);
  }

  private async granted(agent: Agent): Promise<Record<string, string>> {
    const host = await this.store.getHost(agent.hostId);
    return this.keyring.resolve({ agent: agent.name, role: agent.role ?? null, labels: host?.labels ?? [] });
  }

  /**
   * A command as it goes to its host: a `start` carries the tokens of the services it is given, over which
   * keyring's secrets are laid, so keyring's value wins. Never stored. Null, logged without a value, for a
   * start whose secrets keyring cannot give now.
   */
  async seal(command: Command): Promise<Command | null> {
    if (command.kind !== "start") return command;
    const base = (await this.credentials.seal(command)) as typeof command;
    try {
      const held = this.resolved.get(command.id);
      this.resolved.delete(command.id);
      const now = this.now().getTime();
      for (const [id, { until }] of this.resolved) if (until < now) this.resolved.delete(id);
      let granted = held && held.until >= now ? held.secrets : null;
      if (!granted) {
        const agent = await this.store.getAgent(command.agentId);
        granted = agent ? await this.granted(agent) : {};
      }
      const secrets = { ...base.secrets, ...granted };
      return Object.keys(secrets).length ? { ...base, secrets } : base;
    } catch (err) {
      if (!(err instanceof KeyringUnreachable)) throw err;
      console.error(`Not sending start ${command.id}: ${err.message}`);
      return null;
    }
  }

  /** Off its host's queue, and every viewer told. */
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
    const current = await Promise.all(agents.map((w) => (w.session ? this.store.getSession(w.id, w.session.id) : null)));
    const now = this.now();
    await this.push.toViewers(
      agents.map((w, i) => ({ type: "agent", agent: agentView(w, hosts.get(w.hostId) ?? null, now, this.capabilities, current[i]) })),
    );
  }

  /** The agent's host, or why nothing can be sent to it. */
  async reachable(agent: Agent): Promise<Host | string> {
    const host = await this.store.getHost(agent.hostId);
    return unreachable(host, agent.hostId, this.now()) ?? host!;
  }

  /** Why the host has no room for another session, or null when it has. */
  async full(host: Host): Promise<string | null> {
    return available(host, await this.store.listAgents()) === 0
      ? `${host.id} is running all ${host.capacity} sessions it will.`
      : null;
  }

  /**
   * What `SendMessage` does: to a live session a `message`, or an `interrupt`; to one without, a `start`
   * made by `starting` with `text` as its first message. `fields` are written on the agent with it, and
   * any `limitedUntil` cleared, since a turn begins. Answers the command's id, or why nothing was sent.
   * Guarded: `conflicted` when the agent was written since it was read, for the caller to read it again.
   */
  async message(
    agent: Agent,
    { text, interrupt }: { text?: string; interrupt?: boolean },
    starting: Starting,
    fields: Partial<Agent> = {},
  ): Promise<{ commandId: string } | { refused: string }> {
    if (agent.state === "deleted") return { refused: `${agent.name} is deleted.` };
    const host = await this.reachable(agent);
    if (typeof host === "string") return { refused: host };
    const now = this.now();
    const written = { limitedUntil: null, ...fields };
    if (agent.session) {
      const id = randomUUID();
      const command: Command = interrupt
        ? { kind: "interrupt", id, agentId: agent.id, ...(text !== undefined && { text }) }
        : // Without interrupt, the schema requires text, which its type does not say.
          { kind: "message", id, agentId: agent.id, text: text! };
      // Told something, an agent waiting on the person, in review or done, is at work again.
      // At work from the moment it is told, as from a start: its host reports the turn once it begins.
      const answered: Agent[] = [{ ...agent, ...cleared, state: "working", ...written }];
      await this.apply({ agents: answered, queue: inOrder(agent.hostId, [command], now), guarded: true });
      return { commandId: id };
    }
    if (text === undefined) return { refused: `${agent.name} is ${agent.state}, with no session to interrupt.` };
    const full = await this.full(host);
    if (full) return { refused: full };
    let started: Awaited<ReturnType<Starting>>;
    try {
      started = await starting(agent, now.toISOString(), text);
    } catch (err) {
      if (err instanceof KeyringUnreachable) return { refused: `${err.message}; ${agent.name} was not started without its secrets.` };
      throw err;
    }
    await this.apply({
      agents: [{ ...started.agent, ...written }],
      sessions: [started.session],
      queue: inOrder(agent.hostId, [started.command], now),
      guarded: true,
    });
    return { commandId: started.command.id };
  }

  /**
   * Ends the agent's live session and keeps the agent, `idle`, for a message to start it again; the id of
   * the `stop` its host is sent. Recorded at once, as a delete is: should its host still run the session,
   * its next report is told to stop it.
   * Guarded: `conflicted` when the agent was written since it was read, for the caller to read it again.
   */
  async stopAgent(agent: Agent & { session: NonNullable<Agent["session"]> }): Promise<string> {
    const now = this.now();
    const stop: Command = { kind: "stop", id: randomUUID(), agentId: agent.id };
    await this.apply({
      agents: [{ ...agent, state: "idle", session: null, ...afterSession(agent) }],
      sessions: [{ ...agent.session, agentId: agent.id, endedAt: now.toISOString(), ended: "stopped", endReason: "stopped" }],
      queue: inOrder(agent.hostId, [stop], now),
      guarded: true,
    });
    return stop.id;
  }

  /**
   * Stops the agent's session and deletes it, releasing its name; the id of the `delete` its host is sent.
   * Guarded: `conflicted` when the agent was written since it was read, for the caller to read it again.
   */
  async deleteAgent(agent: Agent): Promise<string> {
    const now = this.now();
    const at = now.toISOString();
    const commands: Command[] = [];
    const sessions: SessionWrite[] = [];
    if (agent.session) {
      sessions.push({ ...agent.session, agentId: agent.id, endedAt: at, ended: "stopped", endReason: "stopped" });
      commands.push({ kind: "stop", id: randomUUID(), agentId: agent.id });
    }
    const deletion: Command = { kind: "delete", id: randomUUID(), agentId: agent.id };
    commands.push(deletion);
    await this.apply({
      agents: [{ ...agent, state: "deleted", session: null, ...afterSession(agent) }],
      sessions,
      queue: inOrder(agent.hostId, commands, now),
      release: agent.name,
      guarded: true,
    });
    return deletion.id;
  }

  /**
   * Only agents on this host are touched. One the host reports that nobody
   * put there is ignored: a host runs what it was given and cannot bring a
   * agent onto the record by claiming it, nor write into the transcript of
   * one it was not given. Lines are stored whatever the state, so the last
   * words of a session are kept with the rest. A deleted agent's state is
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
    const agents = new Map(
      (await this.store.listAgents()).filter((w) => w.hostId === hostId).map((w) => [w.id, w]),
    );
    const changed = new Map<string, Agent>();
    const sessions: SessionWrite[] = [];
    const queue: Change["queue"] = [];
    const settled: NonNullable<Change["settled"]> = [];
    const deleting = new Set<string>();
    const tallies: Tally[] = [];
    // A session ending as a usage limit holds it, as it is now or as this report says, ended by the limit.
    const limitedNow = new Set(report.agents.filter((a) => a.limitedUntil).map((a) => a.id));

    const end = (agent: Agent, ended: SessionEnding) => {
      if (!agent.session) return;
      const endReason = agent.limitedUntil || limitedNow.has(agent.id) ? "limit" : ended;
      sessions.push({ ...agent.session, agentId: agent.id, endedAt: at, ended, endReason });
      const next: Agent = {
        ...agent,
        state: ended === "stopped" ? "idle" : "interrupted",
        session: null,
        reportedAt: at,
        ...afterSession(agent),
      };
      agents.set(agent.id, next);
      changed.set(agent.id, next);
      if (onceQuiet(next) === "delete") deleting.add(agent.id);
    };
    const update = (agent: Agent, fields: Partial<Agent>) => {
      const next = { ...agent, ...fields };
      agents.set(agent.id, next);
      changed.set(agent.id, next);
    };

    // As they were before this report: what an earlier report confirmed.
    const begun = new Map([...agents].map(([id, w]) => [id, w.begun ?? null]));

    for (const result of report.commandResults) {
      const queued = pending.find((q) => q.command.id === result.commandId);
      if (!queued) continue;
      pending = pending.filter((q) => q !== queued);
      const { command } = queued;
      const agent = agents.get(command.agentId);
      const sent: Sent = { ...queued, reportedAt: at, ok: result.ok, error: result.error ?? null, withdrawnAt: null };
      // A start or stop is settled in the write that records what it did to its agent.
      if (command.kind === "start" || command.kind === "stop") settled.push({ hostId, sent });
      else await this.settle(hostId, sent);
      if (agent && agent.state !== "deleted") {
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
      if (!agent || agent.state === "deleted") continue;
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
            if (then === "delete") deleting.add(id);
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

    // A limit already resumed from, reported before the resume reached the host, is not set again.
    for (const { id, sessionId, limitedUntil, contextTokens, activeMs, turns } of report.agents) {
      const agent = agents.get(id);
      if (!agent) continue;
      if (sessionId && (activeMs !== undefined || turns !== undefined || contextTokens !== undefined)) {
        tallies.push({ agentId: id, sessionId, activeMs, turns, contextTokens });
      }
      if (agent.state === "deleted") continue;
      const reported = limitedUntil ? new Date(limitedUntil).toISOString() : null;
      const limited = reported !== null && reported === agent.resumed ? null : reported;
      if (limited !== (agent.limitedUntil ?? null)) update(agent, { limitedUntil: limited });
      if (contextTokens !== undefined && contextTokens !== (agent.contextTokens ?? null)) update(agents.get(id)!, { contextTokens });
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
      if (agent.state !== "deleted" && latest && latest.at >= (agent.activity?.at ?? "")) update(agent, { activity: latest });
    }

    // Counted on a deleted agent too: its last turn's total can arrive in the report that deletes it.
    for (const { agentId, sessionId, byModel, ...reported } of report.tokens ?? []) {
      const agent = agents.get(agentId);
      if (!agent) continue;
      tallies.push({ agentId, sessionId, tokens: reported, ...(byModel && { byModel }) });
      const held = agent.sessionTokens?.[sessionId] ?? NO_TOKENS;
      const kept = highest(held, reported);
      if (TOKEN_FIELDS.every((f) => kept[f] === held[f]) && agent.sessionTokens?.[sessionId]) continue;
      update(agent, { sessionTokens: { ...agent.sessionTokens, [sessionId]: kept } });
    }

    // Guarded, so a status said, or anything else written, since these agents were read is never put back.
    await this.apply({ agents: [...changed.values()], sessions, tallies, queue, settled, guarded: true });
    // Read again, as what this report wrote has a new rev, and deleted even if written since.
    for (const id of deleting) {
      await afresh(async () => {
        const agent = await this.store.getAgent(id);
        if (agent && agent.state !== "deleted") await this.deleteAgent(agent);
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
export const agentView = (
  agent: Agent,
  host: Host | null,
  now: Date,
  capabilities: CapabilityMap = DEFAULT_CAPABILITIES,
  current: Session | null = null,
) => {
  const { hadSession: _, begun: __, rev: ________, resumed: _________, limitedUntil, sessionTokens, item, role, title, label, createdBy, whenDone, runtime, skills, credentials, status: _____, summary, headline, saidAt, activity, tasks, capability: ___________, contextTokens, ...served } =
    // Records written before `turn` and `paged` were dropped still hold them.
    agent as Agent & { turn?: unknown; paged?: unknown };
  const { turn: ______, paged: _______, ...rest } = served as typeof served & { turn?: unknown; paged?: unknown };
  const runsOn = capabilities[capabilityOf(agent)];
  return {
    ...rest,
    title: title ?? null,
    label: label ?? null,
    item: item ?? null,
    role: role ?? null,
    tokens: summed(sessionTokens),
    createdBy: createdBy ?? null,
    whenDone: whenDone ?? "keep",
    runtime: runtime ?? "host",
    capability: capabilityOf(agent),
    model: runsOn.model,
    contextTokens: contextTokens ?? null,
    overPriceStep: runsOn.priceStepAt !== null && (contextTokens ?? 0) > runsOn.priceStepAt,
    skills: skills ?? [],
    // An agent made before credentials were chosen was given today's defaults at each start.
    credentials: credentials ?? null,
    status: statusOf(agent),
    summary: summary ?? null,
    headline: headline ?? null,
    saidAt: saidAt ?? null,
    activity: activity ?? null,
    tasks: tasks ?? 0,
    told: agent.told ?? null,
    limitedUntil: limitedUntil ?? null,
    hostStatus: host ? hostStatus(host.heartbeatAt, now) : ("lost" as const),
    currentSession: agent.session && current?.id === agent.session.id ? sessionView(current, capabilities) : null,
  };
};

export const hostView = (host: Host, agents: Agent[], now: Date) => ({
  ...host,
  status: hostStatus(host.heartbeatAt, now),
  available: available(host, agents),
});

/** Makes the start of a new session, with what it is given, as `begin` does. */
export type Starting = (agent: Agent, at: string, text?: string) => Promise<ReturnType<typeof begin>>;

/** The start of a new session, and the agent with it live, given what is attached to it. */
export function begin(
  agent: Agent,
  at: string,
  text?: string,
  attached: Attached | null = null,
  runsOn: CapabilityModel = DEFAULT_CAPABILITIES[capabilityOf(agent)],
): { agent: Agent; session: Session; command: Command } {
  const { clients = null, skills = [], env = {}, credentials = [], note = null, mcpServers = {} } = attached ?? {};
  const session: Session = {
    id: randomUUID(),
    agentId: agent.id,
    startedAt: at,
    endedAt: null,
    ended: null,
    agentName: agent.name,
    role: agent.role ?? null,
    item: agent.item ?? null,
    capability: capabilityOf(agent),
    model: runsOn.model,
    capabilityChanges: [],
    tokens: NO_TOKENS,
    activeMs: 0,
    turns: 0,
    endReason: null,
    skills: skills.map(({ key, version }) => ({ name: key, version })),
    clients: clients && { version: clients.version, commit: clients.commit },
    contextNote: note,
  };
  return {
    agent: {
      ...agent,
      state: "working",
      session: { id: session.id, startedAt: at, skills: session.skills, contextNote: session.contextNote },
      hadSession: true,
      status: "working",
      summary: null,
      headline: null,
      saidAt: null,
      tasks: 0,
      told: null,
      contextTokens: null,
    },
    session,
    command: {
      kind: "start",
      id: randomUUID(),
      agentId: agent.id,
      sessionId: session.id,
      resume: agent.hadSession,
      runtime: agent.runtime ?? "host",
      model: runsOn.model,
      ...(runsOn.effort !== null && { effort: runsOn.effort }),
      ...(text !== undefined && { text }),
      ...(clients && { context: { key: clients.key, version: clients.version, files: clients.files } }),
      ...(skills.length && { documents: skills }),
      ...(Object.keys(env).length && { env }),
      ...(credentials.length && { credentials }),
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
