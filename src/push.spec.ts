import { describe, expect, it } from "vitest";
import { FakeStore } from "./fake-store.ts";
import { Push, type Poster } from "./push.ts";
import type { SocketOutbound } from "./schema.ts";

const AT = "2026-10-27T12:00:00.000Z";

describe("pushing to pages", () => {
  it("sends each message whole to every viewer and none to a host, and forgets a socket found gone", async () => {
    const store = new FakeStore();
    await store.putConnection({ connectionId: "page", kind: "viewer", connectedAt: AT });
    await store.putConnection({ connectionId: "closed", kind: "viewer", connectedAt: AT });
    await store.putConnection({ connectionId: "host", kind: "host", hostId: "laptop", connectedAt: AT });
    const posted: [string, SocketOutbound][] = [];
    const poster: Poster = { post: async (to, m) => (to === "closed" ? "gone" : (posted.push([to, m]), "sent")) };
    const lines = Array.from({ length: 3 }, (_, seq) => ({ seq, at: AT, sessionId: "9d6a1f0e-4b7c-4e21-a3f8-0c5d2e7b4a19", from: "agent" as const, text: "x".repeat(200_000) }));
    await new Push(store, poster).toViewers([{ type: "lines", agentId: "w", lines }]);
    expect(posted).toEqual([["page", { type: "lines", agentId: "w", lines }]]);
    expect((await store.connections()).map((c) => c.connectionId).sort()).toEqual(["host", "page"]);
  });
});
