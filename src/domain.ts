import type { Command } from "./schema.ts";

/**
 * A brief or a message is a whole prompt, so kilobytes, not a line. Commands
 * reach a host only by socket, and JSON may spend six bytes on a character,
 * so this keeps the longest well inside `MESSAGE_LIMIT`.
 */
export const TEXT_LIMIT = 16384;

/**
 * The most of one transcript line's text kept, in characters: far past the
 * longest reply a person reads. A host cuts sooner, to fit its socket message; see `cut`.
 */
export const LINE_LIMIT = 65536;

/**
 * A line's text as it is kept: whole up to `LINE_LIMIT` characters, and otherwise
 * as much as fits ending in a note of how much that is of how much there was,
 * so a reader knows it was cut. The one shape for a cut text, which a host
 * cutting its own uses too.
 */
export function cut(text: string): string {
  const chars = [...text];
  if (chars.length <= LINE_LIMIT) return text;
  const note = (kept: number) => `… [cut: ${kept} of ${chars.length} characters]`;
  const kept = LINE_LIMIT - [...note(LINE_LIMIT)].length;
  return chars.slice(0, kept).join("") + note(kept);
}

export interface Host {
  id: string;
  heartbeatAt: string;
  version: string | null;
  labels: string[];
  /** Null until the host says how many sessions it will run. */
  capacity: number | null;
}

export const HEARTBEAT_INTERVAL = 30;

/** Silent this long, a host is lost; see `hostStatus`. */
export const LOST_AFTER = 10 * HEARTBEAT_INTERVAL;

export const HOST_STATUSES = ["connected", "disconnected", "lost"] as const;

export type HostStatus = (typeof HOST_STATUSES)[number];

/**
 * Worked out on every read and never stored: a stored verdict is only as fresh
 * as the last write, and a host that stops sending heartbeats writes nothing. One
 * missed heartbeat is disconnected, not lost, because one in flight is not yet missed.
 */
export function hostStatus(heartbeatAt: string, now: Date): HostStatus {
  const silent = (now.getTime() - Date.parse(heartbeatAt)) / 1000;
  if (silent <= 2 * HEARTBEAT_INTERVAL) return "connected";
  if (silent <= LOST_AFTER) return "disconnected";
  return "lost";
}

/** The states of an agent with a live session. */
export const LIVE_STATES = ["working", "waiting"] as const;

export const REPORTED_STATES = ["idle", ...LIVE_STATES, "interrupted"] as const;

export type ReportedState = (typeof REPORTED_STATES)[number];

/** `retired` is never reported by a host: it is the service's, set by `DELETE`. */
export const AGENT_STATES = [...REPORTED_STATES, "retired"] as const;

export type AgentState = (typeof AGENT_STATES)[number];

export const isLive = (state: string) => (LIVE_STATES as readonly string[]).includes(state);

export type LiveState = (typeof LIVE_STATES)[number];

/** What an agent, or approval-service, may say of it: see `statusOf` for what is served. */
export const SAID = ["working", "waiting", "review", "done"] as const;

export type Said = (typeof SAID)[number];

/**
 * An agent's status as served: `review` and `done` as said, `waiting` while it
 * has said it needs the person, and otherwise, with a live session, `working`
 * while a turn or a background task of its runs and `idle` once neither does.
 */
export const STATUSES = ["working", "idle", "waiting", "review", "done"] as const;

export type Status = (typeof STATUSES)[number];

/** What becomes of an agent once it says it is done: it stays, its session is stopped, or it is retired. */
export const WHEN_DONE = ["keep", "stop", "retire"] as const;

export type WhenDone = (typeof WHEN_DONE)[number];

export const SUMMARY_LIMIT = 280;

/** Short enough to fit on one line of an agent's card. */
export const HEADLINE_LIMIT = 29;

export const TITLE_LIMIT = 40;

export const LABEL_LIMIT = 40;

/** A work item's id: a UUID, with room to spare. */
export const ITEM_LIMIT = 64;

/** Who made an agent, as the `claimed-by` header said it: a person's name or a service's. */
export const MAKER_LIMIT = 200;

/** Short enough for one line of a card. */
export const ACTIVITY_LIMIT = 120;

export interface Activity {
  text: string;
  at: string;
}

const shortened = (text: string) => {
  const chars = [...text.trim()];
  return chars.length <= ACTIVITY_LIMIT ? chars.join("") : `${chars.slice(0, ACTIVITY_LIMIT - 1).join("")}…`;
};

/** The last two segments of a path, which say what it is without where everything is. */
const tail = (path: string) => path.split("/").filter(Boolean).slice(-2).join("/");

/**
 * What a transcript line says the agent is doing, for its card: never a
 * command, a tool's whole input, or anything the person said. A tool line is
 * `<tool> <input as JSON>` (see `LineReport`), its input maybe cut and so unreadable.
 */
export function activityOf(from: string, text: string): string | null {
  if (from === "agent") {
    const first = text.split("\n").find((line) => line.trim());
    return first ? shortened(first) : null;
  }
  if (from !== "tool") return null;
  const space = text.indexOf(" ");
  const tool = space < 0 ? text : text.slice(0, space);
  let input: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(text.slice(space + 1));
    if (parsed && typeof parsed === "object") input = parsed as Record<string, unknown>;
  } catch {
    // Cut, so read by its name alone.
  }
  const str = (key: string) => (typeof input[key] === "string" && (input[key] as string).trim() ? (input[key] as string) : null);
  const target = (() => {
    switch (tool) {
      case "Bash":
        return str("description");
      case "Read":
      case "Edit":
      case "Write":
      case "NotebookEdit":
        return str("file_path") && tail(str("file_path")!);
      case "Grep":
      case "Glob":
        return str("path") && tail(str("path")!);
      case "Agent":
      case "Task":
        return str("description");
      case "Skill":
        return str("skill");
      case "WebFetch": {
        try {
          return new URL(str("url") ?? "").host;
        } catch {
          return null;
        }
      }
      default:
        return null;
    }
  })();
  if (tool === "Bash") return shortened(target ?? "Ran a command");
  return shortened(target ? `${tool} ${target}` : tool);
}

export interface SessionRef {
  id: string;
  startedAt: string;
}

export interface Agent {
  id: string;
  name: string;
  hostId: string;
  state: AgentState;
  session: SessionRef | null;
  createdAt: string;
  reportedAt: string | null;
  /** What it named itself for its work; kept across sessions. */
  title?: string | null;
  /** Records written before these fields lack them. */
  label?: string | null;
  /** The work item it was started on; never changes. */
  item?: string | null;
  /** The role it was made from; never changes. Null for one made without. */
  role?: string | null;
  createdBy?: string | null;
  whenDone?: WhenDone;
  /** Document keys each session reads after `global`. */
  documents?: string[];
  /** The services each session is given, by name; absent, the stage's defaults. */
  credentials?: string[];
  /** Of `credentials`, those given a value of the agent's own, kept in `AgentSecrets`; never served. */
  ownCredentials?: string[];
  /** Kept so a start knows whether to resume without reading the sessions; never served. */
  hadSession: boolean;
  /** The session its host has reported it started; never served. */
  begun?: string | null;
  /** Background tasks and subagents its live session has open, as its host last said; 0 without one. */
  tasks?: number;
  /** Whether its live session's current or last turn began with a message delivered to it; null when its host has not said. */
  told?: boolean | null;
  /** What was last said of it; null without a live session, unless `review` or `done`. Records written before these fields lack them. */
  status?: Said | null;
  summary?: string | null;
  headline?: string | null;
  /** When `status` and `summary` were said; null once a message or a new session clears them. */
  saidAt?: string | null;
  /** What its latest transcript line says it was doing; see `activityOf`. Records written before it lack it. */
  activity?: Activity | null;
  /** Each session's running total, by session id, the highest of each count its host reported; served summed as `tokens`. */
  sessionTokens?: Record<string, Tokens>;
  /** Replaced on every write, so a write made on condition of what it read fails once another lands; never served. */
  rev?: string;
}

export const TOKEN_FIELDS = ["inputTokens", "outputTokens", "cacheCreationInputTokens", "cacheReadInputTokens"] as const;

export type Tokens = Record<(typeof TOKEN_FIELDS)[number], number>;

export const NO_TOKENS: Tokens = { inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 };

/**
 * Each count the higher of the two, as a session's totals only grow: a total
 * sent again, or arriving after a later one, changes nothing.
 */
export const highest = (held: Tokens, reported: Tokens): Tokens =>
  Object.fromEntries(TOKEN_FIELDS.map((f) => [f, Math.max(held[f], reported[f])])) as Tokens;

export const summed = (sessions: Record<string, Tokens> | undefined): Tokens =>
  Object.values(sessions ?? {}).reduce(
    (sum, each) => Object.fromEntries(TOKEN_FIELDS.map((f) => [f, sum[f] + each[f]])) as Tokens,
    NO_TOKENS,
  );

/** What an agent says that outlasts its session: it is done, or its change is in review. */
export const keepsPastSession = (status: Said | null | undefined): status is "review" | "done" =>
  status === "review" || status === "done";

/**
 * What an agent that has said it is done, or in review, keeps once its session
 * ends, so a caller can tell finished from died; anything else it said goes
 * with the session.
 */
export const afterSession = (agent: Agent): Pick<Agent, "status" | "summary" | "headline" | "saidAt" | "tasks" | "told"> => ({
  tasks: 0,
  told: null,
  ...(keepsPastSession(agent.status)
    ? { status: agent.status, summary: agent.summary ?? null, headline: agent.headline ?? null, saidAt: agent.saidAt ?? null }
    : { status: null }),
});

/** Neither a turn nor a background task of its is running. */
export const quiet = (agent: Agent): boolean => agent.state !== "working" && !(agent.tasks ?? 0);

export function statusOf(agent: Agent): Status | null {
  if (keepsPastSession(agent.status)) return agent.status;
  if (!isLive(agent.state)) return null;
  if (agent.status === "waiting") return "waiting";
  return quiet(agent) ? "idle" : "working";
}

/** What its maker asked be done with an agent once it is quiet in `review` or `done`. */
export function onceQuiet(agent: Agent): "stop" | "retire" | null {
  const whenDone = agent.whenDone ?? "keep";
  if (agent.status === "done" && whenDone !== "keep") return whenDone;
  // In review it waits on approval-service, whose send-back must still reach it: stopped, never retired.
  if (agent.status === "review" && whenDone !== "keep") return "stop";
  return null;
}

/** Cleared by a message from the person, or a new session: what was said goes, and the agent is at work. */
export const cleared = { status: "working", summary: null, headline: null, saidAt: null } as const;

export const SESSION_ENDINGS = ["stopped", "interrupted"] as const;

export type SessionEnding = (typeof SESSION_ENDINGS)[number];

export interface Session {
  id: string;
  agentId: string;
  startedAt: string;
  endedAt: string | null;
  ended: SessionEnding | null;
  /** The context it was given, by document and version; null when it was given none. */
  context: { key: string; version: number } | null;
  /** The documents it was given beside the context; none on a session recorded before them. */
  documents: { key: string; version: number }[];
  /** The services' clients laid over the context's files; none on a session recorded before them. */
  skills: { key: string; version: number; commit: string }[];
  /** Why it was given no context, or a document or skill was left out. */
  contextNote: string | null;
}

/** A host's places are its sessions: an agent with none holds no place. */
export const available = (host: Host, agents: Agent[]): number | null =>
  host.capacity === null
    ? null
    : Math.max(
        0,
        host.capacity - agents.filter((w) => w.hostId === host.id && w.session !== null).length,
      );

/**
 * One rule for everything sent to a host: only a lost or deregistered host is
 * refused, since a disconnected one usually sends a heartbeat again soon. Null
 * when it can be reached; otherwise why not.
 */
export function unreachable(host: Host | null, hostId: string, now: Date): string | null {
  if (!host) return `${hostId} has been deregistered and has not sent a heartbeat since.`;
  return hostStatus(host.heartbeatAt, now) === "lost"
    ? `${host.id} has not sent a heartbeat since ${host.heartbeatAt}.`
    : null;
}

export interface Queued {
  command: Command;
  queuedAt: string;
}

/** A command as it went, and what its host said of it once it did. */
export interface Sent extends Queued {
  reportedAt: string | null;
  ok: boolean | null;
  error: string | null;
  /** False while its text is written to its agent's session and not yet taken; null otherwise. */
  taken?: false | null;
  /** Taken off its host's queue by the service, because its agent was force-stopped. */
  withdrawnAt: string | null;
}

export const unreported = (queued: Queued): Sent => ({
  ...queued,
  reportedAt: null,
  ok: null,
  error: null,
  withdrawnAt: null,
});

/**
 * Every command's record is deleted this long after it was queued, so a
 * agent's history is bounded by time rather than by how much it was told.
 */
export const KEPT_FOR = 7 * 24 * 60 * 60;

export const expired = ({ queuedAt }: Queued, now: Date) =>
  now.getTime() - Date.parse(queuedAt) > KEPT_FOR * 1000;

/**
 * Making and retiring an agent's home are offered until its host takes them,
 * however long that is: the record already says they are so.
 */
export const DURABLE: readonly Command["kind"][] = ["create", "retire"];

/**
 * A command its host has not taken by the time that host would be called lost
 * is withdrawn: never sent, and on record as `withdrawn`, because a message
 * that arrives hours late is a different message. A withdrawn `start` leaves
 * its session live on record until the host, reconciling, reports it interrupted.
 */
export const withdrawn = ({ command, queuedAt }: Queued, now: Date) =>
  !DURABLE.includes(command.kind) && now.getTime() - Date.parse(queuedAt) > LOST_AFTER * 1000;

export const DELIVERIES = ["queued", "written", "withdrawn", "done", "rejected"] as const;

export function delivery(sent: Sent, now: Date): (typeof DELIVERIES)[number] {
  if (sent.withdrawnAt !== null) return "withdrawn";
  if (sent.reportedAt !== null) return !sent.ok ? "rejected" : sent.taken === false ? "written" : "done";
  return withdrawn(sent, now) ? "withdrawn" : "queued";
}
