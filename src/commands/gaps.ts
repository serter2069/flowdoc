import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { validateFlowDoc, type ScenarioStep } from "../schema.js";
import { expandScenarioTree, resolveRouteRefs } from "./scenario-tree.js";

interface GapsOpts {
  format: "text" | "json";
  out?: string;          // if set, write report to this file
}

interface GapsReport {
  summary: {
    totalStates: number;
    coveredByHandwritten: number;
    coveredByAuto: number;
    coveredByBoth: number;
    uncovered: number;
    handwrittenRoutes: number;
    handwrittenTrees: number;
    autoScenarios: number;
    brokenStepRefs: number;
  };
  // States no scenario (handwritten OR auto) reaches — fully invisible to QA.
  uncovered: Array<{ num: number; title: string; path?: string; kind?: string; roles?: string[] }>;
  // States reached by auto-DFS but not by any handwritten tree —
  // top candidates for new handwritten scenarios.
  autoOnly: Array<{
    num: number; title: string; path?: string; kind?: string; roles?: string[];
    hitInAutoScenarios: number;     // how many auto scenarios touch this state
  }>;
  // Trees referencing states that have been deleted — needs author attention.
  brokenSteps: Array<{ treeId: string; routeId: string; step: string; missingRef: string }>;
  // Per-tree summary so author sees "tree X covers Y states, includes Z routes".
  trees: Array<{ id: string; title: string; kind: string; role?: string; routes: number; statesTouched: number }>;
}

/**
 * Walk a ScenarioStep tree and yield every stateRef it (or any descendant)
 * references. Mirrors the recursive structure of ScenarioStep itself.
 */
function* walkStateRefs(step: ScenarioStep): Generator<number> {
  if (step.stateRef !== undefined) yield step.stateRef;
  if (step.next) {
    const arr = Array.isArray(step.next) ? step.next : [step.next];
    for (const c of arr) yield* walkStateRefs(c);
  }
  if (step.branches) for (const c of Object.values(step.branches)) yield* walkStateRefs(c);
  if (step.variants) for (const c of step.variants) yield* walkStateRefs(c);
}

export function gapsCommand(flowsArg: string, opts: GapsOpts): void {
  const flowsPath = resolve(process.cwd(), flowsArg);
  const doc = validateFlowDoc(JSON.parse(readFileSync(flowsPath, "utf8")), { strictScenarios: false });
  const states = doc.states ?? [];
  const trees = doc.scenarioTrees ?? [];
  const scenarios = doc.scenarios ?? [];

  // Build coverage sets.
  const byNum = new Map(states.map((s) => [s.num, s]));
  const handwrittenStates = new Set<number>();
  const treeSummaries: GapsReport["trees"] = [];
  const brokenSteps: GapsReport["brokenSteps"] = [];
  let handwrittenRoutes = 0;

  for (const t of trees) {
    const local = new Set<number>();
    for (const n of walkStateRefs(t.tree)) {
      if (byNum.has(n)) {
        handwrittenStates.add(n);
        local.add(n);
      }
    }
    // Use the route expander to detect broken refs the same way the runner does.
    const routes = expandScenarioTree(t, { maxCombinationSize: 3 });
    handwrittenRoutes += routes.length;
    const { missing } = resolveRouteRefs(routes, states);
    for (const m of missing) {
      brokenSteps.push({ treeId: t.id, routeId: m.route.routeId, step: m.step.step, missingRef: m.ref });
    }
    treeSummaries.push({
      id: t.id, title: t.title, kind: t.kind, role: t.role,
      routes: routes.length, statesTouched: local.size,
    });
  }

  const autoStates = new Set<number>();
  const autoStateHitCount = new Map<number, number>();
  for (const sc of scenarios) {
    for (const n of sc.path) {
      autoStates.add(n);
      autoStateHitCount.set(n, (autoStateHitCount.get(n) ?? 0) + 1);
    }
  }

  // Compute buckets.
  const allStateNums = states.map((s) => s.num);
  const uncovered: GapsReport["uncovered"] = [];
  const autoOnly: GapsReport["autoOnly"] = [];
  let covBoth = 0;
  for (const n of allStateNums) {
    const inHand = handwrittenStates.has(n);
    const inAuto = autoStates.has(n);
    const s = byNum.get(n);
    if (!s) continue;
    // Pseudo-roots and synth Anonymous root we don't surface as gaps.
    if (s.id?.startsWith("synthetic-")) continue;
    if (!inHand && !inAuto) {
      uncovered.push({ num: n, title: s.title, path: s.path, kind: s.kind, roles: s.roles });
    } else if (inAuto && !inHand) {
      autoOnly.push({
        num: n, title: s.title, path: s.path, kind: s.kind, roles: s.roles,
        hitInAutoScenarios: autoStateHitCount.get(n) ?? 0,
      });
    } else if (inHand && inAuto) {
      covBoth++;
    }
  }
  // Sort autoOnly by hit count desc — highest-traffic states are most worth
  // a handwritten scenario.
  autoOnly.sort((a, b) => b.hitInAutoScenarios - a.hitInAutoScenarios);

  const report: GapsReport = {
    summary: {
      totalStates: states.length,
      coveredByHandwritten: handwrittenStates.size,
      coveredByAuto: autoStates.size,
      coveredByBoth: covBoth,
      uncovered: uncovered.length,
      handwrittenRoutes,
      handwrittenTrees: trees.length,
      autoScenarios: scenarios.length,
      brokenStepRefs: brokenSteps.length,
    },
    uncovered, autoOnly, brokenSteps, trees: treeSummaries,
  };

  if (opts.format === "json") {
    const json = JSON.stringify(report, null, 2);
    if (opts.out) { writeFileSync(resolve(process.cwd(), opts.out), json + "\n", "utf8"); console.log(`✓ wrote ${opts.out}`); }
    else process.stdout.write(json + "\n");
    return;
  }
  // Text output
  const lines: string[] = [];
  lines.push(`flowdoc gaps — coverage diff for ${flowsArg}`);
  lines.push("");
  const s = report.summary;
  lines.push(`States:          ${s.totalStates}`);
  lines.push(`  by handwritten:  ${s.coveredByHandwritten}  (${pct(s.coveredByHandwritten, s.totalStates)})`);
  lines.push(`  by auto:         ${s.coveredByAuto}  (${pct(s.coveredByAuto, s.totalStates)})`);
  lines.push(`  by both:         ${s.coveredByBoth}`);
  lines.push(`  uncovered:       ${s.uncovered}  (${pct(s.uncovered, s.totalStates)})`);
  lines.push("");
  lines.push(`Handwritten:    ${s.handwrittenTrees} trees → ${s.handwrittenRoutes} runnable routes`);
  lines.push(`Auto-scenarios: ${s.autoScenarios}`);
  if (s.brokenStepRefs > 0) lines.push(`⚠ Broken stepRefs: ${s.brokenStepRefs}`);
  lines.push("");

  if (report.trees.length > 0) {
    lines.push(`Per-tree coverage:`);
    for (const t of report.trees) {
      lines.push(`  · ${t.id}  [${t.kind}/${t.role ?? "?"}]  ${t.routes} routes, touches ${t.statesTouched} states`);
    }
    lines.push("");
  }

  lines.push(`Top auto-reached states without handwritten coverage (write trees for these):`);
  if (report.autoOnly.length === 0) lines.push(`  (none — every auto-state is covered by some handwritten tree ✓)`);
  for (const a of report.autoOnly.slice(0, 20)) {
    lines.push(`  #${a.num.toString().padStart(3, " ")}  ×${a.hitInAutoScenarios}  ${(a.path ?? a.title).slice(0, 40).padEnd(40)}  roles=${(a.roles ?? []).join(",")}`);
  }
  if (report.autoOnly.length > 20) lines.push(`  …and ${report.autoOnly.length - 20} more`);
  lines.push("");

  if (report.uncovered.length > 0) {
    lines.push(`Fully uncovered states (not in any scenario at all):`);
    for (const u of report.uncovered.slice(0, 20)) {
      lines.push(`  #${u.num.toString().padStart(3, " ")}  ${(u.path ?? u.title).slice(0, 40).padEnd(40)}  kind=${u.kind ?? "?"}  roles=${(u.roles ?? []).join(",")}`);
    }
    if (report.uncovered.length > 20) lines.push(`  …and ${report.uncovered.length - 20} more`);
    lines.push("");
  }

  if (report.brokenSteps.length > 0) {
    lines.push(`Broken stepRefs (tree references a deleted state):`);
    for (const b of report.brokenSteps.slice(0, 10)) {
      lines.push(`  [${b.treeId}] "${b.step.slice(0, 50)}" → ${b.missingRef}`);
    }
    if (report.brokenSteps.length > 10) lines.push(`  …and ${report.brokenSteps.length - 10} more`);
    lines.push("");
  }

  const out = lines.join("\n") + "\n";
  if (opts.out) { writeFileSync(resolve(process.cwd(), opts.out), out, "utf8"); console.log(`✓ wrote ${opts.out}`); }
  else process.stdout.write(out);
}

function pct(n: number, total: number): string {
  if (total === 0) return "0%";
  return `${Math.round((100 * n) / total)}%`;
}
