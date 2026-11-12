import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
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
  const dir = mkdtempSync(join(tmpdir(), "agent-service-cli-"));
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

describe("agent-service serve", () => {
  it("serves the API on the database it is given, with the token in its environment", async () => {
    const dir = temp();
    const { url } = await serve(join(dir, "db", "as.db"), { AUTH_TOKEN: "a" });
    expect((await fetch(`${url}/health`)).status).toBe(200);
    expect((await fetch(`${url}/fleet/hosts`, { headers: auth("wrong") })).status).toBe(401);
    expect((await fetch(`${url}/fleet/hosts`, { headers: auth("a") })).status).toBe(200);
    expect(existsSync(join(dir, "db", "as.db"))).toBe(true);
  });

  it("says which token is missing, and answers 503 for what needs it", async () => {
    const { url, out } = await serve(join(temp(), "as.db"), {});
    expect(out()).toContain("AUTH_TOKEN and ADMIN_TOKEN not set");
    expect((await fetch(`${url}/fleet/hosts`, { headers: auth("a") })).status).toBe(503);
  });

  it("keeps hosts, workers and the commands pending for a host across a restart", async () => {
    const db = join(temp(), "as.db");
    const first = await serve(db, { AUTH_TOKEN: "a" });
    const beat = await fetch(`${first.url}/fleet/hosts/laptop/heartbeat`, { method: "POST", headers: auth("a"), body: JSON.stringify({ version: "t", labels: [], capacity: 1 }) });
    expect(beat.status).toBe(200);
    const made = await fetch(`${first.url}/fleet/workers`, { method: "POST", headers: auth("a"), body: JSON.stringify({ name: "kept", hostId: "laptop", brief: "Go." }) });
    expect(made.status, await made.clone().text()).toBe(201);
    const { id } = (await made.json()) as { id: string };
    await stopped(first.child);
    const second = await serve(db, { AUTH_TOKEN: "a" });
    const worker = (await (await fetch(`${second.url}/fleet/workers/${id}`, { headers: auth("a") })).json()) as { name: string; state: string };
    expect(worker).toMatchObject({ name: "kept", state: "working" });
    const commands = (await (await fetch(`${second.url}/fleet/workers/${id}/commands`, { headers: auth("a") })).json()) as { commands: { command: { kind: string }; delivery: string }[] };
    expect(commands.commands.map((c) => [c.command.kind, c.delivery])).toEqual([["create", "queued"], ["start", "queued"]]);
    const store = Store.open(db);
    expect((await store.pending("laptop")).map((q) => q.command.kind)).toEqual(["create", "start"]);
    store.close();
  });

  it("gives a session the services its file names, each token from the variable it names", async () => {
    const dir = temp();
    const file = join(dir, "services.json");
    writeFileSync(file, JSON.stringify({ waypoint: { url: "https://waypoint.example/", urlVar: "WAYPOINT_URL", tokenVar: "WAYPOINT_TOKEN", tokenEnv: "WP_SECRET" } }));
    const { url, out } = await serve(join(dir, "as.db"), { AUTH_TOKEN: "a", WP_SECRET: "w" }, ["--services", file]);
    expect(out()).toContain("services: waypoint");
    const refused = await fetch(`${url}/fleet/requests`, { method: "POST", headers: auth("a"), body: JSON.stringify({ role: "implementer", brief: "x", credentials: ["nothing"] }) });
    expect(await refused.text()).toContain("this stage has worker-service, waypoint.");
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

describe("agent-service serve on a port already taken", () => {
  it("says so and exits 1", async () => {
    const { url } = await serve(join(temp(), "a.db"), {});
    const port = new URL(url).port;
    const done = spawnSync(process.execPath, [CLI, "--port", port, "--db", join(temp(), "b.db")], { env: clean(), encoding: "utf8", timeout: 10_000 });
    expect(done.status).toBe(1);
    expect(done.stderr).toContain(`agent-service: cannot serve on 127.0.0.1:${port}`);
  });
});

describe("agent-service backup", () => {
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
