#!/usr/bin/env node
import { serve } from "@hono/node-server";
import { existsSync, mkdirSync } from "node:fs";
import type { Server } from "node:http";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { banner, SUMMARY, TAGLINE, WORDMARK } from "./banner.ts";
import { PACKAGE_VERSION } from "./build.ts";
import { SELF } from "./credentials.ts";
import { start, type Running } from "./server.ts";
import { readServices, type Services } from "./services.ts";
import { Store } from "./store.ts";
import { RETIRE_CLOSED_AFTER } from "./sweep.ts";

const USAGE = `${WORDMARK}

agency v${PACKAGE_VERSION}: ${TAGLINE}
${SUMMARY}

Usage:
  agency [serve] [options]   run the server
  agency backup <file>       copy the database, consistent while the server runs, to <file>

Options:
  --host <addr>       address to listen on (default 127.0.0.1, or AGENCY_HOST)
  --port <n>          port (default 4600, or AGENCY_PORT)
  --db <path>         the SQLite file (default ~/.local/share/agency/agency.db, or AGENCY_DB)
  --public-url <url>  this service's address as agents and hosts reach it, such as its Tailscale
                      HTTPS one (or AGENCY_URL); without it, the address each request came to
  --services <file>   the other services a session may be given, as JSON (or AGENCY_SERVICES):
                      {"<name>": {"url", "urlVar", "tokenVar", "tokenEnv"}}, each token read from
                      this process's variable tokenEnv
  --retire-closed-after <days>
                      delete agents done and closed for longer than this, on the hourly sweep;
                      0 never (default 14, or AGENCY_RETIRE_CLOSED_AFTER)
  -h, --help          this

Environment:
  AUTH_TOKEN      the bearer token every caller and host presents

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
    "retire-closed-after": { type: "string" },
    help: { type: "boolean", short: "h" },
  },
});

const fail = (message: string): never => {
  process.stderr.write(`agency: ${message}\n`);
  process.exit(1);
};

if (values.help) {
  process.stdout.write(USAGE);
  process.exit(0);
}

const env = process.env;
/** AGENCY_<name>, or AGENT_SERVICE_<name>, its name before agency was renamed. */
const setting = (name: string): string | undefined => env[`AGENCY_${name}`] ?? env[`AGENT_SERVICE_${name}`];
/** The default file, unless only the one agent-service kept is there. */
const defaultDb = (): string => {
  const share = join(homedir(), ".local", "share");
  const now = join(share, "agency", "agency.db"), before = join(share, "agent-service", "agent-service.db");
  return !existsSync(now) && existsSync(before) ? before : now;
};
const db = values.db ?? setting("DB") ?? defaultDb();
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

const host = values.host ?? setting("HOST") ?? "127.0.0.1";
const port = Number(values.port ?? setting("PORT") ?? 4600);
if (!Number.isInteger(port) || port < 0 || port > 65535) fail(`--port must be a port number, not ${values.port ?? setting("PORT")}`);

const servicesFile = values.services ?? setting("SERVICES");
let services: Services = {};
if (servicesFile) {
  try {
    services = readServices(resolve(servicesFile));
  } catch (err) {
    fail(`cannot read the services in ${servicesFile}: ${(err as Error).message}`);
  }
}

const publicUrl = values["public-url"] ?? setting("URL") ?? null;
// nudge, which tells the person when an agent waits on them: both settings, or neither.
const nudgeUrl = setting("NUDGE_URL")?.trim(), nudgeToken = setting("NUDGE_TOKEN")?.trim();
if (Boolean(nudgeUrl) !== Boolean(nudgeToken)) fail("AGENCY_NUDGE_URL and AGENCY_NUDGE_TOKEN go together: set both, or neither");
const retireSetting = values["retire-closed-after"] ?? setting("RETIRE_CLOSED_AFTER");
const retireClosedAfter = retireSetting === undefined || retireSetting.trim() === "" ? RETIRE_CLOSED_AFTER : Number(retireSetting);
if (!Number.isFinite(retireClosedAfter) || retireClosedAfter < 0) fail(`--retire-closed-after must be a number of days, 0 or more, not ${retireSetting}`);
const workerPageUrl = setting("WORKER_PAGE_URL")?.trim() || null;
const starting = (): Running => {
  try {
    return start({ db: path, token: env.AUTH_TOKEN || null, services, publicUrl, nudge: nudgeUrl && nudgeToken ? { url: nudgeUrl, token: nudgeToken } : null, workerPageUrl, retireClosedAfter });
  } catch (err) {
    return fail((err as Error).message);
  }
};
const running = starting();
const server = serve({ fetch: running.api.fetch, hostname: host, port }, (info) => {
  const missing = env.AUTH_TOKEN ? [] : ["AUTH_TOKEN"];
  const local = `http://${host.includes(":") ? `[${host}]` : host}:${info.port}`;
  const color = Boolean(process.stdout.isTTY) && !env.NO_COLOR;
  process.stdout.write(
    banner({ version: PACKAGE_VERSION, url: local, publicUrl: (publicUrl ?? local).replace(/\/$/, ""), db: path, services: [SELF, ...Object.keys(services)], missing, color }),
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
