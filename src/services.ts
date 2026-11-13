import { readFileSync } from "node:fs";
import { z } from "zod";
import { fixedToken, type TokenSource } from "./api.ts";
import { SELF, selfCredential, type Credential } from "./credentials.ts";

const ServiceSchema = z.strictObject({
  url: z.url(),
  urlVar: z.string().regex(/^[A-Z][A-Z0-9_]*$/),
  tokenVar: z.string().regex(/^[A-Z][A-Z0-9_]*$/),
  /** The variable of this process's environment its token is read from. */
  tokenEnv: z.string().regex(/^[A-Z][A-Z0-9_]*$/),
  /** Where on `url` it serves MCP, when it does, as `/mcp`. */
  mcp: z.string().regex(/^\/[A-Za-z0-9._~\/-]*$/).optional(),
});

export const ServicesSchema = z.record(z.string().regex(/^[a-z][a-z0-9-]*$/), ServiceSchema);

export type Services = z.infer<typeof ServicesSchema>;

/**
 * The services a session may be given, by name: this one, at the address a
 * request came to and with `token`, and each in `services`, with the token
 * its `tokenEnv` holds in `env`. No token is in the file, so it can be kept
 * in the repo of the host it describes.
 */
export function credentialsOf(services: Services, token: TokenSource, env: NodeJS.ProcessEnv = process.env): Record<string, Credential> {
  const known: Record<string, Credential> = { [SELF]: selfCredential(token) };
  for (const [name, { url, urlVar, tokenVar, tokenEnv, mcp }] of Object.entries(services)) {
    known[name] = { url: url.replace(/\/$/, ""), urlVar, tokenVar, token: fixedToken(env[tokenEnv]), mcp: mcp ?? null };
  }
  return known;
}

/** The services file at `path`, or why it cannot be read. */
export function readServices(path: string): Services {
  const parsed = ServicesSchema.safeParse(JSON.parse(readFileSync(path, "utf8")));
  if (!parsed.success) {
    throw new Error(parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; "));
  }
  return parsed.data;
}
