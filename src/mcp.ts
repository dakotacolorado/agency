import { getOpenApiMetadata } from "@asteasolutions/zod-to-openapi";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "@hono/zod-openapi";
import * as routes from "./schema.ts";
import { TAGLINE } from "./banner.ts";

export const INSTRUCTIONS = `agency: ${TAGLINE} It runs lasting Claude Code agents, each living on one host and run in sessions.

- An agent is made on a host (create_agent), or asked for in a role (create_request), which starts it once Claude usage and a host's room allow.
- A role names the honed skills each session reads, the services it is given and what becomes of it once done (list_roles).
- send_message talks to an agent: it starts a session carrying on its conversation when none is live. stop_agent ends its live session and keeps it, for send_message to start again. delete_agent ends the agent for good.
- An agent's status is working, idle, waiting (on the person), review or done; put_agent_status is how an agent says it of itself.
- list_transcript_lines reads what an agent and its tools said, after a cursor: call it again from next.
- list_sessions lists each session's record, newest first: its task, role, capability and models, tokens, estimated cost and time, filtered by item, role, agentId, model and time.
- Every tool takes the token this server was connected with, and is refused as the API would refuse it. The host protocol (heartbeats, the socket, a session's context) is the hosts', not tools.`;

/** The address the MCP docs give; served, this deployment's own replaces it. */
export const LOCAL_URL = "http://127.0.0.1:4600";

/** Sends one API request as the MCP request's caller, and gives its status and JSON. */
export type Call = (method: string, path: string, init: { body?: unknown; headers?: Record<string, string> }) => Promise<{ status: number; body: unknown }>;

/** The operations that are the hosts' and pages' protocol, or need no agent to call them: no tool. */
export const NOT_TOOLS = ["GetHealth", "GetSkill", "SendHeartbeat", "GetSessionContext", "CreateSocketTicket"];

/** `PutAgentStatus` as `put_agent_status`. */
export const toolName = (operationId: string) => operationId.replace(/(?<!^)([A-Z])/g, "_$1").toLowerCase();

interface Route {
  method: string;
  path: string;
  operationId: string;
  summary: string;
  description?: string;
  request?: {
    params?: z.ZodObject;
    query?: z.ZodObject;
    headers?: z.ZodObject;
    body?: { content: { "application/json": { schema: z.ZodObject } } };
  };
}

/** Every operation the API serves, as `schema.ts` defines it, by name, so its tools list the same however the module is loaded. */
export const OPERATIONS: Route[] = Object.entries(routes)
  .filter(([name]) => name.endsWith("Route"))
  .map(([, route]) => route as unknown as Route)
  .sort((a, b) => a.operationId.localeCompare(b.operationId));

/** Each field with its OpenAPI description as its own, which zod's JSON Schema, which MCP lists, cannot otherwise see. */
const described = (shape: z.ZodRawShape): z.ZodRawShape =>
  Object.fromEntries(
    Object.entries(shape).map(([name, core]) => {
      const field = core as unknown as z.ZodType;
      const text = field.description ?? getOpenApiMetadata(field)?.description;
      return [name, text ? field.describe(text) : field];
    }),
  );

/** A tool's input: its path parameters, query and body, side by side, each field named once. */
export function inputOf(route: Route): z.ZodRawShape {
  const parts = [route.request?.params?.shape, route.request?.query?.shape, route.request?.body?.content["application/json"].schema.shape].filter(Boolean) as z.ZodRawShape[];
  const shape: Record<string, z.ZodRawShape[string]> = {};
  for (const part of parts) {
    for (const [name, field] of Object.entries(part)) {
      if (name in shape) throw new Error(`${route.operationId} names ${name} twice in its input`);
      shape[name] = field;
    }
  }
  return described(shape);
}

/** The request a tool's input makes: its path filled, its query, and its body. */
export function requestOf(route: Route, input: Record<string, unknown>): { method: string; path: string; body?: unknown } {
  const take = (schema: z.ZodObject | undefined) =>
    Object.fromEntries(Object.keys(schema?.shape ?? {}).flatMap((key) => (input[key] === undefined ? [] : [[key, input[key]]])));
  const params = take(route.request?.params);
  const query = take(route.request?.query);
  const path = route.path.replace(/\{(\w+)\}/g, (_, key: string) => encodeURIComponent(String(params[key])));
  const search = new URLSearchParams(Object.entries(query).map(([key, value]): [string, string] => [key, String(value)])).toString();
  const body = route.request?.body ? take(route.request.body.content["application/json"].schema) : undefined;
  return { method: route.method.toUpperCase(), path: search ? `${path}?${search}` : path, ...(body !== undefined && { body }) };
}

/**
 * The MCP server for one request. Each tool is one API operation, named as
 * its `operationId` in snake_case, its input the operation's parameters and
 * body, made in-process with the caller's own `authorization` and
 * `claimed-by`, so it is refused, recorded and answered as that request
 * would be; an API error is the tool's error, in the API's words.
 */
export function mcpServer(version: string, call: Call, claimedBy?: string): McpServer {
  const server = new McpServer({ name: "agency", version }, { instructions: INSTRUCTIONS });
  for (const route of OPERATIONS) {
    if (NOT_TOOLS.includes(route.operationId)) continue;
    const method = route.method.toLowerCase();
    server.registerTool(
      toolName(route.operationId),
      {
        title: route.summary,
        description: route.description ?? `${route.summary}.`,
        inputSchema: inputOf(route),
        annotations: { readOnlyHint: method === "get", destructiveHint: method === "delete" },
      },
      // The SDK types a tool's input by its own zod; these are the API's schemas, which it validates the same.
      (async (input: Record<string, unknown>) => {
        const { method, path, body } = requestOf(route, input);
        const headers = route.request?.headers && claimedBy ? { "claimed-by": claimedBy } : undefined;
        const res = await call(method, path, { body, ...(headers && { headers }) });
        const text = res.body === null ? `${res.status}` : typeof res.body === "string" ? res.body : JSON.stringify(res.body, null, 2);
        return { content: [{ type: "text" as const, text }], ...(res.status >= 400 && { isError: true }) };
      }) as never,
    );
  }
  return server;
}
