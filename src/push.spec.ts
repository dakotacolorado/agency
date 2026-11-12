import { describe, expect, it } from "vitest";
import { FakeStore } from "./fake-store.ts";
import { MESSAGE_LIMIT, Push, type Poster } from "./push.ts";
import type { SocketOutbound } from "./schema.ts";

describe("pushing lines", () => {
  it("splits what would be over API Gateway's limit, keeping every line in order", async () => {
    const store = new FakeStore();
    await store.putConnection({ connectionId: "page", kind: "viewer", connectedAt: "2026-10-27T12:00:00.000Z" });
    const posted: SocketOutbound[] = [];
    const poster: Poster = { post: async (_, m) => (posted.push(m), "sent") };
    const lines = Array.from({ length: 6 }, (_, seq) => ({
      seq,
      at: "2026-10-27T12:00:00.000Z",
      sessionId: "9d6a1f0e-4b7c-4e21-a3f8-0c5d2e7b4a19",
      from: "agent" as const,
      text: "x".repeat(50_000),
    }));
    await new Push(store, poster).toViewers([{ type: "lines", agentId: "w", lines }]);
    expect(posted.length).toBeGreaterThan(1);
    for (const m of posted) expect(Buffer.byteLength(JSON.stringify(m))).toBeLessThanOrEqual(MESSAGE_LIMIT);
    expect(posted.flatMap((m) => (m.type === "lines" ? m.lines.map((l) => l.seq) : []))).toEqual([0, 1, 2, 3, 4, 5]);
  });
});

describe("pushing a sent command", () => {
  it("leaves out a start's context when it would be over the limit, keeping what was said", async () => {
    const store = new FakeStore();
    await store.putConnection({ connectionId: "page", kind: "viewer", connectedAt: "2026-10-27T12:00:00.000Z" });
    const posted: SocketOutbound[] = [];
    const poster: Poster = { post: async (_, m) => (posted.push(m), "sent") };
    const command = {
      kind: "start" as const,
      id: "c1",
      agentId: "w",
      sessionId: "9d6a1f0e-4b7c-4e21-a3f8-0c5d2e7b4a19",
      resume: false,
      text: "Go.",
      context: { key: "global", version: 1, files: [{ path: "CLAUDE.md", content: "x".repeat(MESSAGE_LIMIT), executable: false }] },
    };
    const sent = { command, queuedAt: "2026-10-27T12:00:00.000Z", delivery: "queued" as const, reportedAt: null, error: null };
    await new Push(store, poster).toViewers([{ type: "sent", agentId: "w", sent }]);
    expect(posted).toEqual([
      { type: "sent", agentId: "w", sent: { ...sent, command: { kind: "start", id: "c1", agentId: "w", sessionId: command.sessionId, resume: false, text: "Go." } } },
    ]);
  });
});
