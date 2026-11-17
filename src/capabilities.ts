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

export const CapabilityModelSchema = z.strictObject({
  model: z.string().min(1).max(100),
  effort: z.enum(EFFORTS).nullable().default(null),
  /** The context size in tokens above which the model's price goes up; null for none. */
  priceStepAt: z.number().int().min(1).nullable().default(null),
});

export type CapabilityModel = z.infer<typeof CapabilityModelSchema>;

export type CapabilityMap = Record<Capability, CapabilityModel>;

/** Haiku 5.5 costs 5x past 100k tokens of context; Opus 5.5 and Sonnet 5.5 have no step up to 1M. */
export const DEFAULT_CAPABILITIES: CapabilityMap = {
  1: { model: "claude-haiku-5-5", effort: null, priceStepAt: 100_000 },
  2: { model: "claude-sonnet-5-5", effort: null, priceStepAt: null },
  3: { model: "claude-opus-5-5", effort: null, priceStepAt: null },
};

/** A capabilities file: each capability it names replaces that one's default, whole. */
export const CapabilitiesFileSchema = z.strictObject({
  "1": CapabilityModelSchema.optional(),
  "2": CapabilityModelSchema.optional(),
  "3": CapabilityModelSchema.optional(),
});

export function capabilitiesOf(file: unknown): CapabilityMap {
  const given = CapabilitiesFileSchema.parse(file);
  return { 1: given["1"] ?? DEFAULT_CAPABILITIES[1], 2: given["2"] ?? DEFAULT_CAPABILITIES[2], 3: given["3"] ?? DEFAULT_CAPABILITIES[3] };
}

export const readCapabilities = (path: string): CapabilityMap => capabilitiesOf(JSON.parse(readFileSync(path, "utf8")));

/** An agent's capability: records written before capabilities ran on today's default. */
export const capabilityOf = (agent: { capability?: Capability }): Capability => agent.capability ?? DEFAULT_CAPABILITY;
