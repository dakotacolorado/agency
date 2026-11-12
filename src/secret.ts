import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export const hash = (secret: string) => createHash("sha256").update(secret).digest("hex");

/**
 * Compared as digests, so the time taken says nothing about how much of the
 * secret was right, and neither length is leaked by an early return.
 */
export function same(presented: string, expected: string): boolean {
  return timingSafeEqual(digest(presented), digest(expected));
}

const digest = (value: string) => createHash("sha256").update(value).digest();

/** A page's one-time socket ticket: 256 random bits, kept only as `hash`. */
export const ticket = () => randomBytes(32).toString("base64url");
