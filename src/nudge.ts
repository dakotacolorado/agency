import type { Agent } from "./domain.ts";

/** What an agent last said of itself, if anything. */
type Said = Agent["status"];

/** What the person is told of an agent through nudge, the service that reaches them. */
export interface AgentNotifier {
  /** The agent said `status`; `before` is what it said last. */
  said(agent: Agent, before: Said): void;
}

export const NO_NOTIFIER: AgentNotifier = { said: () => {} };

/** The page a notification links to: `<workerPageUrl>/workers/<id>` when that is set, else agency's own page of the agent. */
export function agentPage(publicUrl: string | null | undefined, workerPageUrl?: string | null): (agent: Agent) => string {
  const trim = (url: string) => url.replace(/\/+$/, "");
  return workerPageUrl ? (agent) => `${trim(workerPageUrl)}/workers/${agent.id}` : (agent) => `${trim(publicUrl ?? "")}/#/agents/${agent.id}`;
}

/** One notification per agent, keyed by its id: posted, updated, or resolved as its status moves. */
export function notice(agent: Agent, before: Said): { post: { title: string; body: string | null; priority: "urgent" | "normal" } } | { resolve: string } | null {
  const name = agent.title ? `${agent.name} (${agent.title})` : agent.name;
  const body = agent.summary || null;
  switch (agent.status) {
    case "waiting":
      return { post: { title: `${name} is waiting on you`, body, priority: "urgent" } };
    case "review":
      return { post: { title: `${name} is ready for review`, body, priority: "normal" } };
    case "done":
      return { post: { title: `${name} is done`, body, priority: "normal" } };
    default:
      // Back at work: what it was waiting on the person for has been answered.
      return before === "waiting" || before === "review" || before === "done" ? { resolve: "it is working again" } : null;
  }
}

/**
 * nudge over HTTP (POST /notifications, /notifications/resolve). Calls are made in
 * order, in the background, and a failure is logged, never thrown: the agent's
 * status stands whether or not the person was reached.
 */
export class Nudge implements AgentNotifier {
  private chain: Promise<void> = Promise.resolve();
  private readonly url: string;
  private readonly token: string;
  private readonly pageUrl: (agent: Agent) => string;
  private readonly log: (message: string) => void;

  constructor(url: string, token: string, pageUrl: (agent: Agent) => string, log: (message: string) => void = (m) => console.error(m)) {
    this.url = url;
    this.token = token;
    this.pageUrl = pageUrl;
    this.log = log;
  }

  said(agent: Agent, before: Said): void {
    const what = notice(agent, before);
    if (!what) return;
    const key = `agent:${agent.id}`;
    const call =
      "post" in what
        ? () => this.call("/notifications", { key, ...what.post, link: this.pageUrl(agent) })
        : () => this.call("/notifications/resolve", { key, reason: what.resolve, silent: true });
    this.chain = this.chain.then(call).catch((err: unknown) => this.log(`nudge: ${agent.name}: ${(err as Error).message}`));
  }

  private async call(path: string, body: unknown): Promise<void> {
    const res = await fetch(`${this.url.replace(/\/$/, "")}${path}`, {
      method: "POST",
      headers: { authorization: `Bearer ${this.token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
    // Resolving one already closed, or never posted, is nothing to report.
    if (!res.ok && !(path.endsWith("/resolve") && (res.status === 404 || res.status === 409))) throw new Error(`${path} answered ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
}
