import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { agentPage, notice, Nudge } from "./nudge.ts";
import type { Agent } from "./domain.ts";

const agent = (status: string, extra: Partial<Agent> = {}) => ({ id: "a1", name: "implementer-a1", title: null, status, summary: "PR #3 is up", ...extra }) as Agent;

describe("what the person is told of an agent", () => {
  it("is urgent when it waits on them, and normal in review or done", () => {
    expect(notice(agent("waiting"), "working")).toEqual({ post: { title: "implementer-a1 is waiting on you", body: "PR #3 is up", priority: "urgent" } });
    expect(notice(agent("review", { title: "Fix login" }), "working")).toMatchObject({ post: { title: "implementer-a1 (Fix login) is ready for review", priority: "normal" } });
    expect(notice(agent("done"), "review")).toMatchObject({ post: { title: "implementer-a1 is done" } });
  });

  it("is taken back once it works again, and nothing otherwise", () => {
    expect(notice(agent("working"), "waiting")).toEqual({ resolve: "it is working again" });
    expect(notice(agent("working"), null)).toBeNull();
    expect(notice(agent("idle"), null)).toBeNull();
  });
});

describe("the page a notification links to", () => {
  it("is the worker page when its address is set", () => {
    expect(agentPage("https://agency.test", "https://ui.test:8449/")(agent("waiting"))).toBe("https://ui.test:8449/workers/a1");
  });

  it("is agency's own page without it", () => {
    expect(agentPage("https://agency.test/", null)(agent("waiting"))).toBe("https://agency.test/#/agents/a1");
    expect(agentPage("https://agency.test", "")(agent("waiting"))).toBe("https://agency.test/#/agents/a1");
  });
});

describe("Nudge", () => {
  const servers: ReturnType<typeof createServer>[] = [];
  afterEach(() => servers.splice(0).forEach((s) => s.close()));

  it("posts and resolves by the agent's key, in order, with a link to its page", async () => {
    const seen: { path: string; auth: string; body: Record<string, unknown> }[] = [];
    const server = createServer((req: IncomingMessage, res) => {
      let data = "";
      req.on("data", (d) => (data += d)).on("end", () => {
        seen.push({ path: req.url!, auth: req.headers.authorization!, body: JSON.parse(data) });
        res.writeHead(req.url!.endsWith("/resolve") ? 404 : 201).end("{}");
      });
    });
    servers.push(server);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const logged: string[] = [];
    const nudge = new Nudge(`http://127.0.0.1:${(server.address() as AddressInfo).port}/`, "tk", (a) => `https://agency.test/#/agents/${a.id}`, (m) => logged.push(m));
    nudge.said(agent("waiting"), "working");
    nudge.said(agent("working"), "waiting");
    await new Promise((r) => setTimeout(r, 200));
    expect(seen.map((s) => s.path)).toEqual(["/notifications", "/notifications/resolve"]);
    expect(seen[0]).toMatchObject({ auth: "Bearer tk", body: { key: "agent:a1", priority: "urgent", link: "https://agency.test/#/agents/a1" } });
    expect(seen[1]?.body).toMatchObject({ key: "agent:a1", silent: true });
    expect(logged, "a resolve of one already closed is not a failure").toEqual([]);
  });

  it("logs a failure and never throws", async () => {
    const logged: string[] = [];
    const nudge = new Nudge("http://127.0.0.1:9", "tk", () => "x", (m) => logged.push(m));
    expect(() => nudge.said(agent("waiting"), null)).not.toThrow();
    await new Promise((r) => setTimeout(r, 300));
    expect(logged[0]).toContain("nudge: implementer-a1");
  });
});
