import { describe, expect, it } from "vitest";
import { SCENARIOS, SILENT, judge, pageOf, passed, report, summary, type Change, type Line } from "./scenarios.ts";

const line = (from: Line["from"], text: string, seq = 0): Line => ({ seq, at: "2026-11-05T00:00:00Z", from, text });
const change = (over: Partial<Change> = {}): Change => ({
  t: 10,
  state: "waiting",
  status: "done",
  headline: "Answered",
  summary: "Answered: 144",
  ...over,
});
const page = (level: string) =>
  line("tool", `Bash {"command":"\\"$CLAUDE_CONFIG_DIR/skills/page/bin/page\\" ${level} 'Answered: 144' 'Answered'"}`);

describe("scenarios", () => {
  it("covers every scenario the story names, each with a unique name short enough for a worker", () => {
    expect(SCENARIOS.map((s) => s.name)).toEqual(["simple", "ask", "bg", "donebg", "midmsg", "int", "chat", "race"]);
    for (const s of SCENARIOS) {
      const longest = `sc-${s.name}${s.workers ?? ""}-${Date.now().toString(36)}`;
      expect(longest).toMatch(/^[a-z0-9][a-z0-9-]{0,39}$/);
      expect(s.steps.some((step) => step.do === "checkpoint")).toBe(true);
    }
  });

  it("reads a page call's level from a tool line", () => {
    expect(pageOf(page("waiting"))).toBe("waiting");
    expect(pageOf(line("tool", 'Skill {"skill":"page"}'))).toBeNull();
    expect(pageOf(line("agent", "skills/page/bin/page done"))).toBeNull();
  });

  it("passes an answer that ends the chat after its page", () => {
    const j = judge(
      "answered",
      { status: ["done"], answer: /144/, endsInChat: true, saysWhy: true },
      [line("instruction", "What is 12 times 12?"), page("done"), line("agent", "144")],
      [change({ state: "working", status: "working" }), change()],
      10,
    );
    expect(j.results.every((r) => r.ok)).toBe(true);
    expect(j).toMatchObject({ pages: ["done"], endsInChat: true, answer: "144", status: "done", t: 10 });
  });

  it("fails an answer said before the page, a silent turn, and a state it should never reach", () => {
    const j = judge(
      "answered",
      { answer: /144/, endsInChat: true, saysWhy: true, neverState: ["interrupted"] },
      [line("agent", "144"), page("done")],
      [change({ state: "interrupted" }), change({ status: "waiting", summary: SILENT })],
      10,
    );
    expect(Object.fromEntries(j.results.map((r) => [r.check, r.ok]))).toEqual({
      settled: true,
      "answer matches /144/": false,
      "answer ends the chat": false,
      "never read silent": false,
      "never interrupted": false,
    });
  });

  it("reports a checkpoint that never settled as failed", () => {
    const j = judge("answered", {}, [], [change({ state: "working" })], null);
    expect(j.t).toBeNull();
    expect(j.results).toEqual([{ check: "settled", ok: false }]);
  });

  it("prints pass or fail with the status timeline for each scenario", () => {
    const scenario = SCENARIOS[0]!;
    const ok = judge("answered", { answer: /144/ }, [line("agent", "144")], [change()], 10);
    const runs = [
      { scenario, workers: [{ name: "sc-simple-x", id: "id-1", changes: [change()], checkpoints: [ok], error: null }] },
      { scenario, workers: [{ name: "sc-simple-y", id: null, changes: [], checkpoints: [], error: "createWorker 409" }] },
    ];
    expect(runs.map(passed)).toEqual([true, false]);
    expect(report(runs[0]!)).toContain("=== PASS simple");
    expect(report(runs[0]!)).toMatch(/\+\s+10s\s+waiting\s+status=done/);
    expect(report(runs[1]!)).toContain("FAIL createWorker 409");
    expect(summary(runs)).toMatch(/1 passed, 1 failed$/);
  });
});
