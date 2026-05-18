import type { ScenarioStep, ScenarioTree, State } from "../schema.js";

/**
 * A flattened route extracted from a scenario tree. Each route is one runnable
 * test case — a linear sequence of steps + the assertions to check.
 */
export interface ScenarioRoute {
  treeId: string;                                 // source tree id
  routeId: string;                                // unique route id within tree
  title: string;                                  // human readable, derived
  kind: "happy" | "edge" | "security" | "regression";
  role: string | undefined;
  steps: ScenarioRouteStep[];
}

export interface ScenarioRouteStep {
  step: string;
  stateRef?: number;
  stateId?: string;
  action?: string;
  expect?: string;
  as?: string;
}

/**
 * Expand a scenario tree into every unique route.
 *
 *  - next      → sequential continuation (Array next = parallel forks)
 *  - branches  → independent action set. Each non-empty subset of the
 *                branch keys yields one route (cartesian "any combination").
 *                The empty subset is skipped (always exists trivially as the
 *                parent route; we don't emit "do nothing" as a test).
 *  - variants  → mutually-exclusive variants: one route per variant.
 *  - leaf      → terminates the route at this step.
 *
 * Combination explosion is real: K branches → 2^K - 1 routes. We cap the
 * combination size to `maxCombinationSize` (default 3) so a node with 6
 * branches produces C(6,1)+C(6,2)+C(6,3) = 41 routes, not 63. Tunable
 * per-call when an explicit combination cap is wanted.
 */
export function expandScenarioTree(
  tree: ScenarioTree,
  opts: { maxCombinationSize?: number } = {},
): ScenarioRoute[] {
  const maxK = opts.maxCombinationSize ?? 3;
  const routes: ScenarioRoute[] = [];
  let counter = 0;

  function makeRoute(steps: ScenarioRouteStep[], suffix: string): ScenarioRoute {
    counter++;
    const last = steps[steps.length - 1];
    return {
      treeId: tree.id,
      routeId: `${tree.id}-${counter}`,
      title: `${tree.title} · ${suffix || last?.step || `route ${counter}`}`,
      kind: tree.kind,
      role: tree.role,
      steps: steps.slice(),
    };
  }

  function stepHead(s: ScenarioStep): ScenarioRouteStep {
    return {
      step: s.step,
      stateRef: s.stateRef,
      stateId: s.stateId,
      action: s.action,
      expect: s.expect,
      as: s.as,
    };
  }

  // Returns all forks of routes from a step's CHILDREN — does NOT include the
  // step itself. Caller appends step then continues from each fork.
  function continuationsAfter(step: ScenarioStep, prefix: ScenarioRouteStep[], labelPrefix: string): void {
    // leaf or nothing-after → finalize
    if (step.leaf || (!step.next && !step.branches && !step.variants)) {
      routes.push(makeRoute(prefix, labelPrefix));
      return;
    }

    // variants take precedence — pick-one semantics; emit one route per variant
    if (step.variants && step.variants.length > 0) {
      for (const v of step.variants) {
        walk(v, prefix, labelPrefix ? `${labelPrefix} · ${v.step}` : v.step);
      }
      return;
    }

    // branches: cartesian product of non-empty subsets, capped at maxK.
    if (step.branches) {
      const keys = Object.keys(step.branches);
      const subsets = nonEmptySubsets(keys, maxK);
      for (const subset of subsets) {
        // Each subset is an ORDERED ordering — emit one route per subset using
        // sorted-key order (deterministic). Inside the subset, walk each
        // sub-tree sequentially with its own continuations.
        runSubset(step.branches, subset, prefix, labelPrefix);
      }
      return;
    }

    // sequential next
    if (step.next) {
      if (Array.isArray(step.next)) {
        // parallel forks — each child branch is its own route continuation
        for (const child of step.next) {
          walk(child, prefix, labelPrefix);
        }
      } else {
        walk(step.next, prefix, labelPrefix);
      }
    }
  }

  function runSubset(
    branchMap: Record<string, ScenarioStep>,
    subsetKeys: string[],
    prefix: ScenarioRouteStep[],
    labelPrefix: string,
  ): void {
    // Walk subset items sequentially. Each item is itself a sub-tree, which
    // may have its own continuations. We DFS each one fully before moving to
    // the next. To avoid combinatorial blow-up across sub-tree continuations
    // we use single-route progression: each sub-tree's HEAD goes into the
    // route, then the next sub-tree's HEAD, etc. We only branch on the LAST
    // sub-tree's continuation. This keeps "manager does A + B + C" emit as
    // ONE route ending with C's outcome, not 27 routes.
    const sub = subsetKeys.map((k) => branchMap[k]);
    let pre = prefix.slice();
    const labels: string[] = [];
    for (let i = 0; i < sub.length - 1; i++) {
      pre = [...pre, stepHead(sub[i])];
      labels.push(sub[i].step);
    }
    const last = sub[sub.length - 1];
    labels.push(last.step);
    const subsetLabel = labels.join(" + ");
    const combinedPrefix = labelPrefix ? `${labelPrefix} · ${subsetLabel}` : subsetLabel;
    walk(last, pre, combinedPrefix);
  }

  function walk(step: ScenarioStep, prefix: ScenarioRouteStep[], label: string): void {
    const here = [...prefix, stepHead(step)];
    continuationsAfter(step, here, label);
  }

  walk(tree.tree, [], "");
  return routes;
}

/** Power-set (non-empty), capped at size maxK. Ordered by size asc. */
function nonEmptySubsets<T>(items: T[], maxK: number): T[][] {
  const out: T[][] = [];
  const n = items.length;
  const cap = Math.min(maxK, n);
  // iterate k = 1..cap
  for (let k = 1; k <= cap; k++) {
    pick(items, k, 0, [], out);
  }
  return out;
}
function pick<T>(items: T[], k: number, start: number, cur: T[], out: T[][]): void {
  if (cur.length === k) { out.push(cur.slice()); return; }
  for (let i = start; i < items.length; i++) {
    cur.push(items[i]);
    pick(items, k, i + 1, cur, out);
    cur.pop();
  }
}

/**
 * Resolve every stateRef / stateId on a route's steps. Returns the route as-is
 * but with `stateRef` populated even when only `stateId` was given. Throws if
 * a step references a state that doesn't exist — keeps trees honest about the
 * underlying graph.
 */
export function resolveRouteRefs(routes: ScenarioRoute[], states: State[]): { ok: ScenarioRoute[]; missing: Array<{ route: ScenarioRoute; step: ScenarioRouteStep; ref: string }> } {
  const byNum = new Map(states.map((s) => [s.num, s]));
  const byId = new Map(states.map((s) => [s.id, s]));
  const missing: Array<{ route: ScenarioRoute; step: ScenarioRouteStep; ref: string }> = [];
  const ok: ScenarioRoute[] = [];
  for (const r of routes) {
    let bad = false;
    for (const s of r.steps) {
      if (s.stateRef !== undefined) {
        if (!byNum.has(s.stateRef)) { missing.push({ route: r, step: s, ref: `#${s.stateRef}` }); bad = true; }
      } else if (s.stateId) {
        const st = byId.get(s.stateId);
        if (!st) { missing.push({ route: r, step: s, ref: s.stateId }); bad = true; }
        else s.stateRef = st.num;
      }
    }
    if (!bad) ok.push(r);
  }
  return { ok, missing };
}

/** Render a flat CSV — one row per route × step (optionally × platform). */
export function toCsv(routes: ScenarioRoute[], states: State[], platforms: string[] = []): string {
  const byNum = new Map(states.map((s) => [s.num, s]));
  const rows: string[][] = [];
  const platformList = platforms.length > 0 ? platforms : [""];
  rows.push(["route_id", "tree_id", "title", "kind", "role", "platform", "step_no", "step", "state", "action", "expect", "as", "completed", "status", "notes"]);
  for (const r of routes) {
    for (const platform of platformList) {
      r.steps.forEach((s, i) => {
        const state = s.stateRef !== undefined ? byNum.get(s.stateRef) : undefined;
        const stateLabel = state ? `#${state.num} ${state.title}` : (s.stateId ?? "");
        rows.push([
          r.routeId, r.treeId, r.title, r.kind, r.role ?? "", platform,
          String(i + 1), s.step, stateLabel, s.action ?? "", s.expect ?? "", s.as ?? "",
          "no", "", "",
        ]);
      });
    }
  }
  return rows.map((row) => row.map(csvCell).join(",")).join("\n") + "\n";
}

/**
 * Flatten routes into per-platform test cases. Each (route, platform) gets a
 * unique test_case_id, a completed=false marker, and an empty status/notes
 * field that downstream agents fill in. Output is the JSON shape that the
 * agent contract expects: one entry per testable target.
 */
export function toTestCases(routes: ScenarioRoute[], states: State[], platforms: string[]): TestCase[] {
  const byNum = new Map(states.map((s) => [s.num, s]));
  const out: TestCase[] = [];
  for (const r of routes) {
    for (const platform of platforms) {
      out.push({
        testCaseId: `${r.routeId}__${platform}`,
        routeId: r.routeId,
        treeId: r.treeId,
        title: r.title,
        kind: r.kind,
        role: r.role,
        platform,
        completed: false,
        status: null,
        notes: "",
        steps: r.steps.map((s, i) => {
          const state = s.stateRef !== undefined ? byNum.get(s.stateRef) : undefined;
          return {
            stepNo: i + 1,
            step: s.step,
            stateRef: s.stateRef,
            statePath: state?.path,
            stateTitle: state?.title,
            action: s.action,
            expect: s.expect,
            as: s.as,
          };
        }),
      });
    }
  }
  return out;
}

export interface TestCase {
  testCaseId: string;
  routeId: string;
  treeId: string;
  title: string;
  kind: string;
  role?: string;
  platform: string;
  completed: boolean;
  status: "pass" | "fail" | "blocked" | null;
  notes: string;
  steps: Array<{
    stepNo: number;
    step: string;
    stateRef?: number;
    statePath?: string;
    stateTitle?: string;
    action?: string;
    expect?: string;
    as?: string;
  }>;
}

function csvCell(v: string): string {
  if (/[",\n]/.test(v)) return `"${v.replace(/"/g, '""')}"`;
  return v;
}
