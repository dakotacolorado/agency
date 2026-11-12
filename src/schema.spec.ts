import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { AUDIENCES } from "./schema.ts";
import { generatedFiles, openApiDocument, repoFile } from "./spec.ts";

interface JsonSchema {
  properties?: Record<string, unknown>;
  required?: string[];
}

// Backstop for the pre-commit hook: a schema change committed with --no-verify,
// or a hand edit to a generated file, cannot merge.
describe("generated files", async () => {
  const generated = await generatedFiles();

  it.each(Object.keys(generated))("%s is what npm run spec writes", (path) => {
    expect(readFileSync(repoFile(path), "utf8"), "run npm run spec").toBe(generated[path]);
  });
});

describe("openapi.json", () => {
  it("matches what the service serves", async () => {
    expect(JSON.parse(readFileSync(repoFile("openapi.json"), "utf8"))).toEqual(
      await openApiDocument(),
    );
  });

  it("names every operation, since generators derive method names from it", async () => {
    const operations = await operationIds();
    expect(operations.filter((id) => !id)).toEqual([]);
  });
});

describe.each(["docs/API.md", "docs/index.html"])("%s", (file) => {
  it("documents every operation", async () => {
    const rendered = readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
    const undocumented = (await operationIds()).filter((id) => !rendered.includes(id!));
    expect(undocumented).toEqual([]);
  });
});

async function operationIds(): Promise<(string | undefined)[]> {
  const { paths } = (await openApiDocument()) as {
    paths: Record<string, Record<string, { operationId?: string }>>;
  };
  return Object.values(paths).flatMap((methods) =>
    Object.values(methods).map((operation) => operation.operationId),
  );
}

interface Operation {
  operationId: string;
  tags: string[];
  summary?: string;
  deprecated?: boolean;
  parameters?: { name: string; in: string; deprecated?: boolean }[];
  requestBody?: unknown;
  responses: Record<string, { content?: { "application/json": { schema: unknown } } }>;
}

async function operations(): Promise<(Operation & { method: string; path: string })[]> {
  const { paths } = (await openApiDocument()) as {
    paths: Record<string, Record<string, Operation>>;
  };
  return Object.entries(paths).flatMap(([path, methods]) =>
    Object.entries(methods).map(([method, operation]) => ({ ...operation, method, path })),
  );
}

async function schemas(): Promise<Record<string, JsonSchema>> {
  return ((await openApiDocument()) as { components: { schemas: Record<string, JsonSchema> } })
    .components.schemas;
}

describe("the line between hosts and clients", async () => {
  const fleet = (await operations()).filter((op) => op.path.startsWith("/fleet/"));
  const audience = (tag: string) => fleet.filter((op) => op.tags.includes(tag));

  it("keeps every route under /fleet/, which the UI's CDN forwards", async () => {
    const paths = (await operations()).map((op) => op.path);
    expect(paths.filter((p) => p !== "/health" && !p.startsWith("/fleet/"))).toEqual([]);
  });

  it("puts every fleet operation under exactly one audience", () => {
    const audiences = Object.values(AUDIENCES) as string[];
    const misfiled = fleet.filter((op) => op.tags.filter((t) => audiences.includes(t)).length !== 1);
    expect(misfiled.map((op) => op.operationId)).toEqual([]);
  });

  it("gives a host one operation", () => {
    expect(audience(AUDIENCES.host).map((op) => op.operationId)).toEqual(["heartbeat", "getSessionContext"]);
  });

  it("lets a client read without changing anything, and act without reporting state", () => {
    expect(audience(AUDIENCES.reading).every((op) => op.method === "get" && !op.requestBody)).toBe(true);
    expect(audience(AUDIENCES.acting).every((op) => op.method !== "get")).toBe(true);
    const hostState = /#\/components\/schemas\/(Heartbeat|WorkerReport|LineReport)"/;
    const clients = [...audience(AUDIENCES.reading), ...audience(AUDIENCES.acting)];
    expect(clients.filter((op) => hostState.test(JSON.stringify(op.requestBody ?? {})))).toEqual([]);
  });
});

describe("the reference", async () => {
  const ops = await operations();
  const all = await schemas();

  it("names every read with get or list", () => {
    const reads = ops.filter((op) => op.tags.includes(AUDIENCES.reading));
    expect(reads.filter((op) => !/^(get|list)[A-Z]/.test(op.operationId))).toEqual([]);
  });

  it("calls the health route a health check", () => {
    expect(ops.find((op) => op.path === "/health")?.summary).toBe("Health check");
  });

  it("deprecates nothing", () => {
    expect(ops.filter((op) => op.deprecated).map((op) => op.operationId)).toEqual([]);
    expect(JSON.stringify(all).match(/"deprecated":true/g) ?? []).toEqual([]);
  });

  it("serves none of the agents' model: no agents, placement, levels or tickets", () => {
    expect(ops.filter((op) => /agent/i.test(op.path))).toEqual([]);
    expect(Object.keys(all).filter((name) => /Agent|Placement|Refusal/.test(name))).toEqual([]);
    const fields = Object.values(all).flatMap((schema) => Object.keys(schema.properties ?? {}));
    expect(fields.filter((f) => /^(level|workItemId|ticketId|branch|selector|asOf)$/.test(f))).toEqual([]);
  });

  it("answers a single read with the resource itself", () => {
    const body = (id: string, status = "200") =>
      JSON.stringify(ops.find((op) => op.operationId === id)!.responses[status]!.content!["application/json"].schema);
    expect(body("getWorker")).toBe(JSON.stringify({ $ref: "#/components/schemas/Worker" }));
    expect(body("createWorker", "201")).toBe(JSON.stringify({ $ref: "#/components/schemas/Worker" }));
  });

  it("describes the socket's messages, both ways", () => {
    for (const name of ["SocketInbound", "SocketReport", "SocketPing", "SocketOutbound", "CommandPush", "WorkerPush", "LinesPush", "HostPush", "UsagePush"]) {
      expect(all[name], name).toBeDefined();
    }
  });
});

describe("the shapes", async () => {
  const all = await schemas();

  it("are the protocol's, field for field", () => {
    const fields = (name: string) => Object.keys(all[name]!.properties ?? {}).sort();
    expect(fields("Worker")).toEqual(
      [
        "createdAt", "hostId", "hostStatus", "id", "name", "reportedAt", "session", "state", "title",
        "label", "item", "role", "tokens", "createdBy", "whenDone", "documents", "credentials", "status", "summary", "headline", "saidAt", "activity", "tasks", "told",
      ].sort(),
    );
    expect(fields("Session")).toEqual(["context", "contextNote", "documents", "endedAt", "ended", "id", "skills", "startedAt", "workerId"].sort());
    expect(fields("TranscriptLine")).toEqual(["at", "commandId", "from", "seq", "sessionId", "text"].sort());
    expect(fields("LineReport")).toEqual(["at", "commandId", "from", "seq", "sessionId", "text", "workerId"].sort());
    expect(fields("WorkerReport")).toEqual(["id", "sessionId", "state", "tasks", "told"]);
    expect(fields("CommandReport")).toEqual(["commandId", "error", "ok", "taken"]);
    expect(fields("Heartbeat")).toEqual(["capacity", "labels", "version"]);
    expect(fields("HeartbeatResponse")).toEqual(["heartbeatInterval", "socketUrl"]);
    expect(fields("SocketReport")).toEqual(["commandResults", "lines", "tokens", "type", "usage", "workers"]);
    expect(fields("SessionTokensReport")).toEqual(
      ["cacheCreationInputTokens", "cacheReadInputTokens", "inputTokens", "outputTokens", "sessionId", "workerId"].sort(),
    );
    expect(fields("UsageReport")).toEqual(["fiveHour", "readAt", "sevenDay"]);
    expect(fields("Usage")).toEqual(["fiveHour", "readAt", "sevenDay"]);
    expect(fields("UsageWindow")).toEqual(["hostId", "readAt", "resetsAt", "utilization"]);
    expect(fields("CreateCommand")).toEqual(["id", "kind", "name", "workerId"]);
    expect(fields("StartCommand")).toEqual(["context", "contextUrl", "credentials", "documents", "env", "id", "kind", "ownCredentials", "resume", "secrets", "sessionId", "text", "workerId"]);
    expect(fields("NewWorker")).toEqual(["brief", "credentials", "documents", "hostId", "item", "label", "labels", "name", "role", "whenDone"]);
    expect(fields("Message")).toEqual(["interrupt", "text"]);
    expect(fields("SocketTicket")).toEqual(["expiresAt", "socketUrl", "ticket"]);
    expect(fields("Accepted")).toEqual(["commandId"]);
    expect(fields("SessionContext")).toEqual(["context", "documents"]);
    expect(fields("WorkerStatus")).toEqual(["headline", "status", "summary"]);
  });

  it("read what only grows from a cursor, never a page number", async () => {
    const ops = await operations();
    expect(ops.filter((op) => op.parameters?.some((p) => /^(page|offset|skip)$/.test(p.name)))).toEqual([]);
    const op = ops.find((o) => o.operationId === "listTranscript")!;
    expect(op.parameters?.map((p) => p.name)).toContain("after");
    expect(all.Transcript!.required).toContain("next");
  });
});
