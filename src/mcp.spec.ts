import { beforeEach, describe, expect, it } from "vitest";
import { AgentServiceApi, fixedToken } from "./api.ts";
import { FakeStore } from "./fake-store.ts";
import { inputOf, NOT_TOOLS, OPERATIONS, toolName } from "./mcp.ts";

const TOKEN = "t";
let store: FakeStore;
let api: AgentServiceApi;

beforeEach(() => {
  store = new FakeStore();
  api = new AgentServiceApi(store, fixedToken(TOKEN));
});

/** One JSON-RPC request to `/mcp`, as a streamable-HTTP client sends it. */
const rpc = async (method: string, params: unknown, headers: Record<string, string> = { authorization: `Bearer ${TOKEN}` }) => {
  const res = await api.fetch(
    new Request("http://local/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    }),
  );
  return { status: res.status, body: (await res.json()) as any };
};

const tool = async (name: string, args: Record<string, unknown> = {}, headers?: Record<string, string>) => {
  const { body } = await rpc("tools/call", { name, arguments: args }, headers);
  const result = body.result as { content: { text: string }[]; isError?: boolean };
  return { error: result.isError === true, value: JSON.parse(result.content[0]!.text) };
};

describe("the MCP server at /mcp", () => {
  it("lists one snake_case tool per operation an agent or person uses, and none of the hosts' or pages' protocol", async () => {
    const { body } = await rpc("tools/list", {});
    const names = (body.result.tools as { name: string }[]).map((t) => t.name).sort();
    const operations = OPERATIONS.map((op) => op.operationId).filter((id) => !NOT_TOOLS.includes(id));
    expect(names).toEqual(operations.map(toolName).sort());
    expect(names).toContain("put_agent_status");
    expect(names).toContain("list_transcript_lines");
    expect(names).not.toContain("send_heartbeat");
  });

  it("gives each tool its operation's parameters and body as input, each field described", async () => {
    const { body } = await rpc("tools/list", {});
    const send = (body.result.tools as { name: string; inputSchema: { properties: Record<string, { description?: string }>; required?: string[] } }[]).find(
      (t) => t.name === "send_message",
    )!;
    expect(Object.keys(send.inputSchema.properties).sort()).toEqual(["id", "interrupt", "text"]);
    expect(send.inputSchema.required).toContain("id");
    for (const op of OPERATIONS) expect(() => inputOf(op), op.operationId).not.toThrow();
  });

  it("makes each tool's request with the caller's token, and answers in the API's words", async () => {
    await store.putHost({ id: "laptop", heartbeatAt: new Date().toISOString(), version: null, labels: [], capacity: 2 });
    const made = await tool("create_agent", { name: "ana", hostId: "laptop" }, { authorization: `Bearer ${TOKEN}`, "claimed-by": "a person" });
    expect(made).toMatchObject({ error: false, value: { name: "ana", hostId: "laptop", createdBy: "a person" } });
    expect(await tool("list_agents", { createdBy: "a person" })).toMatchObject({ error: false, value: { agents: [{ name: "ana" }] } });
    expect(await tool("put_agent_title", { id: made.value.id, title: "Reads the backlog" })).toMatchObject({ value: { title: "Reads the backlog" } });
    expect(await tool("get_agent", { id: "3b0f6c1e-9a52-4c1d-8f43-2a6e1c7d9b10" })).toEqual({ error: true, value: { code: "ResourceNotFoundException", message: "No agent has this id." } });
  });

  it("is refused without the token, as the API is", async () => {
    expect((await rpc("tools/list", {}, { authorization: "Bearer wrong" })).status).toBe(401);
  });
});

describe("the docs", () => {
  it("are served without a token, the MCP page with this deployment's address", async () => {
    for (const path of ["/docs/api", "/docs/mcp", "/mcp.json", "/openapi.json"]) {
      const res = await api.fetch(new Request(`https://agents.example${path}`));
      expect(res.status, path).toBe(200);
    }
    const page = await (await api.fetch(new Request("https://agents.example/docs/mcp"))).text();
    expect(page).toContain("https://agents.example/mcp");
    expect(page).not.toContain("127.0.0.1");
  });
});

describe("an unknown path", () => {
  it("answers as every error does, `{code, message}`", async () => {
    const res = await api.fetch(new Request("http://local/nothing-here", { headers: { authorization: `Bearer ${TOKEN}` } }));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ code: "ResourceNotFoundException", message: "No operation is at GET /nothing-here." });
  });
});
