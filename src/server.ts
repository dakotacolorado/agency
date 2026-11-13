import { fixedToken, AgentServiceApi } from "./api.ts";
import { credentialsOf, type Services } from "./services.ts";
import { ServiceSkills } from "./skills.ts";
import { ownSkill } from "./skill.ts";
import { Store } from "./store.ts";
import { startTimers } from "./sweep.ts";
import { storeSecrets } from "./agent-secrets.ts";

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
  /** Stops the timers and closes the database. */
  close(): void;
}

/** The API on the database at `config.db`, with its timers running. */
export function start(config: Config): Running {
  const store = Store.open(config.db);
  store.forgetConnections();
  const token = fixedToken(config.token);
  const credentials = credentialsOf(config.services, token, config.env);
  const api = new AgentServiceApi(store, token, {
    admin: fixedToken(config.adminToken),
    publicUrl: config.publicUrl ?? null,
    credentials,
    agentSecrets: storeSecrets(store),
    skills: new ServiceSkills(credentials, ownSkill),
  });
  const stop = startTimers(store);
  return {
    api,
    store,
    close: () => {
      stop();
      store.close();
    },
  };
}

