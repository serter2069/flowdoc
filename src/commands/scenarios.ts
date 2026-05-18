import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { validateFlowDoc } from "../schema.js";
import { expandScenarioTree, resolveRouteRefs, toCsv, toTestCases } from "./scenario-tree.js";

interface ScenariosOpts {
  format: "csv" | "json";
  out: string;
  maxCombinationSize: number;
  treeId?: string;
  platforms?: string[];        // ["web-desktop","web-mobile","ios","android"]
}

export const DEFAULT_PLATFORMS = ["web-desktop", "web-mobile", "ios", "android"];

/**
 * Read scenarioTrees[] from flows.json, expand each via DFS into a flat list
 * of runnable routes, validate every stateRef against states[], and write a
 * CSV or JSON dump.
 *
 * Output is the test plan: one route per row in CSV, ready to hand to a
 * tester or feed to a test-runner agent.
 */
export function scenariosCommand(flowsArg: string, opts: ScenariosOpts): void {
  const flowsPath = resolve(process.cwd(), flowsArg);
  const doc = validateFlowDoc(JSON.parse(readFileSync(flowsPath, "utf8")), { strictScenarios: false });
  const trees = doc.scenarioTrees ?? [];
  if (trees.length === 0) {
    console.error(`No scenarioTrees[] in ${flowsArg} — add handwritten trees first.`);
    process.exit(1);
  }
  const states = doc.states ?? [];
  const targets = opts.treeId ? trees.filter((t) => t.id === opts.treeId) : trees;
  if (targets.length === 0) {
    console.error(`No scenario tree with id "${opts.treeId}". Available: ${trees.map((t) => t.id).join(", ")}`);
    process.exit(1);
  }

  let allRoutes: ReturnType<typeof expandScenarioTree> = [];
  for (const tree of targets) {
    const routes = expandScenarioTree(tree, { maxCombinationSize: opts.maxCombinationSize });
    allRoutes = [...allRoutes, ...routes];
  }
  const { ok, missing } = resolveRouteRefs(allRoutes, states);
  if (missing.length) {
    console.warn(`⚠ ${missing.length} step(s) reference unknown states — these routes were dropped:`);
    for (const m of missing.slice(0, 10)) {
      console.warn(`  [${m.route.routeId}] "${m.step.step}" → state ${m.ref}`);
    }
  }

  const platforms = opts.platforms && opts.platforms.length > 0 ? opts.platforms : [];
  const outPath = resolve(process.cwd(), opts.out);
  if (opts.format === "json") {
    if (platforms.length > 0) {
      // Per-platform test-case shape: one entry per (route × platform), each
      // with a completed/status field a downstream agent will fill in.
      const cases = toTestCases(ok, states, platforms);
      writeFileSync(outPath, JSON.stringify({ platforms, testCases: cases }, null, 2) + "\n", "utf8");
      console.log(`  test cases: ${cases.length}  (${ok.length} routes × ${platforms.length} platforms)`);
    } else {
      writeFileSync(outPath, JSON.stringify({ routes: ok }, null, 2) + "\n", "utf8");
    }
  } else {
    writeFileSync(outPath, toCsv(ok, states, platforms), "utf8");
  }
  console.log(`✓ expanded ${targets.length} tree(s) → ${ok.length} route(s) (${ok.reduce((n, r) => n + r.steps.length, 0)} steps)`);
  console.log(`  by kind: ${count(ok, (r) => r.kind)}`);
  console.log(`  by role: ${count(ok, (r) => r.role ?? "anon")}`);
  if (platforms.length > 0) console.log(`  platforms: ${platforms.join(", ")}`);
  console.log(`  wrote ${opts.out}`);
}

function count<T>(arr: T[], key: (x: T) => string): string {
  const m: Record<string, number> = {};
  for (const x of arr) m[key(x)] = (m[key(x)] ?? 0) + 1;
  return Object.entries(m).map(([k, v]) => `${k}=${v}`).join(", ");
}
