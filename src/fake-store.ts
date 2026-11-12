import { DatabaseSync } from "node:sqlite";
import type { Host, Queued, Worker } from "./domain.ts";
import { Store, type Connection } from "./store.ts";

/**
 * The real store on a database in memory, with what the tests look at read
 * synchronously as maps. Each is a fresh reading: writing to one changes nothing.
 */
export class FakeStore extends Store {
  constructor() {
    super(new DatabaseSync(":memory:"));
  }

  get hosts(): Map<string, Host> {
    return this.byKey<Host>("SELECT id AS key, record FROM hosts");
  }

  get workers(): Map<string, Worker> {
    return new Map(
      this.db
        .prepare("SELECT id, rev, record FROM workers ORDER BY rowid")
        .all()
        .map((row) => [row.id as string, { ...(JSON.parse(row.record as string) as Worker), rev: row.rev as string }]),
    );
  }

  /** Each host's pending commands, as `pending` orders them; none for a host with none. */
  get commands(): Map<string, Queued[]> {
    const out = new (class extends Map<string, Queued[]> {
      override get(key: string) {
        return super.get(key) ?? [];
      }
    })();
    for (const row of this.db.prepare("SELECT host_id, record FROM pending ORDER BY rowid").all()) {
      const host = row.host_id as string;
      out.set(host, [...(out.get(host) ?? []), JSON.parse(row.record as string) as Queued]);
    }
    return out;
  }

  get sockets(): Map<string, Connection> {
    return this.byKey<Connection>("SELECT id AS key, record FROM connections");
  }

  get tickets(): Map<string, string> {
    return new Map(this.db.prepare("SELECT hash, valid_until FROM tickets").all().map((row) => [row.hash as string, row.valid_until as string]));
  }

  /** Writes a worker as it is, unguarded and claiming no name, as a record written by an older version would be. */
  plant(worker: Worker): void {
    const { rev: _, ...record } = worker;
    this.db.prepare("INSERT OR REPLACE INTO workers (id, rev, record) VALUES (?, ?, ?)").run(worker.id, "planted", JSON.stringify(record));
  }

  private byKey<T>(sql: string): Map<string, T> {
    return new Map(this.db.prepare(`${sql} ORDER BY key`).all().map((row) => [row.key as string, JSON.parse(row.record as string) as T]));
  }
}
