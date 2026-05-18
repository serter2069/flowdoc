import { describe, it, expect } from "vitest";
import { assignOptionCoverage, buildTupleUniverse } from "../option-coverage.js";
import type { Scenario, State } from "../../schema.js";

const mkScenario = (id: string, path: number[], extra: Partial<Scenario> = {}): Scenario => ({
  id, title: id, path, tags: ["auto-generated"], ...extra,
});

const select = (label: string, domain: string[]) => ({ kind: "select" as const, label, domain });
const param = (name: string, values: string[]) => ({ name, source: "route" as const, values, type: "enum" });

describe("buildTupleUniverse", () => {
  it("emits tuples for controls with domain.length >= 2", () => {
    const states: State[] = [{ num: 1, id: "s1", title: "S1", kind: "page", controls: [select("status", ["a", "b", "c"])] }];
    const tuples = buildTupleUniverse(states);
    expect(tuples).toHaveLength(3);
    expect(tuples.map(t => t.option)).toEqual(["a", "b", "c"]);
    expect(tuples[0].targetKey).toBe("c0");
  });

  it("skips controls with domain.length < 2", () => {
    const states: State[] = [{ num: 1, id: "s1", title: "S1", kind: "page",
      controls: [{ kind: "input", label: "x" }, select("only", ["x"])] }];
    expect(buildTupleUniverse(states)).toHaveLength(0);
  });

  it("includes params with values[]", () => {
    const states: State[] = [{ num: 1, id: "s1", title: "S1", kind: "page", params: [param("tab", ["info", "history"])] }];
    const tuples = buildTupleUniverse(states);
    expect(tuples).toHaveLength(2);
    expect(tuples[0].targetKey).toBe("p:tab");
  });
});

describe("assignOptionCoverage", () => {
  const states3opts: State[] = [
    { num: 1, id: "anon", title: "Anonymous root", kind: "page" },
    { num: 2, id: "form", title: "Form", kind: "page", controls: [select("status", ["draft", "published", "rejected"])] },
  ];

  it("INVARIANT: every reachable tuple is either covered or in gaps (no silent drops)", () => {
    const scenarios = [mkScenario("a", [1, 2])];
    const { assigned, gaps } = assignOptionCoverage(scenarios, states3opts);
    const tuples = buildTupleUniverse(states3opts);
    expect(assigned + gaps.length).toBe(tuples.length);
  });

  it("INVARIANT: no scenario has duplicate assignments for same (state, target)", () => {
    const scenarios = [mkScenario("a", [1, 2]), mkScenario("b", [1, 2]), mkScenario("c", [1, 2])];
    assignOptionCoverage(scenarios, states3opts);
    for (const s of scenarios) {
      const seen = new Set<string>();
      for (const a of s.optionAssignments ?? []) {
        const key = a.target.kind === "control" ? `${a.stateNum}:c${a.target.idx}` : `${a.stateNum}:p:${a.target.name}`;
        expect(seen.has(key)).toBe(false);
        seen.add(key);
      }
    }
  });

  it("3 scenarios x 3 options → full coverage, zero gaps", () => {
    const scenarios = [mkScenario("a", [1, 2]), mkScenario("b", [1, 2]), mkScenario("c", [1, 2])];
    const { assigned, gaps } = assignOptionCoverage(scenarios, states3opts);
    expect(assigned).toBe(3);
    expect(gaps).toEqual([]);
    expect(scenarios.every(s => s.optionAssignments?.length === 1)).toBe(true);
    const options = scenarios.map(s => s.optionAssignments![0].option).sort();
    expect(options).toEqual(["draft", "published", "rejected"]);
  });

  it("1 scenario x 3 options → 1 assigned, 2 gaps", () => {
    const scenarios = [mkScenario("a", [1, 2])];
    const { assigned, gaps } = assignOptionCoverage(scenarios, states3opts);
    expect(assigned).toBe(1);
    expect(gaps).toHaveLength(2);
    expect(gaps.every(g => g.stateNum === 2 && g.targetKey === "c0")).toBe(true);
  });

  it("tuples on unreachable states are silently skipped (out of scope for this layer)", () => {
    // Contract: assignOptionCoverage only considers tuples on states reached by
    // some scenario. Unreachable states are a separate concern (no scenario will
    // ever cover them) — derive reachability gaps from buildTupleUniverse +
    // scenario paths if you need them.
    const scenarios = [mkScenario("a", [1])];
    const { assigned, gaps } = assignOptionCoverage(scenarios, states3opts);
    expect(assigned).toBe(0);
    expect(gaps).toEqual([]);
  });

  it("carrier-saturated state produces gaps for the leftover options", () => {
    // 2 carriers but 3 options → 2 assigned + 1 gap (carrier exhaustion).
    const scenarios = [mkScenario("a", [1, 2]), mkScenario("b", [1, 2])];
    const { assigned, gaps } = assignOptionCoverage(scenarios, states3opts);
    expect(assigned).toBe(2);
    expect(gaps).toHaveLength(1);
  });

  it("idempotent: rerun produces identical assignments", () => {
    const make = () => [mkScenario("a", [1, 2]), mkScenario("b", [1, 2]), mkScenario("c", [1, 2])];
    const a = make();
    const b = make();
    assignOptionCoverage(a, states3opts);
    assignOptionCoverage(b, states3opts);
    for (let i = 0; i < a.length; i++) {
      expect(a[i].optionAssignments).toEqual(b[i].optionAssignments);
    }
  });

  it("rerun on already-assigned auto scenarios resets and reassigns (no accumulation)", () => {
    const scenarios = [mkScenario("a", [1, 2]), mkScenario("b", [1, 2]), mkScenario("c", [1, 2])];
    assignOptionCoverage(scenarios, states3opts);
    const firstRunCounts = scenarios.map(s => s.optionAssignments?.length ?? 0);
    assignOptionCoverage(scenarios, states3opts);
    const secondRunCounts = scenarios.map(s => s.optionAssignments?.length ?? 0);
    expect(secondRunCounts).toEqual(firstRunCounts);
  });

  it("hand-written scenarios keep their assignments across reruns", () => {
    const hand: Scenario = {
      id: "manual", title: "manual", path: [1, 2],
      optionAssignments: [{ stateNum: 2, target: { kind: "control", idx: 0 }, option: "draft" }],
      // no "auto-generated" tag
    };
    const auto = mkScenario("auto", [1, 2]);
    assignOptionCoverage([hand, auto], states3opts);
    expect(hand.optionAssignments).toEqual([{ stateNum: 2, target: { kind: "control", idx: 0 }, option: "draft" }]);
    // Auto scenario picks one of the remaining two options
    expect(auto.optionAssignments).toHaveLength(1);
    expect(["published", "rejected"]).toContain(auto.optionAssignments![0].option);
  });

  it("empty universe → no-op result", () => {
    const states: State[] = [{ num: 1, id: "s1", title: "S1", kind: "page" }];
    const { assigned, gaps } = assignOptionCoverage([mkScenario("a", [1])], states);
    expect(assigned).toBe(0);
    expect(gaps).toEqual([]);
  });

  it("empty optionAssignments array is removed from scenario", () => {
    const states: State[] = [
      { num: 1, id: "s1", title: "S1", kind: "page" },
      { num: 2, id: "s2", title: "S2", kind: "page", controls: [select("x", ["a", "b"])] },
    ];
    const s1 = mkScenario("a", [1]);          // doesn't pass through state 2
    const s2 = mkScenario("b", [1, 2]);       // does
    assignOptionCoverage([s1, s2], states);
    expect("optionAssignments" in s1).toBe(false);
    expect(s2.optionAssignments).toHaveLength(1);
  });

  it("multiple targets on the same state are independent", () => {
    const states: State[] = [{
      num: 1, id: "s1", title: "S1", kind: "page",
      controls: [select("a", ["x", "y"]), select("b", ["p", "q"])],
    }];
    const scenarios = [mkScenario("a", [1]), mkScenario("b", [1])];
    assignOptionCoverage(scenarios, states);
    // Each scenario gets one of (control[0], control[1]); 4 tuples, 2 scenarios × 2 controls = 4 slots
    const total = scenarios.reduce((n, s) => n + (s.optionAssignments?.length ?? 0), 0);
    expect(total).toBe(4);
  });

  it("params and controls coexist on same state", () => {
    const states: State[] = [{
      num: 1, id: "s1", title: "S1", kind: "page",
      controls: [select("status", ["a", "b"])],
      params: [param("tab", ["info", "history"])],
    }];
    const scenarios = [mkScenario("x", [1]), mkScenario("y", [1])];
    const { assigned } = assignOptionCoverage(scenarios, states);
    expect(assigned).toBe(4);
  });
});
