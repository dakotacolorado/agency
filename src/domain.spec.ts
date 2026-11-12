import { describe, expect, it } from "vitest";
import {
  ACTIVITY_LIMIT,
  HEARTBEAT_INTERVAL,
  LINE_LIMIT,
  LOST_AFTER,
  activityOf,
  available,
  cut,
  delivery,
  hostStatus,
  isLive,
  unreachable,
  unreported,
  withdrawn,
  type Host,
  type Worker,
} from "./domain.ts";
import type { Command } from "./schema.ts";

const NOW = new Date("2026-10-27T12:00:00.000Z");
const ago = (seconds: number) => new Date(NOW.getTime() - seconds * 1000).toISOString();

const host: Host = { id: "laptop", heartbeatAt: ago(0), version: null, labels: [], capacity: 2 };

const worker = (fields: Partial<Worker>): Worker => ({
  id: "w",
  name: "w",
  hostId: "laptop",
  state: "idle",
  session: null,
  createdAt: ago(0),
  reportedAt: null,
  hadSession: false,
  ...fields,
});

describe("a host's status", () => {
  it("is connected through two intervals, disconnected to lost, then lost", () => {
    expect(hostStatus(ago(2 * HEARTBEAT_INTERVAL), NOW)).toBe("connected");
    expect(hostStatus(ago(2 * HEARTBEAT_INTERVAL + 1), NOW)).toBe("disconnected");
    expect(hostStatus(ago(LOST_AFTER), NOW)).toBe("disconnected");
    expect(hostStatus(ago(LOST_AFTER + 1), NOW)).toBe("lost");
  });

  it("refuses only a lost or deregistered host", () => {
    expect(unreachable(host, "laptop", NOW)).toBeNull();
    expect(unreachable({ ...host, heartbeatAt: ago(LOST_AFTER) }, "laptop", NOW)).toBeNull();
    expect(unreachable({ ...host, heartbeatAt: ago(LOST_AFTER + 1) }, "laptop", NOW)).toMatch(/has not sent/);
    expect(unreachable(null, "laptop", NOW)).toMatch(/deregistered/);
  });
});

describe("a host's places", () => {
  it("are taken by live sessions on it alone", () => {
    const session = { id: "s", startedAt: ago(0) };
    const workers = [
      worker({ id: "a", session, state: "working" }),
      worker({ id: "b" }),
      worker({ id: "c", session, hostId: "desktop" }),
    ];
    expect(available(host, workers)).toBe(1);
    expect(available({ ...host, capacity: 0 }, workers)).toBe(0);
    expect(available({ ...host, capacity: null }, workers)).toBeNull();
  });

  it("are held in working and waiting", () => {
    expect(["working", "waiting"].every(isLive)).toBe(true);
    expect(["idle", "interrupted", "retired"].some(isLive)).toBe(false);
  });
});

describe("a command", () => {
  const message: Command = { kind: "message", id: "c", workerId: "w", text: "hi" };
  const create: Command = { kind: "create", id: "c", workerId: "w", name: "w" };

  it("is withdrawn unreported once its host would be lost, but a create or retire never is", () => {
    expect(withdrawn({ command: message, queuedAt: ago(LOST_AFTER) }, NOW)).toBe(false);
    expect(withdrawn({ command: message, queuedAt: ago(LOST_AFTER + 1) }, NOW)).toBe(true);
    expect(withdrawn({ command: create, queuedAt: ago(LOST_AFTER * 100) }, NOW)).toBe(false);
    expect(withdrawn({ command: { kind: "retire", id: "c", workerId: "w" }, queuedAt: ago(LOST_AFTER * 100) }, NOW)).toBe(false);
  });

  it("is delivered as its host reported it", () => {
    const sent = unreported({ command: message, queuedAt: ago(0) });
    expect(delivery(sent, NOW)).toBe("queued");
    expect(delivery({ ...sent, reportedAt: ago(0), ok: true }, NOW)).toBe("done");
    expect(delivery({ ...sent, reportedAt: ago(0), ok: false }, NOW)).toBe("rejected");
    expect(delivery({ ...sent, withdrawnAt: ago(0) }, NOW)).toBe("withdrawn");
  });
});

describe("cutting a line's text", () => {
  it("keeps it whole up to the limit, and past it says how much was kept of how much, in characters", () => {
    const whole = "🦀".repeat(LINE_LIMIT);
    expect(cut(whole)).toBe(whole);
    const kept = cut("🦀".repeat(LINE_LIMIT + 1));
    const [, n, of] = /… \[cut: (\d+) of (\d+) characters\]$/.exec(kept)!;
    expect([...kept]).toHaveLength(LINE_LIMIT);
    expect(kept.startsWith("🦀".repeat(Number(n)) + "…")).toBe(true);
    expect(Number(of)).toBe(LINE_LIMIT + 1);
  });
});

describe("a worker's activity line", () => {
  const tool = (name: string, input: object) => activityOf("tool", `${name} ${JSON.stringify(input)}`);

  it("is a Bash call's description, never its command", () => {
    expect(tool("Bash", { command: "curl -H 'Authorization: Bearer s3cr3t' https://x", description: "Fetch the queue" })).toBe("Fetch the queue");
    expect(tool("Bash", { command: "export TOKEN=s3cr3t" })).toBe("Ran a command");
  });

  it("is another tool's name and target, or its name alone", () => {
    expect(tool("Edit", { file_path: "/home/w/src/worker-service/src/fleet.ts", old_string: "a", new_string: "b" })).toBe("Edit src/fleet.ts");
    expect(tool("Agent", { description: "workplace-ui derived statuses", prompt: "long brief" })).toBe("Agent workplace-ui derived statuses");
    expect(tool("Skill", { skill: "page", args: "x" })).toBe("Skill page");
    expect(tool("WebFetch", { url: "https://example.com/a?token=s3cr3t" })).toBe("WebFetch example.com");
    expect(tool("Grep", { pattern: "s3cr3t" })).toBe("Grep");
    expect(tool("mcp__docs__read", { id: "x" })).toBe("mcp__docs__read");
    expect(activityOf("tool", `Edit {"file_path":"/a/b.ts","old_string":"… [cut: 10 of 9000 characters]`)).toBe("Edit");
  });

  it("is the first line of a reply, short enough for a card, and never what the person said", () => {
    expect(activityOf("agent", "\n\nThe queue holds 3 PRs.\nNone failing.")).toBe("The queue holds 3 PRs.");
    const long = activityOf("agent", "x".repeat(500))!;
    expect([...long]).toHaveLength(ACTIVITY_LIMIT);
    expect(long.endsWith("…")).toBe(true);
    expect(activityOf("instruction", "Here is my token: s3cr3t")).toBeNull();
    expect(activityOf("agent", "  \n ")).toBeNull();
  });
});
