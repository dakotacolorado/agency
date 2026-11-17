import { readFileSync } from "node:fs";
import { z } from "zod";

/**
 * How capable a model an agent runs on: 3 is today's default and the ceiling,
 * 2 and 1 a step and two down, for easier work. Callers name a capability,
 * never a model, so nothing can pick one above capability 3's.
 */
export const CAPABILITIES = [1, 2, 3] as const;

export type Capability = (typeof CAPABILITIES)[number];

/** What every role, and so every agent made before capabilities, runs on. */
export const DEFAULT_CAPABILITY: Capability = 3;

/** Claude Code's `--effort` levels; null leaves its default, `medium`. */
export const EFFORTS = ["low", "medium", "high", "xhigh"] as const;

export type Effort = (typeof EFFORTS)[number];

const Price = z.number().min(0).max(1000);

/** US dollars per million tokens, in the four counts Claude reports. Cache writes at the 1-hour TTL, Claude Code's. */
export const PriceSchema = z.strictObject({ input: Price, output: Price, cacheRead: Price, cacheWrite: Price });

export type Price = z.infer<typeof PriceSchema>;

export const PricesSchema = PriceSchema.extend({
  /** What each token costs once the session's context has gone past `priceStepAt`; null for a model without a step. */
  aboveStep: PriceSchema.nullable().default(null),
});

export type Prices = z.infer<typeof PricesSchema>;

export const CapabilityModelSchema = z.strictObject({
  model: z.string().min(1).max(100),
  effort: z.enum(EFFORTS).nullable().default(null),
  /** The context size in tokens above which the model's price goes up; null for none. */
  priceStepAt: z.number().int().min(1).nullable().default(null),
  /** Null for a model with no price: its tokens are counted and left out of a session's cost. */
  prices: PricesSchema.nullable().default(null),
});

export type CapabilityModel = z.infer<typeof CapabilityModelSchema>;

export type CapabilityMap = Record<Capability, CapabilityModel>;

/**
 * Anthropic's list prices, 2026-11. Haiku 5.5 costs 5x past 100k tokens of context; Opus 5.5 and
 * Sonnet 5.5 have no step up to 1M.
 */
export const DEFAULT_CAPABILITIES: CapabilityMap = {
  1: {
    model: "claude-haiku-5-5",
    effort: null,
    priceStepAt: 100_000,
    prices: { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.2, aboveStep: { input: 0.5, output: 2.5, cacheRead: 0.05, cacheWrite: 1 } },
  },
  2: { model: "claude-sonnet-5-5", effort: null, priceStepAt: null, prices: { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 4, aboveStep: null } },
  3: { model: "claude-opus-5-5", effort: null, priceStepAt: null, prices: { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 8, aboveStep: null } },
};

/** A capabilities file: each capability it names replaces that one's default, whole. */
export const CapabilitiesFileSchema = z.strictObject({
  "1": CapabilityModelSchema.optional(),
  "2": CapabilityModelSchema.optional(),
  "3": CapabilityModelSchema.optional(),
});

/**
 * An entry without `prices` naming a default's model keeps that model's default prices, so a file written
 * before prices still prices its sessions.
 */
export function capabilitiesOf(file: unknown): CapabilityMap {
  const given = CapabilitiesFileSchema.parse(file);
  const entry = (n: Capability): CapabilityModel => {
    const named = given[`${n}`];
    if (!named) return DEFAULT_CAPABILITIES[n];
    return { ...named, prices: named.prices ?? Object.values(DEFAULT_CAPABILITIES).find((d) => d.model === named.model)?.prices ?? null };
  };
  return { 1: entry(1), 2: entry(2), 3: entry(3) };
}

export const readCapabilities = (path: string): CapabilityMap => capabilitiesOf(JSON.parse(readFileSync(path, "utf8")));

/** An agent's capability: records written before capabilities ran on today's default. */
export const capabilityOf = (agent: { capability?: Capability }): Capability => agent.capability ?? DEFAULT_CAPABILITY;
