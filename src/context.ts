import type { Skill } from "./skill.ts";
import { layReferences, overlay, type SkillRead } from "./skills.ts";

/** The document every session starts with. */
export const CONTEXT_KEY = "global";

/**
 * A copy of `global` with a proposal applied, as document-service's
 * `try:beta` writes one: given as a document, it is read in place of `global`,
 * so a proposed `global` can be tried before it merges.
 */
export const isGlobalTrial = (key: string) => key.startsWith(`proposal.${CONTEXT_KEY}.`);

/**
 * A start carries the context inside one socket message; this leaves the rest
 * of `MESSAGE_LIMIT` for the command around it and JSON's escaping.
 */
export const CONTEXT_LIMIT = 96 * 1024;

/**
 * A context its host reads over HTTP, when it is too large for the start:
 * well inside a Lambda response's 6 MB.
 */
export const FETCH_LIMIT = 1024 * 1024;

export interface ContextFile {
  path: string;
  content: string;
  executable: boolean;
}

/** A document's files at one version, as a session is given them. */
export interface SessionContext {
  key: string;
  version: number;
  files: ContextFile[];
}

/**
 * What a session starts with: its context, the documents it was made with
 * beside it, the environment its scripts need, and why any of them was left
 * out, if one was.
 */
export interface Attached extends Read {
  /** The addresses of the services it is given; their tokens go only to its host, with `credentials`. */
  env: Record<string, string>;
  credentials: string[];
  /** Of `credentials`, those the worker has a token of its own for. */
  ownCredentials: string[];
}

/** What document-service gave a session, and why it left out what it did. */
export interface Read {
  context: SessionContext | null;
  documents: SessionContext[];
  /** The services' skills laid over `context`'s files. */
  skills: SkillRead[];
  note: string | null;
  /** True when a document, a skill or a reference was left out for size. */
  cut?: true;
}

export interface ContextSource {
  /**
   * `documents` are read after `global`, in order; `skills` replace `global`'s files at their paths;
   * the whole is kept within `limit` bytes, `CONTEXT_LIMIT` unless said.
   */
  forSession(documents: string[], skills?: Skill[], limit?: number): Promise<Read>;
  /** Why a worker may not be made with `documents`, in document-service's words; null when it may. */
  refuse(documents: string[]): Promise<string | null>;
}

/** Nothing attached: tests, the dev server, and a stage deployed without the services' addresses. */
export const NO_CONTEXT: ContextSource = {
  forSession: async () => ({ context: null, documents: [], skills: [], note: "no context is configured" }),
  refuse: async (documents) => (documents.length ? "no document-service is configured, so no document can be given" : null),
};

export interface Service {
  url: string;
  token: { value(): Promise<string | null> };
}

/**
 * Reads the context from document-service. A document that cannot be read,
 * would take the context past its limit, or would write a file one before
 * it writes, is left out, and the session starts without it.
 */
export class ServiceContext implements ContextSource {
  private readonly documents: Service;
  private readonly fetchImpl: typeof globalThis.fetch;

  constructor(documents: Service, fetchImpl: typeof globalThis.fetch = globalThis.fetch) {
    this.documents = documents;
    this.fetchImpl = fetchImpl;
  }

  async forSession(documents: string[], skills: Skill[] = [], limit = CONTEXT_LIMIT): Promise<Read> {
    const ds = await this.documents.token.value();
    if (!ds) return { context: null, documents: [], skills: [], note: "document-service's token could not be read" };
    const trial = documents.find(isGlobalTrial);
    const [global, given] = await Promise.all([
      this.read(ds, trial ?? CONTEXT_KEY),
      Promise.all(documents.filter((key) => key !== trial).map((key) => this.read(ds, key))),
    ]);
    // A start without global keeps the context its host wrote last, so it is given nothing beside it.
    if (typeof global === "string") return { context: null, documents: [], skills: [], note: global };
    if (Buffer.byteLength(JSON.stringify(global)) > limit) {
      const bytes = Buffer.byteLength(JSON.stringify(global));
      return { context: null, documents: [], skills: [], note: `${CONTEXT_KEY} v${global.version} is ${bytes} bytes, over the ${limit} a start can carry`, cut: true };
    }
    // Clients first, then the documents beside global, then references with what room is left:
    // a worker can call a service without its reference, but not without its client or its role.
    const laid = overlay(global, skills, limit);
    const notes: string[] = [...laid.notes];
    let cut = laid.notes.length > 0;
    const taken: SessionContext[] = [];
    const paths = new Set([...laid.context.files, ...laid.references.flatMap((s) => s.files)].map((f) => f.path));
    let left = limit - Buffer.byteLength(JSON.stringify(laid.context));
    for (const doc of given) {
      if (typeof doc === "string") {
        notes.push(doc);
        continue;
      }
      const bytes = Buffer.byteLength(JSON.stringify(doc));
      const clash = doc.files.find((f) => f.path !== "CLAUDE.md" && paths.has(f.path));
      if (bytes > left) {
        notes.push(`${doc.key} v${doc.version} is ${bytes} bytes, over the ${left} left of the ${limit} a start can carry`);
        cut = true;
      } else if (clash) {
        notes.push(`${doc.key} v${doc.version} writes ${clash.path}, as a document before it does`);
      } else {
        taken.push(doc);
        left -= bytes;
        for (const f of doc.files) paths.add(f.path);
      }
    }
    const { context, notes: dropped } = layReferences(laid.context, laid.references, limit - taken.reduce((n, doc) => n + Buffer.byteLength(JSON.stringify(doc)), 0));
    notes.push(...dropped);
    if (dropped.length) cut = true;
    return { context, documents: taken, skills: laid.taken, note: notes.length ? notes.join("; ") : null, ...(cut && { cut: true as const }) };
  }

  async refuse(documents: string[]): Promise<string | null> {
    if (!documents.length) return null;
    const ds = await this.documents.token.value();
    if (!ds) return "document-service's token could not be read, so no document can be given";
    for (const key of documents) {
      try {
        const res = await this.get(ds, key);
        if (res.ok) continue;
        const said = ((await res.json().catch(() => null)) as { error?: string } | null)?.error;
        return `document-service answered ${res.status} for ${key}${said ? `: ${said}` : ""}`;
      } catch (err) {
        return `document-service could not be read: ${(err as Error).message}`;
      }
    }
    return null;
  }

  private get(token: string, key: string): Promise<Response> {
    return this.fetchImpl(`${this.documents.url.replace(/\/$/, "")}/documents/${encodeURIComponent(key)}`, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(5000),
    });
  }

  /** The document's latest version, or why it could not be read. */
  private async read(token: string, key: string): Promise<SessionContext | string> {
    try {
      const res = await this.get(token, key);
      if (!res.ok) return `document-service answered ${res.status} for ${key}`;
      const doc = (await res.json()) as { key: string; version: number; files?: ContextFile[] };
      return {
        key: doc.key,
        version: doc.version,
        files: (doc.files ?? []).map(({ path, content, executable }) => ({ path, content, executable: Boolean(executable) })),
      };
    } catch (err) {
      return `document-service could not be read for ${key}: ${(err as Error).message}`;
    }
  }
}
