import { describe, expect, it } from "vitest";
import { Keyring, KeyringUnreachable } from "./keyring.ts";

const who = { agent: "planner-1", role: "planner", labels: ["gpu"] };
const answering = (res: () => Response | Promise<Response>, seen: { url?: string; init?: RequestInit }[] = []) =>
  (async (url: string | URL | Request, init?: RequestInit) => {
    seen.push({ url: String(url), init });
    return res();
  }) as typeof fetch;

describe("Keyring", () => {
  it("posts the agent, role and labels to /api/resolve with the resolver token, and answers the variables", async () => {
    const seen: { url?: string; init?: RequestInit }[] = [];
    const keyring = new Keyring("https://keyring.example/", "resolver", answering(() => Response.json({ variables: { GH_TOKEN: "v" } }), seen));
    expect(await keyring.resolve(who)).toEqual({ GH_TOKEN: "v" });
    expect(seen[0]!.url).toBe("https://keyring.example/api/resolve");
    expect(JSON.parse(String(seen[0]!.init!.body))).toEqual(who);
    expect((seen[0]!.init!.headers as Record<string, string>).authorization).toBe("Bearer resolver");
  });

  it("leaves out a role it does not have", async () => {
    const seen: { url?: string; init?: RequestInit }[] = [];
    await new Keyring("https://k", "t", answering(() => Response.json({ variables: {} }), seen)).resolve({ ...who, role: null });
    expect(JSON.parse(String(seen[0]!.init!.body))).not.toHaveProperty("role");
  });

  it("is unreachable when the call fails, answers an error or answers something else, never echoing a body", async () => {
    const down = new Keyring("https://k", "t", (async () => { throw new TypeError("fetch failed"); }) as typeof fetch);
    await expect(down.resolve(who)).rejects.toThrow(KeyringUnreachable);
    const refused = new Keyring("https://k", "t", answering(() => new Response("leaked-value", { status: 403 })));
    const err = await refused.resolve(who).catch((e: Error) => e);
    expect(err).toBeInstanceOf(KeyringUnreachable);
    expect((err as Error).message).toBe("keyring unreachable: it answered 403");
    await expect(new Keyring("https://k", "t", answering(() => Response.json({ variables: { A: 1 } }))).resolve(who)).rejects.toThrow(KeyringUnreachable);
  });
});
