/** Who a session is for, as keyring matches grants to it. */
export interface Resolving {
  agent: string;
  role: string | null;
  /** The labels of the host it runs on. */
  labels: string[];
}

/** Where a session's secrets come from, by environment variable. */
export interface SecretSource {
  resolve(who: Resolving): Promise<Record<string, string>>;
}

/** keyring could not be asked, or did not answer as it should; says why, never with a value. */
export class KeyringUnreachable extends Error {
  constructor(why: string) {
    super(`keyring unreachable: ${why}`);
    this.name = "KeyringUnreachable";
  }
}

/** No keyring configured: a session is given only what the services file gives it. */
export const NO_SECRETS: SecretSource = { resolve: async () => ({}) };

const TIMEOUT_MS = 10_000;

/** keyring's `ResolveSecrets`, called with a resolver token. */
export class Keyring implements SecretSource {
  private readonly url: string;
  private readonly token: string;
  private readonly fetchImpl: typeof globalThis.fetch;

  constructor(url: string, token: string, fetchImpl: typeof globalThis.fetch = globalThis.fetch) {
    this.url = url.replace(/\/$/, "");
    this.token = token;
    this.fetchImpl = fetchImpl;
  }

  async resolve({ agent, role, labels }: Resolving): Promise<Record<string, string>> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.url}/api/resolve`, {
        method: "POST",
        headers: { authorization: `Bearer ${this.token}`, "content-type": "application/json", "x-actor": "agency" },
        body: JSON.stringify({ agent, ...(role !== null && { role }), labels }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (err) {
      throw new KeyringUnreachable((err as Error).name);
    }
    // Only the status is kept: an error body is never echoed.
    if (!res.ok) throw new KeyringUnreachable(`it answered ${res.status}`);
    const body = (await res.json().catch(() => null)) as { variables?: unknown } | null;
    const variables = body?.variables;
    if (!variables || typeof variables !== "object" || Object.values(variables).some((v) => typeof v !== "string")) {
      throw new KeyringUnreachable("it answered something else than variables");
    }
    return variables as Record<string, string>;
  }
}
