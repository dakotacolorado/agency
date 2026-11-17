import type { CapabilityMap, CapabilityModel, Price } from "./capabilities.ts";
import { highest, NO_TOKENS, TOKEN_FIELDS, type CapabilityChange, type Session, type Tokens } from "./domain.ts";

/**
 * What a report or a capability change adds to a live session's record. The store merges it into the
 * record in the write's own transaction, each running total kept at its highest, so a total sent
 * again, late, or by two reports at once never adds twice.
 */
export interface Tally {
  agentId: string;
  sessionId: string;
  tokens?: Tokens;
  byModel?: Record<string, Tokens>;
  activeMs?: number;
  turns?: number;
  contextTokens?: number;
  capabilityChange?: CapabilityChange;
}

const higher = (held: number | undefined, reported: number | undefined) =>
  reported === undefined ? held : Math.max(held ?? 0, reported);

export function tallied(held: Session, tally: Tally): Session {
  const byModel = tally.byModel
    ? Object.fromEntries(
        [...new Set([...Object.keys(held.byModel ?? {}), ...Object.keys(tally.byModel)])].map((model) => [
          model,
          highest(held.byModel?.[model] ?? NO_TOKENS, tally.byModel![model] ?? NO_TOKENS),
        ]),
      )
    : held.byModel;
  const next: Session = {
    ...held,
    ...(tally.tokens && { tokens: highest(held.tokens ?? NO_TOKENS, tally.tokens) }),
    ...(byModel && { byModel }),
    ...(tally.activeMs !== undefined && { activeMs: higher(held.activeMs, tally.activeMs) }),
    ...(tally.turns !== undefined && { turns: higher(held.turns, tally.turns) }),
    ...(tally.contextTokens !== undefined && { peakContextTokens: higher(held.peakContextTokens, tally.contextTokens) }),
    ...(tally.capabilityChange && { capabilityChanges: [...(held.capabilityChanges ?? []), tally.capabilityChange] }),
  };
  return next;
}

/** The capability map's entry for `model`: its own, or one whose model it is a dated build of. */
export const entryFor = (model: string, capabilities: CapabilityMap): CapabilityModel | null =>
  Object.values(capabilities).find((entry) => entry.model === model) ??
  Object.values(capabilities).find((entry) => model.startsWith(`${entry.model}-`)) ??
  null;

const PRICED: Record<(typeof TOKEN_FIELDS)[number], keyof Price> = {
  inputTokens: "input",
  outputTokens: "output",
  cacheReadInputTokens: "cacheRead",
  cacheCreationInputTokens: "cacheWrite",
};

/** To the millionth of a dollar, so sums read as they add. */
const dollars = (n: number) => Math.round(n * 1e6) / 1e6;

/**
 * At its price above the step for the whole session once its context went past `priceStepAt`: agency
 * does not know each request's size, so this errs high.
 */
export function costOf(model: string, tokens: Tokens, peakContextTokens: number, capabilities: CapabilityMap): number | null {
  const entry = entryFor(model, capabilities);
  if (!entry?.prices) return null;
  const { aboveStep, ...base } = entry.prices;
  const price = entry.priceStepAt !== null && peakContextTokens > entry.priceStepAt && aboveStep ? aboveStep : base;
  return dollars(TOKEN_FIELDS.reduce((sum, field) => sum + tokens[field] * price[PRICED[field]], 0) / 1e6);
}

/**
 * Each model's tokens as its host reported them; from a host that reports none by model, every token on
 * the model the session started on. None for a session from before its model was kept.
 */
function modelsOf(session: Session): [string, Tokens][] {
  const byModel = Object.entries(session.byModel ?? {});
  if (byModel.length) return byModel;
  const tokens = session.tokens ?? NO_TOKENS;
  if (!session.model || TOKEN_FIELDS.every((f) => tokens[f] === 0)) return [];
  return [[session.model, tokens]];
}

/** A session as `ListSessions` and an agent's `currentSession` serve it. */
export function sessionView(session: Session, capabilities: CapabilityMap) {
  const peak = session.peakContextTokens ?? 0;
  const modelsUsed = modelsOf(session).map(([model, tokens]) => ({ model, ...tokens, estimatedCostUsd: costOf(model, tokens, peak, capabilities) }));
  const priced = modelsUsed.filter((m) => m.estimatedCostUsd !== null);
  return {
    id: session.id,
    agentId: session.agentId,
    agentName: session.agentName ?? null,
    role: session.role ?? null,
    item: session.item ?? null,
    capability: session.capability ?? null,
    model: session.model ?? null,
    capabilityChanges: session.capabilityChanges ?? [],
    tokens: session.tokens ?? NO_TOKENS,
    modelsUsed,
    estimatedCostUsd: session.model === undefined && !modelsUsed.length ? null : dollars(priced.reduce((sum, m) => sum + m.estimatedCostUsd!, 0)),
    startedAt: session.startedAt,
    endedAt: session.endedAt,
    activeMs: session.activeMs ?? null,
    turns: session.turns ?? null,
    peakContextTokens: session.peakContextTokens ?? null,
    endReason: session.endReason ?? session.ended,
    skills: session.skills,
  };
}

export type SessionView = ReturnType<typeof sessionView>;

/** Whether it ran on `model` at any time: at its start, or in a model's tokens. */
export const ranOn = (session: Session, model: string): boolean =>
  session.model === model || Object.keys(session.byModel ?? {}).includes(model);

export const CSV_COLUMNS = [
  "id",
  "agentId",
  "agentName",
  "role",
  "item",
  "capability",
  "model",
  "capabilityChanges",
  "modelsUsed",
  ...TOKEN_FIELDS,
  "estimatedCostUsd",
  "startedAt",
  "endedAt",
  "activeMs",
  "turns",
  "peakContextTokens",
  "endReason",
] as const;

const cell = (value: unknown): string => {
  const text = value === null || value === undefined ? "" : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
};

/** One header row, then a row per session: `modelsUsed` and `capabilityChanges` each one cell, `;`-separated. */
export function sessionsCsv(sessions: SessionView[]): string {
  const rows = sessions.map((s) => {
    const fields: Record<(typeof CSV_COLUMNS)[number], unknown> = {
      ...s,
      ...s.tokens,
      capabilityChanges: s.capabilityChanges.map((c) => `${c.at} ${c.from}>${c.to}`).join(";"),
      modelsUsed: s.modelsUsed.map((m) => `${m.model}:${m.estimatedCostUsd ?? ""}`).join(";"),
    };
    return CSV_COLUMNS.map((column) => cell(fields[column])).join(",");
  });
  return [CSV_COLUMNS.join(","), ...rows].join("\r\n") + "\r\n";
}
