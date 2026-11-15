import { statusOf, type Agent } from "./domain.ts";

/**
 * What the person is told of agents through nudge, the service that reaches them: one notification per
 * agent, open only while it waits on them or is in review.
 */
export interface AgentNotifier {
  /** These agents were just written, as they now stand. */
  wrote(agents: Agent[]): void;
  /** Brings nudge's open notifications in line with every agent `list` answers. */
  reconcile(list: () => Promise<Agent[]>): Promise<void>;
}

export const NO_NOTIFIER: AgentNotifier = { wrote: () => {}, reconcile: async () => {} };

/** The page a notification links to: `<workerPageUrl>/workers/<id>` when that is set, else agency's own page of the agent. */
export function agentPage(publicUrl: string | null | undefined, workerPageUrl?: string | null): (agent: Agent) => string {
  const trim = (url: string) => url.replace(/\/+$/, "");
  return workerPageUrl ? (agent) => `${trim(workerPageUrl)}/workers/${agent.id}` : (agent) => `${trim(publicUrl ?? "")}/#/agents/${agent.id}`;
}

export interface Notice {
  title: string;
  body: string | null;
  priority: "urgent" | "normal";
}

/** What needs the person of this agent: something while it waits on them or is in review, else nothing. */
export function notice(agent: Agent): Notice | null {
  if (agent.state === "deleted") return null;
  const name = agent.title ? `${agent.name} (${agent.title})` : agent.name;
  const body = agent.summary || null;
  switch (statusOf(agent)) {
    case "waiting":
      return { title: `${name} is waiting on you`, body, priority: "urgent" };
    case "review":
      return { title: `${name} is ready for review`, body, priority: "normal" };
    default:
      return null;
  }
}

const keyOf = (agent: Agent) => `agent:${agent.id}`;

const RESOLVED = "it no longer waits on you";

interface Active {
  key: string;
  title: string;
  body: string | null;
  priority: string;
  link: string;
}

/**
 * nudge over HTTP (POST /notifications, /notifications/resolve, GET /notifications). Calls are made in
 * order, in the background, and a failure is logged, never thrown: the agent's write stands whether or
 * not the person was reached, and the next reconcile mends what a failed call left.
 */
export class Nudge implements AgentNotifier {
  private chain: Promise<void> = Promise.resolve();
  /** What nudge holds open for each agent, as last sent: a post's JSON, or null for none. */
  private readonly sent = new Map<string, string | null>();
  private readonly url: string;
  private readonly token: string;
  private readonly pageUrl: (agent: Agent) => string;
  private readonly log: (message: string) => void;

  constructor(url: string, token: string, pageUrl: (agent: Agent) => string, log: (message: string) => void = (m) => console.error(m)) {
    this.url = url.replace(/\/+$/, "");
    this.token = token;
    this.pageUrl = pageUrl;
    this.log = log;
  }

  wrote(agents: Agent[]): void {
    for (const agent of agents) {
      const post = this.post(agent);
      const shown = post && JSON.stringify(post);
      // Unknown until the first reconcile or write: resolved once, as it may be left from before.
      if (this.sent.has(agent.id) && this.sent.get(agent.id) === shown) continue;
      this.sent.set(agent.id, shown);
      this.queue(agent.name, async () => {
        try {
          await (post ? this.call("POST", "/notifications", post) : this.resolve(keyOf(agent)));
        } catch (err) {
          // Sent again on its next write, unless written since.
          if (this.sent.get(agent.id) === shown) this.sent.delete(agent.id);
          throw err;
        }
      });
    }
  }

  reconcile(list: () => Promise<Agent[]>): Promise<void> {
    return this.queue("reconcile", async () => {
      const { notifications } = (await this.call("GET", "/notifications?state=active&limit=500")) as { notifications: Active[] };
      const active = new Map(notifications.filter((n) => n.key.startsWith("agent:")).map((n) => [n.key, n]));
      const agents = new Map((await list()).map((a) => [keyOf(a), a]));
      let resolved = 0, posted = 0;
      for (const key of active.keys()) {
        const agent = agents.get(key);
        if (agent && notice(agent)) continue;
        await this.resolve(key);
        resolved++;
      }
      for (const [key, agent] of agents) {
        const post = this.post(agent);
        this.sent.set(agent.id, post && JSON.stringify(post));
        if (!post) continue;
        const open = active.get(key);
        if (open && open.title === post.title && open.body === post.body && open.priority === post.priority && open.link === post.link) continue;
        await this.call("POST", "/notifications", post);
        posted++;
      }
      if (resolved || posted) this.log(JSON.stringify({ nudge: "reconciled", resolved, posted }));
    });
  }

  /** Once every call queued so far has run. */
  settled(): Promise<void> {
    return this.chain;
  }

  private post(agent: Agent): (Notice & { key: string; link: string }) | null {
    const what = notice(agent);
    return what && { key: keyOf(agent), ...what, link: this.pageUrl(agent) };
  }

  private resolve(key: string): Promise<unknown> {
    return this.call("POST", "/notifications/resolve", { key, reason: RESOLVED, silent: true });
  }

  /** Run after every call queued before it; answers once it ran, never failing. */
  private queue(what: string, call: () => Promise<unknown>): Promise<void> {
    this.chain = this.chain.then(call).then(
      () => {},
      (err: unknown) => {
        this.log(`nudge: ${what}: ${(err as Error).message}`);
      },
    );
    return this.chain;
  }

  private async call(method: "GET" | "POST", path: string, body?: unknown): Promise<unknown> {
    const res = await fetch(`${this.url}${path}`, {
      method,
      headers: { authorization: `Bearer ${this.token}`, ...(body !== undefined && { "content-type": "application/json" }) },
      ...(body !== undefined && { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(10_000),
    });
    // Resolving one already closed, or never posted, is nothing to report.
    if (res.ok || (path.endsWith("/resolve") && (res.status === 404 || res.status === 409))) return res.json().catch(() => null);
    throw new Error(`${method} ${path} answered ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
}
