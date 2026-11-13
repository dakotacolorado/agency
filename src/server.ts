import { fixedToken, AgentServiceApi } from "./api.ts";
import { HonedContext, NO_CONTEXT } from "./context.ts";
import { credentialsOf, type Services } from "./services.ts";
import { ServiceSkills } from "./skills.ts";
import { ownSkill } from "./skill.ts";
import { Store } from "./store.ts";
import type { Server } from "node:http";
import { SocketHandler } from "./socket.ts";
import { startTimers } from "./sweep.ts";
import { Pickup, PICKER, type Self } from "./pickup.ts";
import { serveSockets, SOCKET_PATH, Sockets } from "./ws-server.ts";
import { storeSecrets } from "./agent-secrets.ts";

/** The service, of those the services file names, that each session's instructions are read from. */
export const HONED = "honed";

/** The service, of those the services file names, whose ready tasks are picked up. */
export const WAYPOINT = "waypoint";

export interface Config {
  /** The SQLite file; `:memory:` keeps nothing past the process. */
  db: string;
  /** The bearer token every caller and host presents. */
  token: string | null;
  /** A person's token: all `token` does, and writing roles. */
  adminToken: string | null;
  /** The other services a session may be given. */
  services: Services;
  /** This service's address as agents and hosts reach it, such as its Tailscale HTTPS one. */
  publicUrl?: string | null;
  /** The role to start an agent in for each ready task of the waypoint the services name; null or absent, none is taken. */
  pickUp?: string | null;
  env?: NodeJS.ProcessEnv;
}

export interface Running {
  api: AgentServiceApi;
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
  // Without honed, sessions start with no context, and a role naming a skill cannot be given it.
  const context = honed?.url ? new HonedContext({ url: honed.url, token: honed.token }, store) : NO_CONTEXT;
  const sockets = new Sockets();
  const agentSecrets = storeSecrets(store);
  const api = new AgentServiceApi(store, token, {
    poster: sockets,
    socketPath: SOCKET_PATH,
    admin: fixedToken(config.adminToken),
    publicUrl: config.publicUrl ?? null,
    credentials,
    agentSecrets,
    context,
    skills: new ServiceSkills(credentials, ownSkill),
  });
  const handler = new SocketHandler(store, token, sockets, undefined, credentials, agentSecrets);
  const stopTimers = startTimers(store);
  const waypoint = credentials[WAYPOINT];
  if (config.pickUp && !waypoint?.url) throw new Error(`picking up tasks needs the services to name ${WAYPOINT}`);
  const self: Self = async (method, path, body) => {
    const res = await api.fetch(
      new Request(`http://local${path}`, {
        method,
        headers: { authorization: `Bearer ${config.token}`, "content-type": "application/json", "claimed-by": PICKER },
        ...(body !== undefined && { body: JSON.stringify(body) }),
      }),
    );
    return { status: res.status, body: res.status === 204 ? null : await res.json() };
  };
  const stopPickUp = config.pickUp && waypoint?.url ? new Pickup({ url: waypoint.url, token: waypoint.token }, store, self, config.pickUp).start() : () => {};
  const stop = () => {
    stopPickUp();
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

