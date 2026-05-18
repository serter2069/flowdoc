import type { OptionAssignment, Scenario, State } from "../schema.js";

export type CoverageGap = {
  stateNum: number;
  targetKey: string;
  option: string;
  label: string;
};

export type CoverageResult = {
  assigned: number;
  gaps: CoverageGap[];
};

type Tuple = CoverageGap & { target: OptionAssignment["target"] };

const targetKeyOf = (a: OptionAssignment) =>
  a.target.kind === "control" ? `c${a.target.idx}` : `p:${a.target.name}`;

const tupleKey = (t: Tuple) => `${t.stateNum}:${t.targetKey}:${t.option}`;

/**
 * Build the universe of (state, control/param, option) tuples worth covering:
 * controls with domain.length>=2 or params with values.length>=2 attached to a
 * State. Tuples are emitted in a deterministic order (states ascending, then
 * controls before params, then option order from source).
 */
export function buildTupleUniverse(states: State[]): Tuple[] {
  const out: Tuple[] = [];
  for (const s of states) {
    (s.controls ?? []).forEach((c, i) => {
      if (c.domain && c.domain.length > 1) {
        for (const o of c.domain) out.push({
          stateNum: s.num,
          targetKey: `c${i}`,
          target: { kind: "control", idx: i },
          option: o,
          label: c.label || `control[${i}]`,
        });
      }
    });
    for (const p of s.params ?? []) {
      if (p.values && p.values.length > 1) {
        for (const v of p.values) out.push({
          stateNum: s.num,
          targetKey: `p:${p.name}`,
          target: { kind: "param", name: p.name },
          option: v,
          label: p.name,
        });
      }
    }
  }
  return out;
}

/**
 * Distribute every (state, control/param, option) tuple in the universe across
 * scenarios that pass through that state, mutating each scenario's
 * `optionAssignments` in place. Each scenario receives at most ONE option per
 * (state, target) — no cloning, scenario count stays flat. Tuples that don't
 * fit (state unreached, or all carriers already have an assignment on that
 * target) are returned as `gaps`.
 *
 * - Scenarios tagged "auto-generated" have their assignments reset first so
 *   reruns don't accumulate stale picks.
 * - Hand-written scenarios keep their existing optionAssignments and those
 *   tuples are pre-seeded as already-covered.
 * - Empty optionAssignments arrays are removed from the scenario object at
 *   the end to keep JSON output clean.
 *
 * Pure-ish: doesn't read or write any IO; mutates `scenarios[i].optionAssignments`.
 */
export function assignOptionCoverage(scenarios: Scenario[], states: State[]): CoverageResult {
  const tupleUniverse = buildTupleUniverse(states);

  const reachable = new Set<number>();
  for (const s of scenarios) for (const n of s.path) reachable.add(n);
  const reachableTuples = tupleUniverse.filter((t) => reachable.has(t.stateNum));

  if (reachableTuples.length === 0) return { assigned: 0, gaps: [] };

  const carriersByStateTarget = new Map<string, Scenario[]>();
  for (const t of reachableTuples) {
    const key = `${t.stateNum}:${t.targetKey}`;
    if (carriersByStateTarget.has(key)) continue;
    carriersByStateTarget.set(key, scenarios.filter((s) => s.path.includes(t.stateNum)));
  }

  for (const s of scenarios) {
    if (s.tags?.includes("auto-generated")) s.optionAssignments = [];
    else s.optionAssignments = s.optionAssignments ?? [];
  }

  const covered = new Set<string>();
  const hasAssignment = (s: Scenario, stateNum: number, targetKey: string) =>
    (s.optionAssignments ?? []).some((a) => a.stateNum === stateNum && targetKeyOf(a) === targetKey);

  for (const s of scenarios) {
    for (const a of s.optionAssignments ?? []) {
      covered.add(`${a.stateNum}:${targetKeyOf(a)}:${a.option}`);
    }
  }

  const byDifficulty = reachableTuples.slice().sort((a, b) => {
    const ca = carriersByStateTarget.get(`${a.stateNum}:${a.targetKey}`)?.length ?? 0;
    const cb = carriersByStateTarget.get(`${b.stateNum}:${b.targetKey}`)?.length ?? 0;
    if (ca !== cb) return ca - cb;
    if (a.stateNum !== b.stateNum) return a.stateNum - b.stateNum;
    if (a.targetKey !== b.targetKey) return a.targetKey < b.targetKey ? -1 : 1;
    return a.option < b.option ? -1 : 1;
  });

  let assigned = 0;
  const gaps: CoverageGap[] = [];
  for (const t of byDifficulty) {
    if (covered.has(tupleKey(t))) continue;
    const carriers = carriersByStateTarget.get(`${t.stateNum}:${t.targetKey}`) ?? [];
    const candidate = carriers
      .filter((s) => !hasAssignment(s, t.stateNum, t.targetKey))
      .sort((a, b) => {
        const la = a.optionAssignments?.length ?? 0;
        const lb = b.optionAssignments?.length ?? 0;
        if (la !== lb) return la - lb;
        return a.id < b.id ? -1 : 1;
      })[0];
    if (!candidate) {
      gaps.push({ stateNum: t.stateNum, targetKey: t.targetKey, option: t.option, label: t.label });
      continue;
    }
    candidate.optionAssignments!.push({
      stateNum: t.stateNum,
      target: t.target,
      option: t.option,
    });
    covered.add(tupleKey(t));
    assigned++;
  }

  for (const s of scenarios) {
    if (!s.optionAssignments || s.optionAssignments.length === 0) delete (s as { optionAssignments?: OptionAssignment[] }).optionAssignments;
  }

  return { assigned, gaps };
}
