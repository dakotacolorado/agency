#!/usr/bin/env node
import { serve } from "@hono/node-server";
import { mkdirSync } from "node:fs";
import type { Server } from "node:http";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { PACKAGE_VERSION } from "./build.ts";
import { start, type Running } from "./server.ts";
import { readServices, type Services } from "./services.ts";
import { Store } from "./store.ts";

const USAGE = `agent-service v${PACKAGE_VERSION}: agents, their sessions and the hosts they run on, over HTTP, on SQLite.

Usage:
  agent-service [serve] [options]   run the server
  agent-service backup <file>       copy the database, consistent while the server runs, to <file>

Options:
  --host <addr>       address to listen on (default 127.0.0.1, or AGENT_SERVICE_HOST)
  --port <n>          port (default 4600, or AGENT_SERVICE_PORT)
  --db <path>         the SQLite file (default ~/.local/share/agent-service/agent-service.db, or AGENT_SERVICE_DB)
  --public-url <url>  this service's address as agents and hosts reach it, such as its Tailscale
                      HTTPS one (or AGENT_SERVICE_URL); without it, the address each request came to
  --services <file>   the other services a session may be given, as JSON (or AGENT_SERVICE_SERVICES):
                      {"<name>": {"url", "urlVar", "tokenVar", "tokenEnv"}}, each token read from
                      this process's variable tokenEnv
  -h, --help          this

Environment:
  AUTH_TOKEN      the bearer token every caller and host presents
  ADMIN_TOKEN     a person's token: all AUTH_TOKEN does, and writing roles

Without AUTH_TOKEN, every call but /health and /openapi.json answers 503.
`;

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    host: { type: "string" },
    port: { type: "string" },
    db: { type: "string" },
    services: { type: "string" },
    "public-url": { type: "string" },
    help: { type: "boolean", short: "h" },
  },
});

const fail = (message: string): never => {
  process.stderr.write(`agent-service: ${message}\n`);
  process.exit(1);
};

if (values.help) {
  process.stdout.write(USAGE);
  process.exit(0);
}

const env = process.env;
const db = values.db ?? env.AGENT_SERVICE_DB ?? join(homedir(), ".local", "share", "agent-service", "agent-service.db");
const path = db === ":memory:" ? db : resolve(db);
if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
const [command = "serve", file] = positionals;

if (command === "backup") {
  if (!file) fail("backup needs the file to write");
  const store = Store.open(path);
  try {
    const pages = await store.backup(resolve(file!));
    process.stdout.write(`backed up ${path} to ${resolve(file!)} (${pages} pages)\n`);
  } catch (err) {
    fail(`backup failed: ${(err as Error).message}`);
  }
  store.close();
  process.exit(0);
}

if (command !== "serve") fail(`unknown command "${command}"\n\n${USAGE}`);

const host = values.host ?? env.AGENT_SERVICE_HOST ?? "127.0.0.1";
const port = Number(values.port ?? env.AGENT_SERVICE_PORT ?? 4600);
if (!Number.isInteger(port) || port < 0 || port > 65535) fail(`--port must be a port number, not ${values.port ?? env.AGENT_SERVICE_PORT}`);

const servicesFile = values.services ?? env.AGENT_SERVICE_SERVICES;
let services: Services = {};
if (servicesFile) {
  try {
    services = readServices(resolve(servicesFile));
  } catch (err) {
    fail(`cannot read the services in ${servicesFile}: ${(err as Error).message}`);
  }
}

const publicUrl = values["public-url"] ?? env.AGENT_SERVICE_URL ?? null;
const running: Running = start({ db: path, token: env.AUTH_TOKEN || null, adminToken: env.ADMIN_TOKEN || null, services, publicUrl });
const server = serve({ fetch: running.api.fetch, hostname: host, port }, (info) => {
  const missing = [!env.AUTH_TOKEN && "AUTH_TOKEN", !env.ADMIN_TOKEN && "ADMIN_TOKEN"].filter(Boolean);
  process.stdout.write(
    `agent-service v${PACKAGE_VERSION} on http://${host.includes(":") ? `[${host}]` : host}:${info.port}, data in ${path}` +
      `, services: ${Object.keys(services).join(", ") || "none"}` +
      (missing.length ? ` (${missing.join(" and ")} not set)` : "") +
      "\n",
  );
});

running.listen(server as Server);

server.on("error", (err) => {
  running.close();
  fail(`cannot serve on ${host}:${port}: ${err.message}`);
});

const stop = () => {
  server.close();
  running.close();
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
