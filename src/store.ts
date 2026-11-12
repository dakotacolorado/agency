import { randomUUID } from "node:crypto";
import { backup, DatabaseSync } from "node:sqlite";
import { DURABLE, KEPT_FOR, unreported, type Host, type Queued, type Sent, type Session, type Worker } from "./domain.ts";
import type { TranscriptLine, UsageWindow, UsageWindowName } from "./schema.ts";
import type { Role } from "./roles.ts";
import type { WorkerRequest } from "./admission.ts";

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
export type SessionWrite = Omit<Session, "context" | "documents" | "skills" | "contextNote"> &
  Partial<Pick<Session, "context" | "documents" | "skills" | "contextNote">>;

/** What one request changes, written together or not at all. */
export interface Change {
  workers?: Worker[];
  /**
   * Each worker is written on condition its record still holds the `rev` it was
   * read with; otherwise the write fails as `Conflict`, to be read again.
   */
  guarded?: boolean;
  sessions?: SessionWrite[];
  queue?: { hostId: string; queued: Queued }[];
  /** A name taken by a new worker; the write fails as `NameTaken` if a worker not retired has it. */
  claim?: { name: string; workerId: string };
  release?: string;
  /** Commands taken off their host's queue in the same write, as `settle` does. */
  settled?: { hostId: string; sent: Sent }[];
}

export class NameTaken extends Error {}

/** A request written since it was read. */
export class Stale extends Error {}

/** A guarded worker written since it was read: read it again and redo the change. */
export class Conflict extends Error {}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS hosts (id TEXT PRIMARY KEY, record TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS workers (id TEXT PRIMARY KEY, rev TEXT NOT NULL, record TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS names (name TEXT PRIMARY KEY, worker_id TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS pending (
  host_id TEXT NOT NULL, id TEXT NOT NULL, queued_at TEXT NOT NULL, durable INTEGER NOT NULL, record TEXT NOT NULL,
  PRIMARY KEY (host_id, id)
);
CREATE TABLE IF NOT EXISTS sent (
  worker_id TEXT NOT NULL, id TEXT NOT NULL, queued_at TEXT NOT NULL, record TEXT NOT NULL,
  PRIMARY KEY (worker_id, id)
);
CREATE INDEX IF NOT EXISTS sent_by_queued ON sent (queued_at);
CREATE TABLE IF NOT EXISTS written (
  host_id TEXT NOT NULL, id TEXT NOT NULL, queued_at TEXT NOT NULL, record TEXT NOT NULL,
  PRIMARY KEY (host_id, id)
);
CREATE TABLE IF NOT EXISTS sessions (
  worker_id TEXT NOT NULL, id TEXT NOT NULL, started_at TEXT NOT NULL, record TEXT NOT NULL,
  PRIMARY KEY (worker_id, id)
);
CREATE TABLE IF NOT EXISTS transcript (
  worker_id TEXT NOT NULL, seq INTEGER NOT NULL, line TEXT NOT NULL,
  PRIMARY KEY (worker_id, seq)
);
CREATE TABLE IF NOT EXISTS connections (id TEXT PRIMARY KEY, record TEXT NOT NULL, replayed_at TEXT);
CREATE TABLE IF NOT EXISTS tickets (hash TEXT PRIMARY KEY, valid_until TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS usage (name TEXT PRIMARY KEY, read_at TEXT NOT NULL, record TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS roles (name TEXT PRIMARY KEY, record TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS requests (
  id TEXT PRIMARY KEY, rev TEXT NOT NULL, state TEXT NOT NULL, ended_at TEXT, record TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS worker_secrets (
  worker_id TEXT NOT NULL, name TEXT NOT NULL, value TEXT NOT NULL,
  PRIMARY KEY (worker_id, name)
);
`;

type Row = Record<string, unknown>;
const parse = <T>(row: Row | undefined, column = "record"): T | null => (row ? (JSON.parse(row[column] as string) as T) : null);
const all = <T>(rows: Row[], column = "record"): T[] => rows.map((row) => JSON.parse(row[column] as string) as T);

/**
 * Everything in one SQLite database, each record as its JSON beside the
 * columns it is found by. Every write is one synchronous statement or
 * transaction, so none interleaves with another; the methods stay async, as
 * the code above them awaits between a read and the write made from it, and a
 * guarded write refuses one whose worker changed meanwhile.
 *
 * Sockets do not outlive the process, so connections are emptied on open.
 */
export class Store {
  readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
    db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
    db.exec(SCHEMA);
    db.exec("DELETE FROM connections");
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

  /** The host's own record alone: its workers, transcripts and commands are kept apart from it. */
  async deleteHost(id: string): Promise<void> {
    this.db.prepare("DELETE FROM hosts WHERE id = ?").run(id);
  }

  async listHosts(): Promise<Host[]> {
    return all<Host>(this.db.prepare("SELECT record FROM hosts ORDER BY id").all());
  }

  async getWorker(id: string): Promise<Worker | null> {
    return this.worker(id);
  }

  async listWorkers(): Promise<Worker[]> {
    return this.db
      .prepare("SELECT rev, record FROM workers ORDER BY rowid")
      .all()
      .map((row) => ({ ...(JSON.parse(row.record as string) as Worker), rev: row.rev as string }));
  }

  protected worker(id: string): Worker | null {
    const row = this.db.prepare("SELECT rev, record FROM workers WHERE id = ?").get(id);
    return row ? { ...(JSON.parse(row.record as string) as Worker), rev: row.rev as string } : null;
  }

  async commit(change: Change): Promise<void> {
    this.transaction(() => {
      for (const { rev, ...worker } of change.workers ?? []) {
        if (change.guarded) {
          const held = this.db.prepare("SELECT rev FROM workers WHERE id = ?").get(worker.id) as { rev: string } | undefined;
          if (held?.rev !== rev) throw new Conflict(worker.id);
        }
        this.db
          .prepare("INSERT INTO workers (id, rev, record) VALUES (?, ?, ?) ON CONFLICT (id) DO UPDATE SET rev = excluded.rev, record = excluded.record")
          .run(worker.id, randomUUID(), JSON.stringify(worker));
      }
      for (const session of change.sessions ?? []) {
        const held = parse<Session>(this.db.prepare("SELECT record FROM sessions WHERE worker_id = ? AND id = ?").get(session.workerId, session.id));
        const fields = Object.fromEntries(Object.entries(session).filter(([, value]) => value !== undefined));
        const merged = { context: null, documents: [], skills: [], contextNote: null, ...held, ...fields } as Session;
        this.db
          .prepare("INSERT INTO sessions (worker_id, id, started_at, record) VALUES (?, ?, ?, ?) ON CONFLICT (worker_id, id) DO UPDATE SET record = excluded.record")
          .run(merged.workerId, merged.id, merged.startedAt, JSON.stringify(merged));
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
        const held = this.db.prepare("SELECT worker_id FROM names WHERE name = ?").get(change.claim.name) as { worker_id: string } | undefined;
        if (held && !(change.release === change.claim.name && held.worker_id === change.claim.workerId)) throw new NameTaken(change.claim.name);
        this.db.prepare("INSERT OR REPLACE INTO names (name, worker_id) VALUES (?, ?)").run(change.claim.name, change.claim.workerId);
      }
    });
  }

  /** In the order they were queued, which within one write is `queuedAt`'s. */
  async pending(hostId: string): Promise<Queued[]> {
    return all<Queued>(this.db.prepare("SELECT record FROM pending WHERE host_id = ? ORDER BY rowid").all(hostId));
  }

  /** Oldest first. */
  async written(hostId: string): Promise<Sent[]> {
    return all<Sent>(this.db.prepare("SELECT record FROM written WHERE host_id = ? ORDER BY queued_at, id").all(hostId));
  }

  /**
   * Off the host's queue for good, and on the worker's record as delivered,
   * written or withdrawn; a written command is held for its host's next word.
   */
  async settle(hostId: string, sent: Sent): Promise<void> {
    this.transaction(() => this.settling(hostId, sent));
  }

  /** Oldest first. */
  async sentTo(workerId: string): Promise<Sent[]> {
    return all<Sent>(this.db.prepare("SELECT record FROM sent WHERE worker_id = ? ORDER BY queued_at, id").all(workerId)).map((sent) => ({
      ...sent,
      taken: sent.taken ?? null,
    }));
  }

  /** Oldest first. */
  async sessionsOf(workerId: string): Promise<Session[]> {
    return all<Session>(this.db.prepare("SELECT record FROM sessions WHERE worker_id = ? ORDER BY started_at, rowid").all(workerId));
  }

  /** Keyed by `seq`, so a line sent again overwrites itself. */
  async putLines(workerId: string, lines: TranscriptLine[]): Promise<void> {
    this.transaction(() => {
      const put = this.db.prepare("INSERT OR REPLACE INTO transcript (worker_id, seq, line) VALUES (?, ?, ?)");
      for (const line of lines) put.run(workerId, line.seq, JSON.stringify(line));
    });
  }

  /** At most `limit` lines after `afterSeq`, in order; a negative `afterSeq` reads from the first line. */
  async readLines(workerId: string, afterSeq: number, limit: number): Promise<TranscriptLine[]> {
    return all<TranscriptLine>(
      this.db.prepare("SELECT line FROM transcript WHERE worker_id = ? AND seq > ? ORDER BY seq LIMIT ?").all(workerId, afterSeq, limit),
      "line",
    );
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

  async listRoles(): Promise<Role[]> {
    return all<Role>(this.db.prepare("SELECT record FROM roles ORDER BY name").all());
  }

  async putRole(role: Role): Promise<void> {
    this.db.prepare("INSERT OR REPLACE INTO roles (name, record) VALUES (?, ?)").run(role.name, JSON.stringify(role));
  }

  async listRequests(): Promise<WorkerRequest[]> {
    return this.db
      .prepare("SELECT rev, record FROM requests ORDER BY id")
      .all()
      .map((row) => ({ ...(JSON.parse(row.record as string) as WorkerRequest), rev: row.rev as string }));
  }

  async getRequest(id: string): Promise<WorkerRequest | null> {
    const row = this.db.prepare("SELECT rev, record FROM requests WHERE id = ?").get(id);
    return row ? { ...(JSON.parse(row.record as string) as WorkerRequest), rev: row.rev as string } : null;
  }

  /**
   * Written on condition its record still holds the `rev` it was read with (none, for a new one),
   * so of two writes made from one reading only the first lands; the second throws `Stale`.
   */
  async putRequest(request: WorkerRequest): Promise<WorkerRequest> {
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

  async putSecret(workerId: string, name: string, value: string): Promise<void> {
    this.db.prepare("INSERT OR REPLACE INTO worker_secrets (worker_id, name, value) VALUES (?, ?, ?)").run(workerId, name, value);
  }

  async getSecret(workerId: string, name: string): Promise<string | null> {
    const row = this.db.prepare("SELECT value FROM worker_secrets WHERE worker_id = ? AND name = ?").get(workerId, name) as { value: string } | undefined;
    return row?.value ?? null;
  }

  async removeSecrets(workerId: string, names: string[]): Promise<void> {
    const remove = this.db.prepare("DELETE FROM worker_secrets WHERE worker_id = ? AND name = ?");
    for (const name of names) remove.run(workerId, name);
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
        Number(this.db.prepare("DELETE FROM written WHERE queued_at < ?").run(before).changes) +
        Number(this.db.prepare("DELETE FROM requests WHERE ended_at IS NOT NULL AND ended_at < ?").run(before).changes) +
        Number(this.db.prepare("DELETE FROM tickets WHERE valid_until < ?").run(now.toISOString()).changes),
    );
  }

  protected record(sent: Sent): void {
    this.db
      .prepare("INSERT OR REPLACE INTO sent (worker_id, id, queued_at, record) VALUES (?, ?, ?, ?)")
      .run(sent.command.workerId, sent.command.id, sent.queuedAt, JSON.stringify(sent));
  }

  private settling(hostId: string, sent: Sent): void {
    this.db.prepare("DELETE FROM pending WHERE host_id = ? AND id = ?").run(hostId, sent.command.id);
    this.record(sent);
    if (sent.taken === false) {
      this.db.prepare("INSERT OR REPLACE INTO written (host_id, id, queued_at, record) VALUES (?, ?, ?, ?)").run(hostId, sent.command.id, sent.queuedAt, JSON.stringify(sent));
    } else {
      this.db.prepare("DELETE FROM written WHERE host_id = ? AND id = ?").run(hostId, sent.command.id);
    }
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
