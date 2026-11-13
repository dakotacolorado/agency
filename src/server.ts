import { fixedToken, AgentServiceApi } from "./api.ts";
import { HonedContext, NO_CONTEXT } from "./context.ts";
import { credentialsOf, type Services } from "./services.ts";
import { ServiceSkills } from "./skills.ts";
import { ownSkill } from "./skill.ts";
import { Store } from "./store.ts";
import type { Server } from "node:http";
import { SocketHandler } from "./socket.ts";
import { startTimers } from "./sweep.ts";
import { serveSockets, SOCKET_PATH, Sockets } from "./ws-server.ts";
import { storeSecrets } from "./agent-secrets.ts";

/** The service, of those the services file names, that each session's instructions are read from. */
export const HONED = "honed";

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
  const stop = startTimers(store);
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

