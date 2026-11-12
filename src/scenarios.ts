/**
 * The worker-behaviour scenarios `npm run scenarios:beta` runs on beta
 * (`src/scenarios-beta.ts`), and how a run is judged and printed. Nothing here
 * calls anything, so `scenarios.spec.ts` checks it without a stage.
 *
 * Expectations are provisional: what a worker's status should be at each step
 * is for epic 7c000f03 to settle. Until then a run reports them and exits 0;
 * `--strict` makes a failed one fail the run.
 */

export type State = "idle" | "working" | "waiting" | "interrupted" | "retired";
export type Status = "working" | "waiting" | "review" | "done";

/** The fields of a worker (`getWorker`) the scenarios read. */
export interface WorkerView {
  id: string;
  name: string;
  state: State;
  status: Status | "" | null;
  summary: string | null;
  headline: string | null;
}

/** A transcript line (`listTranscript`). */
export interface Line {
  seq: number;
  at: string;
  from: "agent" | "tool" | "instruction";
  text: string;
}

/** One change of what a worker shows, seen by polling it every 2 s. */
export interface Change {
  /** Seconds since the scenario began. */
  t: number;
  state: State;
  status: WorkerView["status"];
  headline: string | null;
  summary: string | null;
}

/** What a step may wait on: the worker as last polled and every line so far. */
export interface Seen {
  worker: WorkerView;
  lines: Line[];
  /** Lines since the scenario's last checkpoint. */
  since: Line[];
}

/** What a checkpoint is expected to show. Every field is optional. */
export interface Expect {
  /** The worker's status once the turn has settled is one of these. */
  status?: Status[];
  /** The agent's text after its last tool call in the segment matches this. */
  answer?: RegExp;
  /** The segment's last line is the agent's own text, not a tool call. */
  endsInChat?: boolean;
  /** The worker never read "Ended its turn without saying why." in the segment. */
  saysWhy?: boolean;
  /** The worker never reached any of these states during the segment. */
  neverState?: State[];
}

export type Step =
  /** Sent with `messageWorker`; `interrupt` stops the current turn first. */
  | { do: "message"; text: string; interrupt?: boolean }
  /** Waits, without judging, until `until` holds. */
  | { do: "pause"; what: string; until: (seen: Seen) => boolean; timeout?: number }
  /**
   * Waits until the worker's turn has ended (`waiting`, `idle` or
   * `interrupted`), `until` holds if given, and nothing it shows has changed
   * for `quiet` seconds; then judges `expect` over the lines since the last
   * checkpoint.
   */
  | {
      do: "checkpoint";
      what: string;
      until?: (seen: Seen) => boolean;
      quiet?: number;
      timeout?: number;
      expect: Expect;
    };

export interface Scenario {
  /** Short, for worker names: `sc-<name>-<run>`. */
  name: string;
  about: string;
  brief: string;
  /** How many workers are made with `brief` at once; each runs `steps`. Default 1. */
  workers?: number;
  steps: Step[];
}

const agentSays = (pattern: RegExp) => (seen: Seen) =>
  seen.since.some((l) => l.from === "agent" && pattern.test(l.text));
const toolRuns = (pattern: RegExp) => (seen: Seen) =>
  seen.since.some((l) => l.from === "tool" && pattern.test(l.text));

/** Claude Code moves a bare `sleep` of more than a few seconds to the background; this it runs as given. */
const pySleep = (seconds: number) => `python3 -c 'import time; time.sleep(${seconds}); print("slept")'`;

/** An answer is expected in the chat, and with a reason for its status. */
const answered = (answer: RegExp, status?: Status[]): Expect => ({
  answer,
  endsInChat: true,
  saysWhy: true,
  ...(status ? { status } : {}),
});

export const SCENARIOS: Scenario[] = [
  {
    name: "simple",
    about: "A simple question",
    brief: "What is 12 times 12? Answer with just the number.",
    steps: [{ do: "checkpoint", what: "answered", expect: answered(/\b144\b/) }],
  },
  {
    name: "ask",
    about: "Ask before acting, then answer",
    brief:
      "I want a file named colour.txt in your folder holding my favourite colour. " +
      "Before you do anything, ask me which colour it is; do not guess.",
    steps: [
      { do: "checkpoint", what: "asked", expect: { endsInChat: true, saysWhy: true, status: ["waiting"] } },
      { do: "message", text: "Teal." },
      { do: "checkpoint", what: "acted on the answer", expect: answered(/teal/i) },
    ],
  },
  {
    name: "bg",
    about: "A background task reported when it ends",
    brief:
      "Run the shell command `sleep 20; echo bg-finished` in the background (run_in_background), " +
      "tell me in one line that it is running, and end your turn without polling it: you will be " +
      "notified when it ends. Then tell me what it printed.",
    steps: [
      { do: "checkpoint", what: "started it", expect: { endsInChat: true, saysWhy: true, status: ["working"] } },
      {
        do: "checkpoint",
        what: "reported it",
        until: agentSays(/bg-finished/),
        timeout: 180,
        expect: answered(/bg-finished/),
      },
    ],
  },
  {
    name: "donebg",
    about: "Done, then a background task's turn",
    brief:
      "Start the shell command `sleep 20` in the background (run_in_background) as a timer for " +
      "yourself and do not wait for it. Then tell me how many letters the word 'scenario' has. " +
      "That answer is all I need from you: once you give it you are done.",
    steps: [
      { do: "checkpoint", what: "answered", expect: answered(/\b8\b|eight/i, ["done"]) },
      {
        do: "checkpoint",
        what: "after the timer's turn",
        until: (seen) => seen.since.length > 0,
        timeout: 180,
        expect: { saysWhy: true, status: ["done"] },
      },
    ],
  },
  {
    name: "midmsg",
    about: "A message mid-turn",
    brief: `Run this in the foreground and wait for it: ${pySleep(25)} . Then tell me the word alpha.`,
    steps: [
      { do: "pause", what: "the sleep is running", until: toolRuns(/time\.sleep\(25\)/) },
      { do: "message", text: "In the same answer, tell me the word bravo too." },
      {
        do: "checkpoint",
        what: "answered both",
        until: agentSays(/bravo/i),
        expect: answered(/bravo/i),
      },
    ],
  },
  {
    name: "int",
    about: "An interrupt with text",
    brief: `Run this in the foreground and wait for it: ${pySleep(90)} . Then tell me what it printed.`,
    steps: [
      { do: "pause", what: "the sleep is running", until: toolRuns(/time\.sleep\(90\)/) },
      { do: "message", interrupt: true, text: "Stop that, never mind. Just reply with the word charlie." },
      { do: "checkpoint", what: "answered after the interrupt", expect: answered(/charlie/i) },
    ],
  },
  {
    name: "chat",
    about: "A 3-question chat",
    brief: "What is 2 plus 2? Answer in one line.",
    steps: [
      { do: "checkpoint", what: "first answer", expect: answered(/\b4\b|four/i) },
      { do: "message", text: "And 3 plus 3?" },
      { do: "checkpoint", what: "second answer", expect: answered(/\b6\b|six/i) },
      { do: "message", text: "And 4 plus 4?" },
      { do: "checkpoint", what: "third answer", expect: answered(/\b8\b|eight/i) },
    ],
  },
  {
    name: "race",
    about: "Several starts close together (story 0fb46036)",
    brief: "Reply with the word ready.",
    workers: 4,
    steps: [
      {
        do: "checkpoint",
        what: "answered",
        expect: { ...answered(/ready/i), neverState: ["interrupted"] },
      },
    ],
  },
];

export const SILENT = "Ended its turn without saying why.";

/** Whether a turn has ended, as the host reports it. */
export const turnEnded = (state: State) => state === "waiting" || state === "idle" || state === "interrupted";

/** The level of a `page` call in a tool line, or null when the line is not one. */
export function pageOf(line: Line): string | null {
  if (line.from !== "tool" || !line.text.includes("skills/page/bin/page")) return null;
  return /page\\?"?'?\s+(working|waiting|review|done)\b/.exec(line.text)?.[1] ?? "?";
}

export interface Judged {
  what: string;
  /** Seconds since the scenario began, when it settled; null when it never did. */
  t: number | null;
  status: WorkerView["status"];
  summary: string | null;
  pages: string[];
  endsInChat: boolean;
  /** The agent's text after its last tool call, cut to 200 characters. */
  answer: string;
  results: { check: string; ok: boolean }[];
}

/**
 * Judges one checkpoint: `segment` is the lines since the last one, and
 * `changes` what the worker showed meanwhile, the last being where it settled,
 * and `settledAt` seconds since the scenario began, or null if it never did.
 */
export function judge(
  what: string,
  expect: Expect,
  segment: Line[],
  changes: Change[],
  settledAt: number | null,
): Judged {
  const last = changes.at(-1);
  const lastTool = segment.findLastIndex((l) => l.from === "tool");
  const answer = segment
    .slice(lastTool + 1)
    .filter((l) => l.from === "agent")
    .map((l) => l.text)
    .join(" ");
  const chat = segment.filter((l) => l.from !== "instruction");
  const endsInChat = chat.at(-1)?.from === "agent";
  const results: Judged["results"] = [{ check: "settled", ok: settledAt !== null }];
  if (expect.status) {
    results.push({ check: `status in [${expect.status.join(", ")}]`, ok: expect.status.includes(last?.status as Status) });
  }
  if (expect.answer) results.push({ check: `answer matches ${expect.answer}`, ok: expect.answer.test(answer) });
  if (expect.endsInChat) results.push({ check: "answer ends the chat", ok: endsInChat });
  if (expect.saysWhy) results.push({ check: "never read silent", ok: !changes.some((c) => c.summary === SILENT) });
  if (expect.neverState) {
    const seen = new Set(changes.map((c) => c.state));
    results.push({
      check: `never ${expect.neverState.join(" or ")}`,
      ok: !expect.neverState.some((s) => seen.has(s)),
    });
  }
  return {
    what,
    t: settledAt,
    status: last?.status ?? null,
    summary: last?.summary ?? null,
    pages: segment.map(pageOf).filter((p): p is string => p !== null),
    endsInChat,
    answer: answer.replace(/\s+/g, " ").trim().slice(0, 200),
    results,
  };
}

export interface WorkerRun {
  name: string;
  id: string | null;
  changes: Change[];
  checkpoints: Judged[];
  /** Why the run of its steps stopped short, if it did. */
  error: string | null;
}

export interface ScenarioRun {
  scenario: Scenario;
  workers: WorkerRun[];
}

export const passed = (run: ScenarioRun) =>
  run.workers.every((w) => w.error === null && w.checkpoints.every((c) => c.results.every((r) => r.ok)));

const show = (s: string | null) => (s === null ? "-" : JSON.stringify(s));

/** One scenario's report: pass or fail, each worker's status timeline, and each checkpoint. */
export function report(run: ScenarioRun): string {
  const out = [`=== ${passed(run) ? "PASS" : "FAIL"} ${run.scenario.name}: ${run.scenario.about}`];
  for (const w of run.workers) {
    out.push(`  worker ${w.name} ${w.id ?? "(not made)"}`);
    for (const c of w.changes) {
      out.push(
        `    +${String(c.t).padStart(4)}s  ${c.state.padEnd(11)} status=${(c.status || "-").padEnd(7)} ${show(c.headline)} | ${show(c.summary)}`,
      );
    }
    for (const j of w.checkpoints) {
      out.push(
        `    checkpoint "${j.what}"${j.t === null ? " (never settled)" : ` at +${j.t}s`}: status=${j.status || "-"} ` +
          `pages=[${j.pages.join(", ")}] ends in chat=${j.endsInChat ? "yes" : "no"} answer=${show(j.answer)}`,
      );
      for (const r of j.results) out.push(`      ${r.ok ? "ok  " : "FAIL"} ${r.check}`);
    }
    if (w.error) out.push(`    FAIL ${w.error}`);
  }
  return out.join("\n");
}

/** The closing table: one line per scenario. */
export function summary(runs: ScenarioRun[]): string {
  const lines = runs.map((r) => {
    const turns = r.workers
      .map((w) => w.checkpoints.map((c) => `${c.status || "-"}${c.endsInChat ? "" : "(no chat)"}`).join(" > "))
      .join(" ; ");
    return `${passed(r) ? "PASS" : "FAIL"}  ${r.scenario.name.padEnd(8)} ${turns}`;
  });
  const failed = runs.filter((r) => !passed(r)).length;
  return [...lines, `${runs.length - failed} passed, ${failed} failed`].join("\n");
}
