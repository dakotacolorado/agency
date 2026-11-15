import { fixedToken, AgencyApi } from "./api.ts";
import { HonedContext, NO_CONTEXT } from "./context.ts";
import { credentialsOf, type Services } from "./services.ts";
import { HonedRoles, NO_ROLES } from "./roles.ts";
import { Store } from "./store.ts";
import { agentPage, NO_NOTIFIER, Nudge } from "./nudge.ts";
import type { Server } from "node:http";
import { SocketHandler } from "./socket.ts";
import { retireClosed, RETIRE_CLOSED_AFTER, startTimers } from "./sweep.ts";
import { serveSockets, SOCKET_PATH, Sockets } from "./ws-server.ts";

/** The service, of those the services file names, that each session's instructions are read from. */
export const HONED = "honed";

export interface Config {
  /** The SQLite file; `:memory:` keeps nothing past the process. */
  db: string;
  /** The bearer token every caller and host presents. */
  token: string | null;
  /** The other services a session may be given. */
  services: Services;
  /** This service's address as agents and hosts reach it, such as its Tailscale HTTPS one. */
  publicUrl?: string | null;
  /** nudge, which tells the person while an agent waits on them or is in review; without it, nobody is told. */
  nudge?: { url: string; token: string } | null;
  /** Where nudge's notifications link, as a base `/workers/<agent id>` is appended to; without it, agency's own page. */
  workerPageUrl?: string | null;
  /** Days an agent stays `done` and closed before the sweep deletes it; `0` never. Absent, `RETIRE_CLOSED_AFTER`. */
  retireClosedAfter?: number;
  env?: NodeJS.ProcessEnv;
}

export interface Running {
  api: AgencyApi;
  store: Store;
  /** Serves the hosts' and pages' socket on `server`, the one serving `api`. */
  listen(server: Server): void;
  /** Closes every socket, stops the timers and closes the database. */
  close(): void;
}

/** The API on the database at `config.db`, with its timers running, and its socket once `listen` is called. */
export function start(config: Config): Running {
  const store = Store.open(config.db);
  store.forgetConnections();
  const token = fixedToken(config.token);
  const credentials = credentialsOf(config.services, token, config.env);
  const honed = credentials[HONED];
  // Without honed there are no roles, and no skill can be given.
  const context = honed?.url ? new HonedContext({ url: honed.url, token: honed.token }, store) : NO_CONTEXT;
  const roles = honed?.url ? new HonedRoles({ url: honed.url, token: honed.token }, store) : NO_ROLES;
  const sockets = new Sockets();
  const notifier = config.nudge ? new Nudge(config.nudge.url, config.nudge.token, agentPage(config.publicUrl, config.workerPageUrl)) : NO_NOTIFIER;
  const api = new AgencyApi(store, token, {
    poster: sockets,
    socketPath: SOCKET_PATH,
    publicUrl: config.publicUrl ?? null,
    credentials,
    context,
    roles,
    notifier,
  });
  const handler = new SocketHandler(store, token, sockets, undefined, credentials, (hostId, heartbeat) => api.beat(hostId, heartbeat), notifier);
  const retireAfter = config.retireClosedAfter ?? RETIRE_CLOSED_AFTER;
  const stopTimers = startTimers(store, {
    retire: () => retireClosed(api.fleet, retireAfter),
    reconcile: () => notifier.reconcile(() => store.listAgents()),
    resume: () => api.resume(),
  });
  const stop = () => {
    stopTimers();
  };
  let unlisten = () => {};
  return {
    api,
    store,
    listen: (server) => {
      unlisten = serveSockets(server, handler, sockets);
    },
    close: () => {
      unlisten();
      stop();
      store.close();
    },
  };
}

