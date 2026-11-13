import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import openapiTS, { astToString } from "openapi-typescript";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { openApiDocument } from "./spec.ts";

/**
 * A client is generated, the way work-tracker-ui generates its own, and a
 * consumer written only against those types must compile. A shape that does
 * not survive generation -- a lost `null`, an unnamed operation -- fails here
 * rather than in the first client to need it.
 */
describe("a client generated from openapi.json", async () => {
  const document = (await openApiDocument()) as {
    paths: Record<string, Record<string, { operationId: string }>>;
  };
  const operationIds = Object.values(document.paths).flatMap((methods) =>
    Object.values(methods).map((op) => op.operationId),
  );

  const consumer = `
    import type { components, operations } from "./fleet";
    type S = components["schemas"];

    const named: (keyof operations)[] = ${JSON.stringify(operationIds)};

    const agent: S["Agent"] = {
      id: "w", name: "frontend-1", hostId: "h",
      state: "idle", session: null, createdAt: "t", reportedAt: null, hostStatus: "lost", title: null, label: null, item: null, role: null,
      tokens: { inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 }, createdBy: null, whenDone: "keep", skills: [], credentials: null,
      status: null, summary: null, headline: null, saidAt: null, activity: null, tasks: 0, told: null,
    };
    const live: S["Agent"] = { ...agent, state: "working", session: { id: "s", startedAt: "t" } };
    // @ts-expect-error there is no failed state; a session that dies leaves the agent interrupted
    const failed: S["Agent"] = { ...agent, state: "failed" };
    // @ts-expect-error an agent is not scoped to a ticket
    const ticketed: S["Agent"] = { ...agent, workItemId: "t" };
    const session: S["Session"] = { id: "s", agentId: "w", startedAt: "t", endedAt: null, ended: null, skills: [], clients: null, contextNote: null };
    const line: S["TranscriptLine"] = { seq: 0, at: "t", sessionId: "s", from: "agent", text: "hi" };
    const host: S["Host"] = {
      id: "h", heartbeatAt: "t", version: null, status: "connected", labels: [],
      capacity: null, available: null,
    };
    const created: S["NewAgent"] = { name: "a", hostId: "h" };
    const commands: S["Command"][] = [
      { kind: "create", id: "c", agentId: "w", name: "a" },
      { kind: "start", id: "c", agentId: "w", sessionId: "s", resume: false, text: "Go." },
      { kind: "message", id: "c", agentId: "w", text: "hi" },
      { kind: "interrupt", id: "c", agentId: "w" },
      { kind: "stop", id: "c", agentId: "w" },
      { kind: "retire", id: "c", agentId: "w" },
    ];
    const sent: S["SentCommand"] = {
      command: { kind: "create", id: "c", agentId: "w", name: "a" },
      queuedAt: "t", delivery: "done", reportedAt: null, error: null,
    };
    const heartbeat: S["Heartbeat"] = { version: "0.1.0", labels: [], capacity: 2 };
    // @ts-expect-error a heartbeat carries no report; that goes by the socket
    const reporting: S["Heartbeat"] = { version: "0.1.0", agents: [] };
    const replied: S["HeartbeatResponse"] = { heartbeatInterval: 30, socketUrl: null };
    // @ts-expect-error a heartbeat's response carries no commands; they come down the socket
    const commanding: S["HeartbeatResponse"] = { heartbeatInterval: 30, socketUrl: null, commands };
    const accepted: S["Accepted"] = { commandId: null };
    const report: S["SocketInbound"] = {
      type: "report",
      agents: [{ id: "w", state: "waiting", sessionId: "s" }],
      lines: [{ agentId: "w", sessionId: "s", seq: 0, at: "t", from: "tool", text: "ls" }],
      commandResults: [{ commandId: "c", ok: false, error: "no" }],
    };
    const ping: S["SocketInbound"] = { type: "ping" };
    const pushed: S["SocketOutbound"][] = [
      { type: "command", command: commands[0]! },
      { type: "agent", agent },
      { type: "lines", agentId: "w", lines: [line] },
      { type: "host", host },
      { type: "error", error: "e" },
    ];
    const ticket: S["SocketTicket"] = { ticket: "t", socketUrl: "wss://x", expiresAt: "t" };
    // @ts-expect-error interrupting is a flag, not text
    const flagged: S["Message"] = { interrupt: "yes" };

    export { named, agent, live, failed, ticketed, session, line, host, created, commands, sent, heartbeat, reporting, replied, commanding, accepted, report, ping, pushed, ticket, flagged };
  `;

  it("compiles a consumer that uses only generated types", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-service-client-"));
    try {
      writeFileSync(join(dir, "fleet.d.ts"), astToString(await openapiTS(document as never)));
      writeFileSync(join(dir, "consumer.ts"), consumer);
      const program = ts.createProgram([join(dir, "consumer.ts")], {
        strict: true,
        noEmit: true,
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.ESNext,
        moduleResolution: ts.ModuleResolutionKind.Bundler,
        types: [],
      });
      const errors = ts
        .getPreEmitDiagnostics(program)
        .map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n"));
      expect(errors).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
