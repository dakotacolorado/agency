import { randomUUID } from "node:crypto";
import { OpenAPIHono } from "@hono/zod-openapi";
import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";
import {
  DURABLE,
  HEARTBEAT_INTERVAL,
  afterSession,
  available,
  cleared,
  delivery,
  expired,
  hostStatus,
  keepsPastSession,
  onceQuiet,
  quiet,
  unreachable,
  type Host,
  type Queued,
  type Sent,
  type WhenDone,
  type Agent,
} from "./domain.ts";
import * as routes from "./schema.ts";
import type { Command, Heartbeat, HeartbeatResponse, RequestView } from "./schema.ts";
import { NameTaken, Stale, type Change, type Store } from "./store.ts";
import { hash, same, ticket } from "./secret.ts";
import { Fleet, afresh, begin, hostView, inOrder, sentView, agentView } from "./fleet.ts";
import { NO_SOCKET, Push, type Poster } from "./push.ts";
import { CONTEXT_LIMIT, FETCH_LIMIT, NO_CONTEXT, type Attached, type ContextSource } from "./context.ts";
import { Credentials, selfCredential, type Credential } from "./credentials.ts";
import type { AgentSecrets } from "./agent-secrets.ts";
import { ownSkill, type Skill } from "./skill.ts";
import { NO_SKILLS, type SkillSource } from "./skills.ts";
import { rolesOf, type Role } from "./roles.ts";
import { inStartOrder, nameFor, usageAdmits, type AgentRequest } from "./admission.ts";

export const SPEC_PATH = "/openapi.json";

/** What answers without a token: whether it is up, and what it serves. */
export const OPEN_PATHS = ["/health", SPEC_PATH];

export interface TokenSource {
  value(): Promise<string | null>;
}

/** No admin token: nothing that takes one can be done. */
export const NO_TOKEN: TokenSource = { value: async () => null };

/** A token fixed for the life of the process, as its environment gave it; null for none. */
export const fixedToken = (value: string | null | undefined): TokenSource => ({ value: async () => value || null });

export interface ApiOptions {
  now?: () => Date;
  /** Posts to sockets; without one, no command reaches a host and pages poll. */
  poster?: Poster;
  /** This service's address as agents and hosts reach it; without one, the address each request came to. */
  publicUrl?: string | null;
  /** The socket's `wss://` address, given to hosts and pages; null where there is none. */
  socketUrl?: string | null;
  /** What every session starts with; without one, nothing is attached. */
  context?: ContextSource;
  /** The services' clients laid over the context; without one, the context's own copies stay. */
  skills?: SkillSource;
  /** This deployment's own clients, as `GET /skill` serves them. */
  skill?: () => Skill;
  /** The services an agent may be given, by name; without them, only this one. */
  credentials?: Record<string, Credential>;
  /** Where a token a caller gives one agent is kept; without it, none can be given. */
  agentSecrets?: AgentSecrets;
  /** A person's token: it does all the stage's token does, and may write roles. Without one, no role is written. */
  admin?: TokenSource;
}

export class AgentServiceApi {
  readonly hono: OpenAPIHono;

  private readonly store: Store;
  private readonly token: TokenSource;
  private readonly admin: TokenSource;
  private readonly now: () => Date;
  private readonly fleet: Fleet;
  private readonly socketUrl: string | null;
  private readonly publicUrl: string | null;

  private readonly context: ContextSource;
  private readonly skills: SkillSource;
  private readonly skill: () => Skill;

  constructor(store: Store, token: TokenSource, options: ApiOptions = {}) {
    this.store = store;
    this.token = token;
    this.admin = options.admin ?? NO_TOKEN;
    this.now = options.now ?? (() => new Date());
    this.socketUrl = options.socketUrl ?? null;
    this.publicUrl = options.publicUrl?.replace(/\/$/, "") ?? null;
    this.context = options.context ?? NO_CONTEXT;
    this.skills = options.skills ?? NO_SKILLS;
    this.skill = options.skill ?? ownSkill;
    this.fleet = new Fleet(
      store,
      new Push(store, options.poster ?? NO_SOCKET),
      this.now,
      new Credentials(options.credentials ?? { "agent-service": selfCredential(token) }, options.agentSecrets),
    );
    this.hono = new OpenAPIHono({
      defaultHook: (result, c) =>
        result.success ? undefined : c.json({ error: issues(result.error) }, 400),
    });
    this.auth();
    this.routes();
    this.spec();
  }

  /** This service's address as agents reach it: the one it was given, else the one the request came to. */
  private origin(c: Context): string {
    return this.publicUrl ?? new URL(c.req.url).origin;
  }

  get fetch() {
    return this.hono.fetch;
  }

  private auth(): void {
    this.hono.use("/*", async (c, next) => {
      if (OPEN_PATHS.includes(c.req.path)) return next();
      const token = await this.token.value();
      if (!token) return c.json({ error: "API token is not configured." }, 503);
      const given = c.req.header("authorization") ?? "";
      if (!same(given, `Bearer ${token}`) && !(await this.isAdmin(given))) {
        return c.json({ error: "Unauthorized." }, 401);
      }
      await next();
    });
  }

  private async isAdmin(authorization: string): Promise<boolean> {
    const admin = await this.admin.value();
    return admin !== null && same(authorization, `Bearer ${admin}`);
  }

  /** The seeded roles with those written laid over them. */
  async roles(): Promise<Role[]> {
    return rolesOf(await this.store.listRoles());
  }

  async role(name: string): Promise<Role | null> {
    return (await this.roles()).find((role) => role.name === name) ?? null;
  }

  /** Why a role naming these cannot be kept, or null. */
  private async unfit(role: Pick<Role, "documents" | "credentials">): Promise<string | null> {
    return (role.credentials && this.fleet.credentials.refuse(role.credentials)) || (await this.context.refuse(role.documents));
  }

  private routes(): void {
    const app = this.hono;

    app.openapi(routes.healthRoute, (c) => c.json({ ok: true } as const, 200));

    app.openapi(routes.getSkillRoute, (c) => c.json(this.skill(), 200));

    app.openapi(routes.heartbeatRoute, async (c) => {
      const answer = await this.heartbeat(c.req.valid("param").id, c.req.valid("json"));
      await this.admitting(this.origin(c));
      return c.json(answer, 200);
    });

    app.openapi(routes.listHostsRoute, async (c) => {
      const statuses = c.req.valid("query").status?.split(",");
      const now = this.now();
      const agents = await this.store.listAgents();
      const hosts = (await this.store.listHosts())
        .filter((host) => !statuses || statuses.includes(hostStatus(host.heartbeatAt, now)))
        .map((host) => hostView(host, agents, now));
      return c.json({ hosts }, 200);
    });

    app.openapi(routes.deleteHostRoute, async (c) => {
      const { id } = c.req.valid("param");
      if (!(await this.store.getHost(id))) return c.json({ error: "No host has this id." }, 404);
      await this.store.deleteHost(id);
      return c.body(null, 204);
    });

    app.openapi(routes.listRolesRoute, async (c) => c.json({ roles: await this.roles() }, 200));

    app.openapi(routes.getRoleRoute, async (c) => {
      const role = await this.role(c.req.valid("param").name);
      if (!role) return c.json({ error: "No role has this name." }, 404);
      return c.json(role, 200);
    });

    app.openapi(routes.createRoleRoute, async (c) => {
      if (!(await this.isAdmin(c.req.header("authorization") ?? ""))) {
        return c.json({ error: "Writing a role takes the stage's admin token." }, 403);
      }
      const body = c.req.valid("json");
      if (await this.role(body.name)) return c.json({ error: `A role named ${body.name} exists already.` }, 409);
      const role: Role = {
        name: body.name,
        documents: body.documents ?? [],
        credentials: body.credentials ?? null,
        whenDone: body.whenDone ?? "keep",
        label: body.label,
        priority: body.priority ?? 0,
        brief: body.brief ?? null,
        description: body.description ?? null,
        updatedAt: this.now().toISOString(),
      };
      const unfit = await this.unfit(role);
      if (unfit) return c.json({ error: unfit }, 400);
      await this.store.putRole(role);
      return c.json(role, 201);
    });

    app.openapi(routes.updateRoleRoute, async (c) => {
      if (!(await this.isAdmin(c.req.header("authorization") ?? ""))) {
        return c.json({ error: "Writing a role takes the stage's admin token." }, 403);
      }
      const held = await this.role(c.req.valid("param").name);
      if (!held) return c.json({ error: "No role has this name." }, 404);
      const changes = Object.fromEntries(Object.entries(c.req.valid("json")).filter(([, value]) => value !== undefined));
      const role: Role = { ...held, ...changes, updatedAt: this.now().toISOString() };
      const unfit = await this.unfit(role);
      if (unfit) return c.json({ error: unfit }, 400);
      await this.store.putRole(role);
      return c.json(role, 200);
    });

    app.openapi(routes.createRequestRoute, async (c) => {
      const asked = c.req.valid("json");
      const role = await this.role(asked.role);
      if (!role) return c.json({ error: `This stage has no role named ${asked.role}.` }, 400);
      if (asked.brief === undefined && role.brief === null) {
        return c.json({ error: `The ${role.name} role has no brief of its own, so a request for one needs \`brief\`.` }, 400);
      }
      const credentials = asked.credentials?.map((each) => (typeof each === "string" ? each : each.name)) ?? null;
      const unknown = credentials && this.fleet.credentials.refuse(credentials);
      if (unknown) return c.json({ error: unknown }, 400);
      const given = credentials ?? role.credentials ?? this.fleet.credentials.defaults;
      const tokens = asked.tokens ?? [];
      const ungiven = tokens.filter((t) => !given.includes(t.name)).map((t) => t.name);
      if (ungiven.length) return c.json({ error: `A token is only for a service the agent is given; ${ungiven.join(", ")} is not among ${given.join(", ") || "none"}.` }, 400);
      const own = [...(asked.credentials ?? []).flatMap((each) => (typeof each === "string" ? [] : [each])), ...tokens];
      if (new Set(own.map((each) => each.name)).size !== own.length) return c.json({ error: "Give each service's token once, in `credentials` or `tokens`." }, 400);
      const id = randomUUID();
      try {
        for (const each of own) await this.fleet.credentials.own.put(id, each.name, each.token);
      } catch (err) {
        await this.fleet.credentials.own.remove(id, own.map((each) => each.name)).catch(() => {});
        console.error("Could not keep a request's own credential:", (err as Error).name);
        return c.json({ error: `A credential of the agent's own could not be kept: ${(err as Error).message}` }, 503);
      }
      await this.store.putRequest({
        id,
        role: role.name,
        brief: asked.brief ?? null,
        item: asked.item ?? null,
        subject: asked.subject ?? null,
        label: asked.label ?? null,
        labels: asked.labels ?? [],
        credentials,
        ownCredentials: own.map((each) => each.name),
        requester: c.req.valid("header")["claimed-by"] ?? null,
        state: "waiting",
        why: null,
        createdAt: this.now().toISOString(),
        startedAt: null,
        agentId: null,
        withdrawnAt: null,
      });
      await this.admitting(this.origin(c));
      return c.json((await this.requestViews()).find((view) => view.id === id)!, 201);
    });

    app.openapi(routes.listRequestsRoute, async (c) => {
      const { all, requester, item } = c.req.valid("query");
      const requests = (await this.requestViews()).filter(
        (r) =>
          (all === "true" || r.state === "waiting") &&
          (requester === undefined || r.requester === requester) &&
          (item === undefined || r.item === item),
      );
      return c.json({ requests }, 200);
    });

    app.openapi(routes.getRequestRoute, async (c) => {
      const view = (await this.requestViews()).find((r) => r.id === c.req.valid("param").id);
      if (!view) return c.json({ error: "No request has this id." }, 404);
      return c.json(view, 200);
    });

    app.openapi(routes.withdrawRequestRoute, async (c) => {
      const { id } = c.req.valid("param");
      for (;;) {
        const request = await this.store.getRequest(id);
        if (!request) return c.json({ error: "No request has this id." }, 404);
        if (request.state !== "waiting") return c.json({ error: `This request is ${request.state} already.` }, 409);
        try {
          await this.store.putRequest({ ...request, state: "withdrawn", why: null, withdrawnAt: this.now().toISOString() });
        } catch (err) {
          // Admitted or withdrawn since it was read: read it again to say which.
          if (err instanceof Stale) continue;
          throw err;
        }
        await this.fleet.credentials.own.remove(id, request.ownCredentials).catch((err) => {
          console.error(`Could not delete ${id}'s own credentials:`, (err as Error).name);
        });
        return c.json((await this.requestViews()).find((r) => r.id === id)!, 200);
      }
    });

    app.openapi(routes.createAgentRoute, async (c) => {
      const asked = c.req.valid("json");
      const role = asked.role === undefined ? null : await this.role(asked.role);
      if (asked.role !== undefined && !role) return c.json({ error: `This stage has no role named ${asked.role}.` }, 400);
      const made = await this.make(this.origin(c), { ...asked, role, createdBy: c.req.valid("header")["claimed-by"] ?? null });
      if ("refused" in made) return c.json({ error: made.refused }, made.status);
      return c.json(agentView(made.agent, made.host, this.now()), 201);
    });

    app.openapi(routes.listAgentsRoute, async (c) => {
      const { createdBy, all, item, role } = c.req.valid("query");
      const now = this.now();
      const hosts = new Map((await this.store.listHosts()).map((h) => [h.id, h]));
      const agents = (await this.store.listAgents())
        .filter(
          (w) =>
            (createdBy === undefined || w.createdBy === createdBy) &&
            (item === undefined || w.item === item) &&
            (role === undefined || w.role === role) &&
            (all === "true" || item !== undefined || w.state !== "retired"),
        )
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
        .map((w) => agentView(w, hosts.get(w.hostId) ?? null, now));
      return c.json({ agents }, 200);
    });

    app.openapi(routes.getAgentRoute, async (c) => {
      const agent = await this.store.getAgent(c.req.valid("param").id);
      if (!agent) return c.json({ error: "No agent has this id." }, 404);
      return c.json(agentView(agent, await this.store.getHost(agent.hostId), this.now()), 200);
    });

    app.openapi(routes.messageAgentRoute, async (c) => afresh(async () => {
      const { text, interrupt } = c.req.valid("json");
      const agent = await this.store.getAgent(c.req.valid("param").id);
      if (!agent) return c.json({ error: "No agent has this id." }, 404);
      if (agent.state === "retired") return c.json({ error: `${agent.name} is retired.` }, 409);
      const ready = await this.reachable(agent);
      if (typeof ready === "string") return c.json({ error: ready }, 409);
      const now = this.now();
      if (agent.session) {
        const id = randomUUID();
        const command: Command = interrupt
          ? { kind: "interrupt", id, agentId: agent.id, ...(text !== undefined && { text }) }
          : // Without interrupt, the schema requires text, which its type does not say.
            { kind: "message", id, agentId: agent.id, text: text! };
        // Told something, an agent waiting on the person, in review or done, is at work again.
        // At work from the moment it is told, as from a start: its host reports the turn once it begins.
        const answered: Agent[] = [{ ...agent, ...cleared, state: "working" }];
        await this.fleet.apply({ agents: answered, queue: inOrder(agent.hostId, [command], now), guarded: true });
        return c.json({ commandId: id }, 202);
      }
      if (text === undefined) {
        return c.json({ error: `${agent.name} is ${agent.state}, with no session to interrupt.` }, 409);
      }
      return this.start(c, agent, ready, text);
    }));

    app.openapi(routes.stopAgentRoute, async (c) => afresh(async () => {
      const force = c.req.valid("json")?.force === true;
      const agent = await this.store.getAgent(c.req.valid("param").id);
      if (!agent) return c.json({ error: "No agent has this id." }, 404);
      if (!agent.session) {
        return c.json({ error: `${agent.name} is ${agent.state}, with no session to stop.` }, 409);
      }
      const now = this.now();
      // A lost or deregistered host cannot be told, so its session is ended on record, as `force` does.
      if (force || typeof (await this.reachable(agent)) === "string") {
        await this.forceStop(agent, now);
        return c.json({ commandId: null }, 202);
      }
      const command: Command = { kind: "stop", id: randomUUID(), agentId: agent.id };
      await this.fleet.apply({ queue: inOrder(agent.hostId, [command], now) });
      return c.json({ commandId: command.id }, 202);
    }));

    app.openapi(routes.resumeAgentRoute, async (c) => afresh(async () => {
      const agent = await this.store.getAgent(c.req.valid("param").id);
      if (!agent) return c.json({ error: "No agent has this id." }, 404);
      if (agent.state === "retired") return c.json({ error: `${agent.name} is retired.` }, 409);
      if (agent.session) {
        return c.json({ error: `${agent.name} is ${agent.state}, in a live session already.` }, 409);
      }
      const ready = await this.reachable(agent);
      if (typeof ready === "string") return c.json({ error: ready }, 409);
      return this.start(c, agent, ready);
    }));

    app.openapi(routes.renameAgentRoute, async (c) => afresh(async () => {
      const { name, title, label } = c.req.valid("json");
      const agent = await this.store.getAgent(c.req.valid("param").id);
      if (!agent) return c.json({ error: "No agent has this id." }, 404);
      if (agent.state === "retired") return c.json({ error: `${agent.name} is retired.` }, 409);
      const view = async (w: Agent) => agentView(w, await this.store.getHost(w.hostId), this.now());
      const renamed = {
        ...agent,
        ...(name !== undefined && { name }),
        ...(title !== undefined && { title }),
        ...(label !== undefined && { label }),
      };
      const newName = name !== undefined && name !== agent.name;
      const kept = (field: "title" | "label") => (agent[field] ?? null) === (renamed[field] ?? null);
      if (!newName && kept("title") && kept("label")) return c.json(await view(agent), 200);
      try {
        await this.fleet.apply({
          agents: [renamed],
          ...(newName && { claim: { name, agentId: agent.id }, release: agent.name }),
          guarded: true,
        });
      } catch (err) {
        if (!(err instanceof NameTaken)) throw err;
        return c.json({ error: `An agent not retired is already named ${name}.` }, 409);
      }
      return c.json(await view(renamed), 200);
    }));

    app.openapi(routes.retireAgentRoute, async (c) => afresh(async () => {
      const agent = await this.store.getAgent(c.req.valid("param").id);
      if (!agent) return c.json({ error: "No agent has this id." }, 404);
      if (agent.state === "retired") return c.json({ error: `${agent.name} is retired already.` }, 409);
      return c.json({ commandId: await this.retire(agent) }, 202);
    }));

    // Every write of an agent read here is guarded and read again on a conflict, so it and a host's report
    // each see the other, whichever lands first.
    app.openapi(routes.setAgentStatusRoute, async (c) => afresh(async () => {
      const { status, summary, headline } = c.req.valid("json");
      const agent = await this.store.getAgent(c.req.valid("param").id);
      if (!agent) return c.json({ error: "No agent has this id." }, 404);
      if (agent.state === "retired") return c.json({ error: `${agent.name} is retired.` }, 409);
      if (!agent.session && !keepsPastSession(status)) {
        return c.json({ error: `${agent.name} is ${agent.state}, with no live session to be ${status}.` }, 409);
      }
      const said: Agent = { ...agent, status, summary, headline: headline ?? null, saidAt: this.now().toISOString() };
      // Mid-turn, what its maker asked be done waits for the turn and its background tasks to end; see `Fleet.report`.
      const then = quiet(said) ? onceQuiet(said) : null;
      if (then === "retire") {
        await this.retire(said);
        return c.json(agentView((await this.store.getAgent(agent.id))!, await this.store.getHost(agent.hostId), this.now()), 200);
      }
      const stop: Command[] = then === "stop" && said.session ? [{ kind: "stop", id: randomUUID(), agentId: agent.id }] : [];
      await this.fleet.apply({ agents: [said], queue: inOrder(agent.hostId, stop, this.now()), guarded: true });
      return c.json(agentView(said, await this.store.getHost(agent.hostId), this.now()), 200);
    }));

    app.openapi(routes.setAgentTitleRoute, async (c) => afresh(async () => {
      const { title } = c.req.valid("json");
      const agent = await this.store.getAgent(c.req.valid("param").id);
      if (!agent) return c.json({ error: "No agent has this id." }, 404);
      if (agent.state === "retired") return c.json({ error: `${agent.name} is retired.` }, 409);
      if (agent.title) {
        return c.json({ error: `${agent.name} is titled "${agent.title}" already; only the person changes it.` }, 409);
      }
      const titled: Agent = { ...agent, title };
      await this.fleet.apply({ agents: [titled], guarded: true });
      return c.json(agentView(titled, await this.store.getHost(agent.hostId), this.now()), 200);
    }));

    app.openapi(routes.transcriptRoute, async (c) => {
      const { id } = c.req.valid("param");
      const { after, limit } = c.req.valid("query");
      const afterSeq = after === undefined ? -1 : seqAfter(after);
      if (afterSeq === undefined) {
        return c.json({ error: "after: not a cursor this route issued." }, 400);
      }
      if (!(await this.store.getAgent(id))) return c.json({ error: "No agent has this id." }, 404);
      const lines = await this.store.readLines(id, afterSeq, limit ?? 500);
      return c.json({ lines, next: cursorAfter(lines.at(-1)?.seq ?? afterSeq) }, 200);
    });

    app.openapi(routes.listSessionsRoute, async (c) => {
      const { id } = c.req.valid("param");
      if (!(await this.store.getAgent(id))) return c.json({ error: "No agent has this id." }, 404);
      return c.json({ sessions: await this.store.sessionsOf(id) }, 200);
    });

    app.openapi(routes.getSessionContextRoute, async (c) => {
      const { id, sessionId } = c.req.valid("param");
      const agent = await this.store.getAgent(id);
      if (!agent) return c.json({ error: "No agent has this id." }, 404);
      const session = agent.session?.id === sessionId && (await this.store.sessionsOf(id)).find((s) => s.id === sessionId);
      if (!session) return c.json({ error: "This session is not the agent's live one." }, 409);
      const read = await this.attach(this.origin(c), agent, FETCH_LIMIT);
      await this.fleet.apply({
        sessions: [{
          ...session,
          context: read.context && { key: read.context.key, version: read.context.version },
          documents: read.documents.map(({ key, version }) => ({ key, version })),
          skills: read.skills,
          contextNote: read.note,
        }],
      });
      return c.json({ context: read.context, documents: read.documents }, 200);
    });

    app.openapi(routes.listAgentCommandsRoute, async (c) => {
      const { id } = c.req.valid("param");
      if (!(await this.store.getAgent(id))) return c.json({ error: "No agent has this id." }, 404);
      const now = this.now();
      const commands = (await this.store.sentTo(id))
        .filter((sent) => !expired(sent, now))
        .map((sent) => sentView(sent, now));
      return c.json({ commands }, 200);
    });

    app.openapi(routes.getUsageRoute, async (c) => c.json(await this.fleet.usage(), 200));

    app.openapi(routes.socketTicketRoute, async (c) => {
      if (!this.socketUrl) return c.json({ error: "This server has no socket." }, 503);
      const issued = ticket();
      const expiresAt = new Date(this.now().getTime() + routes.TICKET_TTL * 1000).toISOString();
      await this.store.putTicket(hash(issued), expiresAt);
      return c.json({ ticket: issued, socketUrl: this.socketUrl, expiresAt }, 201);
    });

    // Hono throws HTTPException for a malformed body before any handler runs;
    // collapsing this to 500 would report a bad request as our failure.
    app.onError((err, c) => {
      if (err instanceof HTTPException) {
        return c.json({ error: err.message || "Bad request." }, err.status);
      }
      console.error("Unhandled error:", err);
      return c.json({ error: "Internal error." }, 500);
    });
  }

  private async heartbeat(id: string, heartbeat: Heartbeat): Promise<HeartbeatResponse> {
    const was = await this.store.getHost(id);
    const host: Host = {
      id,
      heartbeatAt: this.now().toISOString(),
      version: heartbeat.version,
      labels: heartbeat.labels ?? was?.labels ?? [],
      capacity: heartbeat.capacity ?? null,
    };
    await this.store.putHost(host);
    await this.fleet.push.toViewers([
      { type: "host", host: hostView(host, await this.store.listAgents(), this.now()) },
    ]);
    return { heartbeatInterval: HEARTBEAT_INTERVAL, socketUrl: this.socketUrl };
  }

  /** Every request as served: the waiting in start order, each with its place, then the rest newest first. */
  private async requestViews(): Promise<RequestView[]> {
    const roles = await this.roles();
    const priority = new Map(roles.map((role) => [role.name, role.priority]));
    const requests = await this.store.listRequests();
    const waiting = inStartOrder(requests.filter((r) => r.state === "waiting"), roles);
    const rest = requests.filter((r) => r.state !== "waiting").sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return [...waiting, ...rest].map(({ rev: _, ownCredentials: __, ...request }) => ({
      ...request,
      priority: priority.get(request.role) ?? 0,
      position: request.state === "waiting" ? waiting.findIndex((w) => w.id === request.id) + 1 : null,
    }));
  }

  /** Admission, whose failure is logged and never fails what ran it: the next heartbeat runs it again. */
  private async admitting(self: string): Promise<void> {
    try {
      await this.admit(self);
    } catch (err) {
      console.error("Admission failed:", err);
    }
  }

  /**
   * Starts what usage and the hosts allow of the waiting requests, in start
   * order, and says of each one left why it waits. Each is claimed before its
   * agent is made, so two admissions running at once never start one twice.
   */
  async admit(self: string): Promise<void> {
    const requests = await this.store.listRequests();
    const waiting = requests.filter((r) => r.state === "waiting");
    if (!waiting.length) return;
    const roles = await this.roles();
    const now = this.now();
    const starts = requests.flatMap((r) => (r.startedAt ? [Date.parse(r.startedAt)] : []));
    const admits = usageAdmits(await this.fleet.usage(), now, starts.length ? new Date(Math.max(...starts)) : null);
    let blocked = "none" in admits ? admits.none : null;
    const waits = async (request: AgentRequest, why: string) => {
      if (request.why === why) return;
      await this.store.putRequest({ ...request, why }).catch((err) => {
        if (!(err instanceof Stale)) throw err;
      });
    };
    for (const request of inStartOrder(waiting, roles)) {
      if (blocked) {
        await waits(request, blocked);
        continue;
      }
      const role = roles.find((r) => r.name === request.role);
      if (!role) {
        await waits(request, `Waits on its role: this stage has no role named ${request.role}.`);
        continue;
      }
      const placed = await this.place(request.labels);
      if (typeof placed !== "string") {
        await waits(request, `Waits on a host: ${placed.none.replace("; nothing was made.", ".")}`);
        continue;
      }
      let claimed: AgentRequest;
      try {
        claimed = await this.store.putRequest({ ...request, state: "started", why: null, startedAt: now.toISOString(), agentId: request.id });
      } catch (err) {
        if (err instanceof Stale) continue;
        throw err;
      }
      const putBack = (why: string) =>
        this.store.putRequest({ ...claimed, state: "waiting", startedAt: null, agentId: null, why });
      const made = await this.make(self, {
        id: request.id,
        name: nameFor(request),
        role,
        hostId: placed,
        ...(request.brief !== null && { brief: request.brief }),
        ...(request.label !== null && { label: request.label }),
        ...(request.item !== null && { item: request.item }),
        ...(request.credentials !== null && { credentials: request.credentials }),
        kept: request.ownCredentials,
        createdBy: request.requester,
      }).catch(async (err) => {
        await putBack(`Could not start: ${(err as Error).message}`);
        throw err;
      });
      // Put back to wait, saying why, for the next admission to try again.
      if ("refused" in made) await putBack(`Could not start: ${made.refused}`);
      else if ("one" in admits) blocked = "Waits on usage: the last reading is stale, and the agent just started will give a new one.";
    }
  }

  /**
   * Records an agent and queues its `create`, and with a brief its `start`. What is
   * given overrides the role's, field by field, so callers that name everything keep working.
   */
  private async make(self: string, asked: NewAgent): Promise<{ agent: Agent; host: Host } | { refused: string; status: 400 | 404 | 409 | 503 }> {
    const { role, item, labels } = asked;
    const name = asked.name;
    const brief = asked.brief ?? role?.brief ?? undefined;
    const label = asked.label ?? role?.label;
    const whenDone = asked.whenDone ?? role?.whenDone;
    const documents = asked.documents ?? role?.documents ?? [];
    const given = asked.credentials ?? role?.credentials ?? undefined;
    const credentials = given?.map((each) => (typeof each === "string" ? each : each.name));
    // A request's own tokens were kept under its id, which is the agent's, when it was made.
    const own = asked.kept ? [] : (given ?? []).flatMap((each) => (typeof each === "string" ? [] : [each]));
    const ownNames = asked.kept ?? own.map((each) => each.name);
    const placed = asked.hostId ?? (await this.place(labels ?? []));
    if (typeof placed !== "string") return { refused: placed.none, status: 503 };
    const hostId = placed;
    const host = await this.store.getHost(hostId);
    if (!host) return { refused: `No host has the id ${hostId}.`, status: 404 };
    const now = this.now();
    const at = now.toISOString();
    const gone = unreachable(host, hostId, now);
    if (gone) return { refused: gone, status: 409 };
    const unknown = (credentials && this.fleet.credentials.refuse(credentials)) || (await this.context.refuse(documents));
    if (unknown) return { refused: unknown, status: 400 };
    if (brief !== undefined) {
      const full = await this.full(host);
      if (full) return { refused: full, status: 409 };
    }
    const id = asked.id ?? randomUUID();
    let agent: Agent = {
      id,
      name,
      hostId,
      label: label ?? null,
      item: item ?? null,
      role: role?.name ?? null,
      createdBy: asked.createdBy,
      whenDone: whenDone ?? "keep",
      documents,
      ...(credentials && { credentials }),
      ...(ownNames.length && { ownCredentials: ownNames }),
      state: "idle",
      session: null,
      createdAt: at,
      reportedAt: null,
      hadSession: false,
    };
    const commands: Command[] = [{ kind: "create", id: randomUUID(), agentId: id, name }];
    const sessions = [];
    if (brief !== undefined) {
      const started = await this.starting(self, agent, at, brief);
      if ("refused" in started) return { refused: started.refused, status: 409 };
      agent = started.agent;
      sessions.push(started.session);
      commands.push(started.command);
    }
    // Kept before the agent is recorded, so its first start, pushed as it is, finds them.
    try {
      for (const each of own) await this.fleet.credentials.own.put(id, each.name, each.token);
    } catch (err) {
      await this.fleet.credentials.own.remove(id, own.map((each) => each.name)).catch(() => {});
      console.error("Could not keep an agent's own credential:", (err as Error).name);
      return { refused: `A credential of the agent's own could not be kept: ${(err as Error).message}`, status: 503 };
    }
    try {
      await this.fleet.apply({
        agents: [agent],
        sessions,
        queue: inOrder(hostId, commands, now),
        claim: { name, agentId: id },
      });
    } catch (err) {
      await this.fleet.credentials.own.remove(id, own.map((each) => each.name)).catch(() => {});
      if (!(err instanceof NameTaken)) throw err;
      return { refused: `An agent not retired is already named ${name}.`, status: 409 };
    }
    return { agent, host };
  }

  /**
   * The context, and the addresses of the services the agent is given, `self`
   * this service's.
   */
  private async attach(self: string, agent: Agent, limit?: number): Promise<Attached> {
    const credentials = agent.credentials ?? this.fleet.credentials.defaults;
    const skills = await this.skills.forSession(credentials);
    const read = await this.context.forSession(agent.documents ?? [], skills.skills, limit);
    const notes = [...skills.notes, ...(read.note ? [read.note] : [])];
    const env = this.fleet.credentials.addresses(credentials, self);
    return { ...read, note: notes.length ? notes.join("; ") : null, env, credentials, ownCredentials: agent.ownCredentials ?? [] };
  }

  /**
   * A new session, its context in its start when the whole fits a socket
   * message. When it does not, the start carries what fits, for a host that
   * cannot read more, and `contextUrl`, where a host that can reads the whole.
   * Refused when not even the whole can be read whole.
   */
  private async starting(self: string, agent: Agent, at: string, text?: string): Promise<ReturnType<typeof begin> | { refused: string }> {
    const whole = await this.attach(self, agent, FETCH_LIMIT);
    if (whole.cut) return { refused: `Its context cannot be given whole, so no session was started: ${whole.note}` };
    // Laid within FETCH_LIMIT and no larger than CONTEXT_LIMIT, it is what laying within CONTEXT_LIMIT gives.
    const bytes = [whole.context, ...whole.documents].reduce((n, doc) => n + (doc ? Buffer.byteLength(JSON.stringify(doc)) : 0), 0);
    if (bytes <= CONTEXT_LIMIT) return begin(agent, at, text, whole);
    const inline = await this.attach(self, agent);
    const started = begin(agent, at, text, {
      ...inline,
      note: `${inline.note}, in its start; its host is to read the whole from contextUrl, and this note stays only if it did not`,
    });
    if (started.command.kind !== "start") throw new Error("begin made no start");
    const contextUrl = `/agents/${agent.id}/sessions/${started.session.id}/context`;
    return { ...started, command: { ...started.command, contextUrl } };
  }

  /**
   * Records it retired at once, ends any session, frees its name, and queues
   * a `stop` if it had a live session and then `retire`. Returns the `retire`'s id.
   */
  private retire(agent: Agent): Promise<string> {
    return this.fleet.retire(agent);
  }

  /** The agent's host, or why nothing can be sent to it. */
  private async reachable(agent: Agent): Promise<Host | string> {
    const host = await this.store.getHost(agent.hostId);
    return unreachable(host, agent.hostId, this.now()) ?? host!;
  }

  /**
   * A connected host carrying every one of `labels` with room for a session,
   * the one with the most first, or why there is none.
   */
  private async place(labels: string[]): Promise<string | { none: string }> {
    const now = this.now();
    const agents = await this.store.listAgents();
    const [best] = (await this.store.listHosts())
      .filter((host) => hostStatus(host.heartbeatAt, now) === "connected" && labels.every((l) => host.labels.includes(l)))
      .map((host) => ({ id: host.id, room: available(host, agents) ?? 0 }))
      .filter(({ room }) => room > 0)
      .sort((a, b) => b.room - a.room || a.id.localeCompare(b.id));
    if (best) return best.id;
    const carrying = labels.length ? `, carrying ${labels.join(", ")},` : "";
    return { none: `No connected host${carrying} has room for an agent; nothing was made.` };
  }

  /** Why the host has no room for another session, or null when it has. */
  private async full(host: Host): Promise<string | null> {
    return available(host, await this.store.listAgents()) === 0
      ? `${host.id} is running all ${host.capacity} sessions it will.`
      : null;
  }

  private async start(c: Context, agent: Agent, host: Host, text?: string) {
    const full = await this.full(host);
    if (full) return c.json({ error: full }, 409);
    const now = this.now();
    const started = await this.starting(this.origin(c), agent, now.toISOString(), text);
    if ("refused" in started) return c.json({ error: started.refused }, 409);
    await this.fleet.apply({
      agents: [started.agent],
      sessions: [started.session],
      queue: inOrder(agent.hostId, [started.command], now),
      guarded: true,
    });
    return c.json({ commandId: started.command.id }, 202);
  }

  /**
   * Recorded at once, and everything queued for the agent but its home is
   * withdrawn. Should its host start or keep the session anyway, the next
   * report of it is answered with a `stop`.
   */
  private async forceStop(agent: Agent, now: Date): Promise<void> {
    const at = now.toISOString();
    await this.fleet.apply({
      agents: [{ ...agent, state: "idle", session: null, ...afterSession(agent) }],
      sessions: [{ ...agent.session!, agentId: agent.id, endedAt: at, ended: "stopped" }],
      guarded: true,
    });
    for (const queued of await this.store.pending(agent.hostId)) {
      if (queued.command.agentId !== agent.id || DURABLE.includes(queued.command.kind)) continue;
      await this.fleet.settle(agent.hostId, { ...queued, reportedAt: null, ok: null, error: null, withdrawnAt: at });
    }
  }

  private spec(): void {
    const registry = this.hono.openAPIRegistry;
    registry.registerComponent("securitySchemes", "bearerAuth", { type: "http", scheme: "bearer" });
    registry.register("SocketInbound", routes.SocketInboundSchema);
    registry.register("SocketOutbound", routes.SocketOutboundSchema);
    this.hono.doc31(SPEC_PATH, {
      openapi: "3.1.0",
      info: {
        version: "0.1.0",
        title: "agent-service",
        description:
          "The API for agents: lasting agents, each living on one host, run in sessions. Hosts " +
          "send a heartbeat every 30 seconds, which keeps them `connected` and says what they " +
          "offer. Clients read state and issue commands. Every route under every route needs the " +
          "stage's bearer token.\n\n" +
          "Commands and reports go by WebSocket at `socketUrl` alone: a host connects with " +
          "`?hostId=<id>` and the stage's token as `Authorization: Bearer`, a page with " +
          "`?ticket=<one-time ticket>` from `createSocketTicket`. What goes up is a " +
          "`SocketInbound` (`report`, `ping`), and what comes down a `SocketOutbound`: a host's " +
          "sockets get each `command` as it is queued, and a host's socket, once open, every " +
          "command still pending for it; every viewer gets each `agent` as it changes, `lines` " +
          "as they arrive and the `host` on each heartbeat. A command stays queued until a " +
          "report names it, so a dropped socket loses nothing: it is replayed on the next.\n\n" +
          "No body carries the server's time: a response's `Date` header is when it was made, " +
          "and so when a host's `status` was computed.",
      },
      tags: [
        { name: routes.AUDIENCES.host, description: "Called by hosts: stay connected, say what they offer." },
        { name: routes.AUDIENCES.reading, description: "Called by clients to read state." },
        { name: routes.AUDIENCES.acting, description: "Called by clients to create agents and send them commands." },
        { name: routes.AUDIENCES.agent, description: "Called by an agent, from its session, to say what it is doing." },
        { name: "meta" },
      ],
    });
  }
}



/** What an agent is made with: a `createAgent` body, its role read, or an admitted request. */
interface NewAgent {
  id?: string;
  name: string;
  role: Role | null;
  hostId?: string;
  labels?: string[];
  brief?: string;
  label?: string;
  item?: string;
  whenDone?: WhenDone;
  documents?: string[];
  credentials?: (string | { name: string; token: string })[];
  createdBy: string | null;
  /** Names of the own credentials already kept under `id`. */
  kept?: string[];
}

/**
 * A cursor names the `seq` it follows. `-1` is before the first line, so a
 * read of an agent with no transcript yet still has somewhere to resume.
 */
const cursorAfter = (seq: number) => Buffer.from(`sq=${seq}`).toString("base64url");

/** Undefined when `cursor` is not one `cursorAfter` made. */
function seqAfter(cursor: string): number | undefined {
  const match = /^sq=(-1|\d{1,16})$/.exec(Buffer.from(cursor, "base64url").toString());
  return match ? Number(match[1]) : undefined;
}

function issues(error: { issues: { path: PropertyKey[]; message: string }[] }): string {
  return error.issues
    .map((issue) => (issue.path.length ? `${issue.path.join(".")}: ${issue.message}` : issue.message))
    .join("; ");
}
