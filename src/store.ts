import { randomUUID } from "node:crypto";
import { backup, DatabaseSync } from "node:sqlite";
import { DURABLE, KEPT_FOR, unreported, type Host, type Queued, type Sent, type Session, type Agent } from "./domain.ts";
import type { TranscriptLine, UsageWindow, UsageWindowName } from "./schema.ts";
import type { AgentRequest } from "./admission.ts";
import { tallied, type Tally } from "./sessions.ts";

export interface Connection {
  connectionId: string;
  kind: "host" | "viewer";
  hostId?: string;
  connectedAt: string;
}

/**
 * A session as a change writes it: whole when it begins, and only its ending
 * when it ends, so what it began with is kept.
 */
export type SessionWrite = Omit<Session, "skills" | "clients" | "contextNote"> & Partial<Pick<Session, "skills" | "clients" | "contextNote">>;

/** What one request changes, written together or not at all. */
export interface Change {
  agents?: Agent[];
  /**
   * Each agent is written on condition its record still holds the `rev` it was
   * read with; otherwise the write fails as `Conflict`, to be read again.
   */
  guarded?: boolean;
  sessions?: SessionWrite[];
  /** Merged into each live session's record after `sessions`; one on no session on record changes nothing. */
  tallies?: Tally[];
  queue?: { hostId: string; queued: Queued }[];
  /** A name taken by a new agent; the write fails as `NameTaken` if an agent not deleted has it. */
  claim?: { name: string; agentId: string };
  release?: string;
  /** Commands taken off their host's queue in the same write, as `settle` does. */
  settled?: { hostId: string; sent: Sent }[];
}

export interface SessionFilter {
  agentId?: string;
  item?: string;
  role?: string;
  since?: string;
  until?: string;
}

export class NameTaken extends Error {}

/** A request written since it was read. */
export class Stale extends Error {}

/** A request for an item someone is on already: `on` names them. */
export class Taken extends Error {
  readonly on: string[];
  constructor(on: string[]) {
    super(on.join(", "));
    this.on = on;
  }
}

/** A guarded agent written since it was read: read it again and redo the change. */
export class Conflict extends Error {}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS hosts (id TEXT PRIMARY KEY, record TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS agents (id TEXT PRIMARY KEY, rev TEXT NOT NULL, record TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS names (name TEXT PRIMARY KEY, agent_id TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS pending (
  host_id TEXT NOT NULL, id TEXT NOT NULL, queued_at TEXT NOT NULL, durable INTEGER NOT NULL, record TEXT NOT NULL,
  PRIMARY KEY (host_id, id)
);
CREATE TABLE IF NOT EXISTS sent (
  agent_id TEXT NOT NULL, id TEXT NOT NULL, queued_at TEXT NOT NULL, record TEXT NOT NULL,
  PRIMARY KEY (agent_id, id)
);
CREATE INDEX IF NOT EXISTS sent_by_queued ON sent (queued_at);
CREATE TABLE IF NOT EXISTS sessions (
  agent_id TEXT NOT NULL, id TEXT NOT NULL, started_at TEXT NOT NULL, record TEXT NOT NULL,
  PRIMARY KEY (agent_id, id)
);
CREATE TABLE IF NOT EXISTS transcript (
  agent_id TEXT NOT NULL, seq INTEGER NOT NULL, line TEXT NOT NULL,
  PRIMARY KEY (agent_id, seq)
);
CREATE TABLE IF NOT EXISTS connections (id TEXT PRIMARY KEY, record TEXT NOT NULL, replayed_at TEXT);
CREATE TABLE IF NOT EXISTS tickets (hash TEXT PRIMARY KEY, valid_until TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS usage (name TEXT PRIMARY KEY, read_at TEXT NOT NULL, record TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS requests (
  id TEXT PRIMARY KEY, rev TEXT NOT NULL, state TEXT NOT NULL, ended_at TEXT, record TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS skill_copies (name TEXT PRIMARY KEY, version INTEGER NOT NULL, record TEXT NOT NULL);
`;

type Row = Record<string, unknown>;
const parse = <T>(row: Row | undefined, column = "record"): T | null => (row ? (JSON.parse(row[column] as string) as T) : null);
const all = <T>(rows: Row[], column = "record"): T[] => rows.map((row) => JSON.parse(row[column] as string) as T);

/**
 * Everything in one SQLite database, each record as its JSON beside the
 * columns it is found by. Every write is one synchronous statement or
 * transaction, so none interleaves with another; the methods stay async, as
 * the code above them awaits between a read and the write made from it, and a
 * guarded write refuses one whose agent changed meanwhile.
 */
export class Store {
  readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
    db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
    db.exec(SCHEMA);
    // Roles now live in honed, agents have no tokens of their own, and a message is delivered or not: a database from before keeps none of those tables.
    db.exec("DROP TABLE IF EXISTS roles; DROP TABLE IF EXISTS agent_secrets; DROP TABLE IF EXISTS written;");
    // An agent was once retired, not deleted: a database from before says so in its records.
    db.exec(`
      UPDATE agents SET record = json_set(record, '$.state', 'deleted') WHERE json_extract(record, '$.state') = 'retired';
      UPDATE agents SET record = json_set(record, '$.whenDone', 'delete') WHERE json_extract(record, '$.whenDone') = 'retire';
      UPDATE pending SET record = json_set(record, '$.command.kind', 'delete') WHERE json_extract(record, '$.command.kind') = 'retire';
      UPDATE sent SET record = json_set(record, '$.command.kind', 'delete') WHERE json_extract(record, '$.command.kind') = 'retire';
    `);
    // A session from before its record kept who ran it and its tokens takes them from its agent: its name now, its tokens as counted.
    db.exec(`
      UPDATE sessions SET record = json_set(sessions.record,
        '$.agentName', json_extract(agents.record, '$.name'),
        '$.role', json_extract(agents.record, '$.role'),
        '$.item', json_extract(agents.record, '$.item'),
        '$.tokens', json(coalesce(json_extract(agents.record, '$.sessionTokens."' || sessions.id || '"'),
          '{"inputTokens":0,"outputTokens":0,"cacheCreationInputTokens":0,"cacheReadInputTokens":0}')))
      FROM agents WHERE agents.id = sessions.agent_id AND json_extract(sessions.record, '$.agentName') IS NULL;
      CREATE INDEX IF NOT EXISTS sessions_by_started ON sessions (started_at);
    `);
  }

  /** The database at `path`, made if absent; `:memory:` for one that lasts as long as the process. */
  static open(path: string): Store {
    return new Store(new DatabaseSync(path));
  }

  close(): void {
    if (this.db.isOpen) this.db.close();
  }

  /** Copies the database to `file`, consistent while it is written to; answers the pages copied. */
  async backup(file: string): Promise<number> {
    return backup(this.db, file);
  }

  async putHost(host: Host): Promise<void> {
    this.db.prepare("INSERT INTO hosts (id, record) VALUES (?, ?) ON CONFLICT (id) DO UPDATE SET record = excluded.record").run(host.id, JSON.stringify(host));
  }

  async getHost(id: string): Promise<Host | null> {
    return parse<Host>(this.db.prepare("SELECT record FROM hosts WHERE id = ?").get(id));
  }

  /** The host's own record alone: its agents, transcripts and commands are kept apart from it. */
  async deleteHost(id: string): Promise<void> {
    this.db.prepare("DELETE FROM hosts WHERE id = ?").run(id);
  }

  async listHosts(): Promise<Host[]> {
    return all<Host>(this.db.prepare("SELECT record FROM hosts ORDER BY id").all());
  }

  async getAgent(id: string): Promise<Agent | null> {
    return this.agent(id);
  }

  async listAgents(): Promise<Agent[]> {
    return this.db
      .prepare("SELECT rev, record FROM agents ORDER BY rowid")
      .all()
      .map((row) => ({ ...(JSON.parse(row.record as string) as Agent), rev: row.rev as string }));
  }

  protected agent(id: string): Agent | null {
    const row = this.db.prepare("SELECT rev, record FROM agents WHERE id = ?").get(id);
    return row ? { ...(JSON.parse(row.record as string) as Agent), rev: row.rev as string } : null;
  }

  async commit(change: Change): Promise<void> {
    this.transaction(() => {
      for (const { rev, ...agent } of change.agents ?? []) {
        if (change.guarded) {
          const held = this.db.prepare("SELECT rev FROM agents WHERE id = ?").get(agent.id) as { rev: string } | undefined;
          if (held?.rev !== rev) throw new Conflict(agent.id);
        }
        this.db
          .prepare("INSERT INTO agents (id, rev, record) VALUES (?, ?, ?) ON CONFLICT (id) DO UPDATE SET rev = excluded.rev, record = excluded.record")
          .run(agent.id, randomUUID(), JSON.stringify(agent));
      }
      for (const session of change.sessions ?? []) {
        const held = parse<Session>(this.db.prepare("SELECT record FROM sessions WHERE agent_id = ? AND id = ?").get(session.agentId, session.id));
        const fields = Object.fromEntries(Object.entries(session).filter(([, value]) => value !== undefined));
        const merged = { skills: [], clients: null, contextNote: null, ...held, ...fields } as Session;
        this.db
          .prepare("INSERT INTO sessions (agent_id, id, started_at, record) VALUES (?, ?, ?, ?) ON CONFLICT (agent_id, id) DO UPDATE SET record = excluded.record")
          .run(merged.agentId, merged.id, merged.startedAt, JSON.stringify(merged));
      }
      for (const tally of change.tallies ?? []) {
        const held = parse<Session>(this.db.prepare("SELECT record FROM sessions WHERE agent_id = ? AND id = ?").get(tally.agentId, tally.sessionId));
        if (!held) continue;
        this.db.prepare("UPDATE sessions SET record = ? WHERE agent_id = ? AND id = ?").run(JSON.stringify(tallied(held, tally)), tally.agentId, tally.sessionId);
      }
      for (const { hostId, queued } of change.queue ?? []) {
        this.db
          .prepare("INSERT OR REPLACE INTO pending (host_id, id, queued_at, durable, record) VALUES (?, ?, ?, ?, ?)")
          .run(hostId, queued.command.id, queued.queuedAt, DURABLE.includes(queued.command.kind) ? 1 : 0, JSON.stringify(queued));
        this.record(unreported(queued));
      }
      for (const { hostId, sent } of change.settled ?? []) this.settling(hostId, sent);
      if (change.release && change.release !== change.claim?.name) this.db.prepare("DELETE FROM names WHERE name = ?").run(change.release);
      if (change.claim) {
        const held = this.db.prepare("SELECT agent_id FROM names WHERE name = ?").get(change.claim.name) as { agent_id: string } | undefined;
        if (held && !(change.release === change.claim.name && held.agent_id === change.claim.agentId)) throw new NameTaken(change.claim.name);
        this.db.prepare("INSERT OR REPLACE INTO names (name, agent_id) VALUES (?, ?)").run(change.claim.name, change.claim.agentId);
      }
    });
  }

  /** In the order they were queued, which within one write is `queuedAt`'s. */
  async pending(hostId: string): Promise<Queued[]> {
    return all<Queued>(this.db.prepare("SELECT record FROM pending WHERE host_id = ? ORDER BY rowid").all(hostId));
  }

  /**
   * Off the host's queue for good, and on the agent's record as delivered,
   * written or withdrawn; a written command is held for its host's next word.
   */
  async settle(hostId: string, sent: Sent): Promise<void> {
    this.transaction(() => this.settling(hostId, sent));
  }

  /** Oldest first. */
  async sentTo(agentId: string): Promise<Sent[]> {
    return all<Sent>(this.db.prepare("SELECT record FROM sent WHERE agent_id = ? ORDER BY queued_at, id").all(agentId));
  }

  /** Oldest first. */
  async sessionsOf(agentId: string): Promise<Session[]> {
    return all<Session>(this.db.prepare("SELECT record FROM sessions WHERE agent_id = ? ORDER BY started_at, rowid").all(agentId));
  }

  async getSession(agentId: string, id: string): Promise<Session | null> {
    return parse<Session>(this.db.prepare("SELECT record FROM sessions WHERE agent_id = ? AND id = ?").get(agentId, id));
  }

  /** Every session not ended, by its agent's id. */
  async liveSessions(): Promise<Map<string, Session>> {
    return new Map(
      all<Session>(this.db.prepare("SELECT record FROM sessions WHERE json_extract(record, '$.endedAt') IS NULL ORDER BY started_at, rowid").all()).map((s) => [s.agentId, s]),
    );
  }

  /** Newest first, kept whatever became of their agents; `since` and `until` bound `startedAt`, `until` excluded. */
  async listSessions(filter: SessionFilter = {}): Promise<Session[]> {
    const where: string[] = [];
    const args: string[] = [];
    const on = (sql: string, value: string | undefined) => {
      if (value === undefined) return;
      where.push(sql);
      args.push(value);
    };
    on("agent_id = ?", filter.agentId);
    on("json_extract(record, '$.item') = ?", filter.item);
    on("json_extract(record, '$.role') = ?", filter.role);
    on("started_at >= ?", filter.since);
    on("started_at < ?", filter.until);
    const sql = `SELECT record FROM sessions ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY started_at DESC, agent_id DESC, id DESC`;
    return all<Session>(this.db.prepare(sql).all(...args));
  }

  /** Keyed by `seq`, so a line sent again overwrites itself. */
  async putLines(agentId: string, lines: TranscriptLine[]): Promise<void> {
    this.transaction(() => {
      const put = this.db.prepare("INSERT OR REPLACE INTO transcript (agent_id, seq, line) VALUES (?, ?, ?)");
      for (const line of lines) put.run(agentId, line.seq, JSON.stringify(line));
    });
  }

  /** At most `limit` lines after `afterSeq`, in order; a negative `afterSeq` reads from the first line. */
  async readLines(agentId: string, afterSeq: number, limit: number): Promise<TranscriptLine[]> {
    return all<TranscriptLine>(
      this.db.prepare("SELECT line FROM transcript WHERE agent_id = ? AND seq > ? ORDER BY seq LIMIT ?").all(agentId, afterSeq, limit),
      "line",
    );
  }

  /** Every socket on record, for the process that serves to call as it starts: no socket outlives the one that held it. */
  forgetConnections(): void {
    this.db.exec("DELETE FROM connections");
  }

  async putConnection(connection: Connection): Promise<void> {
    this.db.prepare("INSERT OR REPLACE INTO connections (id, record, replayed_at) VALUES (?, ?, NULL)").run(connection.connectionId, JSON.stringify(connection));
  }

  async deleteConnection(connectionId: string): Promise<void> {
    this.db.prepare("DELETE FROM connections WHERE id = ?").run(connectionId);
  }

  /**
   * True once per connection, for whichever message first claims it, so two
   * messages arriving together do not both replay its host's queue. False
   * for a connection not on record.
   */
  async claimReplay(connectionId: string, at: string): Promise<boolean> {
    const { changes } = this.db.prepare("UPDATE connections SET replayed_at = ? WHERE id = ? AND replayed_at IS NULL").run(at, connectionId);
    return changes === 1;
  }

  async getConnection(connectionId: string): Promise<Connection | null> {
    return parse<Connection>(this.db.prepare("SELECT record FROM connections WHERE id = ?").get(connectionId));
  }

  async connections(): Promise<Connection[]> {
    return all<Connection>(this.db.prepare("SELECT record FROM connections ORDER BY id").all());
  }

  async putTicket(hash: string, validUntil: string): Promise<void> {
    this.db.prepare("INSERT OR REPLACE INTO tickets (hash, valid_until) VALUES (?, ?)").run(hash, validUntil);
  }

  /** Deleted as it is read, so a ticket is good once however many sockets present it. */
  async takeTicket(hash: string): Promise<string | null> {
    const row = this.db.prepare("DELETE FROM tickets WHERE hash = ? RETURNING valid_until").get(hash) as { valid_until: string } | undefined;
    return row?.valid_until ?? null;
  }

  /**
   * Kept only if it is newer than the window's reading on record, so two hosts
   * reporting together leave the newer. True when it was kept.
   */
  async putUsage(name: UsageWindowName, window: UsageWindow): Promise<boolean> {
    const { changes } = this.db
      .prepare("INSERT INTO usage (name, read_at, record) VALUES (?, ?, ?) ON CONFLICT (name) DO UPDATE SET read_at = excluded.read_at, record = excluded.record WHERE usage.read_at < excluded.read_at")
      .run(name, window.readAt, JSON.stringify(window));
    return changes === 1;
  }

  async usage(): Promise<Partial<Record<UsageWindowName, UsageWindow>>> {
    return Object.fromEntries(
      this.db
        .prepare("SELECT name, record FROM usage")
        .all()
        .map((row) => [row.name as UsageWindowName, JSON.parse(row.record as string) as UsageWindow]),
    );
  }





  async listRequests(): Promise<AgentRequest[]> {
    return this.db
      .prepare("SELECT rev, record FROM requests ORDER BY id")
      .all()
      .map((row) => ({ ...(JSON.parse(row.record as string) as AgentRequest), rev: row.rev as string }));
  }

  async getRequest(id: string): Promise<AgentRequest | null> {
    const row = this.db.prepare("SELECT rev, record FROM requests WHERE id = ?").get(id);
    return row ? { ...(JSON.parse(row.record as string) as AgentRequest), rev: row.rev as string } : null;
  }

  /**
   * Written on condition its record still holds the `rev` it was read with (none, for a new one),
   * so of two writes made from one reading only the first lands; the second throws `Stale`.
   */
  async putRequest(request: AgentRequest): Promise<AgentRequest> {
    return this.putRequestNow(request);
  }

  private putRequestNow(request: AgentRequest): AgentRequest {
    const { rev, ...fields } = request;
    const written = { ...fields, rev: randomUUID() };
    const endedAt = request.state === "waiting" ? null : (request.withdrawnAt ?? request.startedAt ?? new Date().toISOString());
    return this.transaction(() => {
      const held = this.db.prepare("SELECT rev FROM requests WHERE id = ?").get(request.id) as { rev: string } | undefined;
      if (held?.rev !== rev) throw new Stale(request.id);
      this.db
        .prepare("INSERT OR REPLACE INTO requests (id, rev, state, ended_at, record) VALUES (?, ?, ?, ?, ?)")
        .run(request.id, written.rev, request.state, endedAt, JSON.stringify(fields));
      return written;
    });
  }

  /**
   * Records a new request unless its item already has someone on it: an agent neither deleted nor
   * `done`, a request waiting, or one started at or after `startedSince` whose agent is not made yet.
   * The check and the write are one transaction, so of two made at once for one item only the first
   * lands; the second throws `Taken` naming who is on it.
   */
  async addRequestUnlessTaken(request: AgentRequest, startedSince: string): Promise<AgentRequest> {
    return this.transaction(() => {
      if (request.item !== null) {
        const on = this.onItem(request.item, startedSince);
        if (on.length) throw new Taken(on);
      }
      return this.putRequestNow(request);
    });
  }

  /** Who is on `item`, as `addRequestUnlessTaken` counts them: agents by name, requests as `<role> request <first 8 of its id>`. */
  protected onItem(item: string, startedSince: string): string[] {
    const agents = this.db
      .prepare(
        `SELECT json_extract(record, '$.name') AS name FROM agents
         WHERE json_extract(record, '$.item') = ? AND json_extract(record, '$.state') <> 'deleted'
           AND coalesce(json_extract(record, '$.status'), '') <> 'done'
         ORDER BY rowid`,
      )
      .all(item)
      .map((row) => row.name as string);
    const requests = this.db
      .prepare(
        `SELECT id, json_extract(record, '$.role') AS role FROM requests
         WHERE json_extract(record, '$.item') = ?
           AND (state = 'waiting'
             OR (state = 'started' AND json_extract(record, '$.startedAt') >= ? AND NOT EXISTS (SELECT 1 FROM agents WHERE agents.id = requests.id)))
         ORDER BY json_extract(record, '$.createdAt')`,
      )
      .all(item, startedSince)
      .map((row) => `${row.role as string} request ${(row.id as string).slice(0, 8)}`);
    return [...agents, ...requests];
  }

  /** The last copy of a skill read whole, for a start to fall back on when its source does not answer. */
  async keepCopy(name: string, version: number, copy: unknown): Promise<void> {
    this.db.prepare("INSERT OR REPLACE INTO skill_copies (name, version, record) VALUES (?, ?, ?)").run(name, version, JSON.stringify(copy));
  }

  async copyOf<T>(name: string): Promise<T | null> {
    return parse<T>(this.db.prepare("SELECT record FROM skill_copies WHERE name = ?").get(name));
  }







  /**
   * Forgets what ages out `KEPT_FOR` after it was queued or ended: every
   * command's record, a command not durable still pending, a request started
   * or withdrawn, and a spent ticket. Answers how many rows went.
   */
  prune(now: Date): number {
    const before = new Date(now.getTime() - KEPT_FOR * 1000).toISOString();
    return this.transaction(
      () =>
        Number(this.db.prepare("DELETE FROM sent WHERE queued_at < ?").run(before).changes) +
        Number(this.db.prepare("DELETE FROM pending WHERE durable = 0 AND queued_at < ?").run(before).changes) +
        Number(this.db.prepare("DELETE FROM requests WHERE ended_at IS NOT NULL AND ended_at < ?").run(before).changes) +
        Number(this.db.prepare("DELETE FROM tickets WHERE valid_until < ?").run(now.toISOString()).changes),
    );
  }

  protected record(sent: Sent): void {
    this.db
      .prepare("INSERT OR REPLACE INTO sent (agent_id, id, queued_at, record) VALUES (?, ?, ?, ?)")
      .run(sent.command.agentId, sent.command.id, sent.queuedAt, JSON.stringify(sent));
  }

  private settling(hostId: string, sent: Sent): void {
    this.db.prepare("DELETE FROM pending WHERE host_id = ? AND id = ?").run(hostId, sent.command.id);
    this.record(sent);
  }

  /** Nested calls join the outer transaction. */
  protected transaction<T>(body: () => T): T {
    if (this.db.isTransaction) return body();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = body();
      this.db.exec("COMMIT");
      return result;
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }
}
