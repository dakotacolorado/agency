import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { Store } from "./store.ts";

const CLI = fileURLToPath(new URL("./cli.ts", import.meta.url));
const clean = () => Object.fromEntries(Object.entries(process.env).filter(([k]) => !/_(URL|TOKEN)$/.test(k)));

const children: ChildProcess[] = [];
const dirs: string[] = [];
afterEach(() => {
  for (const child of children.splice(0)) child.kill();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function temp() {
  const dir = mkdtempSync(join(tmpdir(), "agency-cli-"));
  dirs.push(dir);
  return dir;
}

/** Starts the server on a port the OS picks; answers its address once it says it listens. */
function serve(db: string, env: Record<string, string>, args: string[] = []): Promise<{ url: string; out: () => string; child: ChildProcess }> {
  const child = spawn(process.execPath, [CLI, "--port", "0", "--db", db, ...args], { env: { ...clean(), ...env } });
  children.push(child);
  let out = "";
  return new Promise((ready, fail) => {
    child.stdout.on("data", (d) => {
      out += d;
      const url = / on (http:\/\/127\.0\.0\.1:\d+)/.exec(out)?.[1];
      if (url) ready({ url, out: () => out, child });
    });
    child.stderr.on("data", (d) => (out += d));
    child.on("exit", (code) => fail(new Error(`exited ${code}: ${out}`)));
  });
}

const stopped = (child: ChildProcess) => new Promise((done) => (child.once("exit", done), child.kill()));

const auth = (token: string) => ({ authorization: `Bearer ${token}`, "content-type": "application/json" });

/** Registers host `laptop` as agency-host would: its first report, then a heartbeat, up its socket. */
async function hostBeat(url: string, token: string) {
  const ws = new WebSocket(`${url.replace("http", "ws")}/socket?hostId=laptop`, { headers: { authorization: `Bearer ${token}` } });
  await new Promise((open, fail) => (ws.once("open", open), ws.once("error", fail)));
  ws.send(JSON.stringify({ type: "report", agents: [], lines: [], commandResults: [] }));
  ws.send(JSON.stringify({ type: "heartbeat", version: "t", labels: [], capacity: 1 }));
  for (let i = 0; i < 100; i++) {
    const { hosts } = (await (await fetch(`${url}/hosts`, { headers: auth(token) })).json()) as { hosts: unknown[] };
    if (hosts.length) break;
    await new Promise((r) => setTimeout(r, 20));
  }
  ws.close();
}

describe("agency serve", () => {
  it("serves the API on the database it is given, with the token in its environment", async () => {
    const dir = temp();
    const { url } = await serve(join(dir, "db", "as.db"), { AUTH_TOKEN: "a" });
    expect((await fetch(`${url}/health`)).status).toBe(200);
    expect((await fetch(`${url}/hosts`, { headers: auth("wrong") })).status).toBe(401);
    expect((await fetch(`${url}/hosts`, { headers: auth("a") })).status).toBe(200);
    expect(existsSync(join(dir, "db", "as.db"))).toBe(true);
  });

  it("says which token is missing, and answers 503 for what needs it", async () => {
    const { url, out } = await serve(join(temp(), "as.db"), {});
    expect(out()).toContain("AUTH_TOKEN not set");
    expect((await fetch(`${url}/hosts`, { headers: auth("a") })).status).toBe(503);
  });

  it("keeps hosts, agents and the commands pending for a host across a restart", async () => {
    const db = join(temp(), "as.db");
    const first = await serve(db, { AUTH_TOKEN: "a" });
    await hostBeat(first.url, "a");
    const made = await fetch(`${first.url}/agents`, { method: "POST", headers: auth("a"), body: JSON.stringify({ name: "kept", hostId: "laptop", brief: "Go." }) });
    expect(made.status, await made.clone().text()).toBe(201);
    const { id } = (await made.json()) as { id: string };
    await stopped(first.child);
    const second = await serve(db, { AUTH_TOKEN: "a" });
    const agent = (await (await fetch(`${second.url}/agents/${id}`, { headers: auth("a") })).json()) as { name: string; state: string };
    expect(agent).toMatchObject({ name: "kept", state: "working" });
    const store = Store.open(db);
    expect((await store.pending("laptop")).map((q) => q.command.kind)).toEqual(["create", "start"]);
    store.close();
  });

  it("gives a session the services its file names, each token from the variable it names", async () => {
    const dir = temp();
    const file = join(dir, "services.json");
    writeFileSync(file, JSON.stringify({ waypoint: { url: "https://waypoint.example/", urlVar: "WAYPOINT_URL", tokenVar: "WAYPOINT_TOKEN", tokenEnv: "WP_SECRET" } }));
    const { url, out } = await serve(join(dir, "as.db"), { AUTH_TOKEN: "a", WP_SECRET: "w" }, ["--services", file]);
    expect(out()).toContain("sessions may be given: agency, waypoint");
    await hostBeat(url, "a");
    const refused = await fetch(`${url}/agents`, { method: "POST", headers: auth("a"), body: JSON.stringify({ name: "x-1", hostId: "laptop", credentials: ["nothing"] }) });
    expect(await refused.text()).toContain("this stage has agency, waypoint.");
  });

  it("refuses a services file that is not one, saying why", () => {
    const dir = temp();
    const file = join(dir, "services.json");
    writeFileSync(file, JSON.stringify({ waypoint: { url: "not a url" } }));
    const done = spawnSync(process.execPath, [CLI, "--port", "0", "--db", join(dir, "as.db"), "--services", file], { env: clean(), encoding: "utf8", timeout: 10_000 });
    expect(done.status).toBe(1);
    expect(done.stderr).toContain("waypoint.url");
  });
});

describe("agency serve on a port already taken", () => {
  it("says so and exits 1", async () => {
    const { url } = await serve(join(temp(), "a.db"), {});
    const port = new URL(url).port;
    const done = spawnSync(process.execPath, [CLI, "--port", port, "--db", join(temp(), "b.db")], { env: clean(), encoding: "utf8", timeout: 10_000 });
    expect(done.status).toBe(1);
    expect(done.stderr).toContain(`agency: cannot serve on 127.0.0.1:${port}`);
  });
});

describe("agency backup", () => {
  it("copies the database to the file it names", async () => {
    const dir = temp();
    const store = Store.open(join(dir, "as.db"));
    await store.putHost({ id: "laptop", heartbeatAt: "t", version: null, labels: [], capacity: null });
    const done = spawnSync(process.execPath, [CLI, "backup", join(dir, "copy.db"), "--db", join(dir, "as.db")], { env: clean(), encoding: "utf8" });
    store.close();
    expect(done.status, done.stderr).toBe(0);
    const copy = Store.open(join(dir, "copy.db"));
    expect((await copy.listHosts()).map((h) => h.id)).toEqual(["laptop"]);
    copy.close();
  });
});
