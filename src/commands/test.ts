import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { validateFlowDoc } from "../schema.js";
import { expandScenarioTree, resolveRouteRefs, toTestCases } from "./scenario-tree.js";
import {
  openTestDb, syncTestCases, listTestCases, getNextPending, markTestCase,
  resetTestCases, coverage, inferProjectFromTitle,
} from "./test-db.js";

const DEFAULT_PLATFORMS = ["web-desktop", "web-mobile", "ios", "android"];

interface CommonOpts {
  flows?: string;
  dbPath?: string;
  project?: string;
}

function openCtx(opts: CommonOpts & { requireFlows?: boolean }) {
  const dbPath = resolve(process.cwd(), opts.dbPath ?? ".flowdoc/flowdoc.db");
  const db = openTestDb(dbPath);
  let project = opts.project;
  let doc: ReturnType<typeof validateFlowDoc> | undefined;
  if (opts.flows || opts.requireFlows) {
    const flowsPath = resolve(process.cwd(), opts.flows ?? "flows.json");
    doc = validateFlowDoc(JSON.parse(readFileSync(flowsPath, "utf8")), { strictScenarios: false });
    if (!project) project = inferProjectFromTitle(doc.title);
  }
  if (!project) project = "default";
  return { db, project, doc, dbPath };
}

export function testSync(opts: CommonOpts & { platforms?: string[]; treeId?: string; maxCombinationSize?: number }): void {
  const { db, project, doc } = openCtx({ ...opts, requireFlows: true });
  if (!doc) return;
  const trees = (doc.scenarioTrees ?? []).filter((t) => !opts.treeId || t.id === opts.treeId);
  if (trees.length === 0) {
    console.error("No scenarioTrees[] matched. Add handwritten trees first.");
    process.exit(1);
  }
  const states = doc.states ?? [];
  let routes: ReturnType<typeof expandScenarioTree> = [];
  for (const t of trees) routes = routes.concat(expandScenarioTree(t, { maxCombinationSize: opts.maxCombinationSize ?? 3 }));
  const { ok } = resolveRouteRefs(routes, states);
  const platforms = opts.platforms && opts.platforms.length > 0 ? opts.platforms : DEFAULT_PLATFORMS;
  const cases = toTestCases(ok, states, platforms);
  const cleaned = cases.map((c) => ({
    routeId: c.routeId, treeId: c.treeId, platform: c.platform,
    title: c.title, role: c.role, kind: c.kind, steps: c.steps,
  }));
  const r = syncTestCases(db, project, cleaned);
  console.log(`✓ synced ${cases.length} test cases into ${db.name} (project=${project})`);
  console.log(`  inserted: ${r.inserted}  updated: ${r.updated}  dropped: ${r.dropped}`);
  console.log(`  platforms: ${platforms.join(", ")}`);
  db.close();
}

export function testList(opts: CommonOpts & {
  platform?: string; status?: "pass" | "fail" | "blocked" | "pending";
  kind?: string; role?: string; format?: "table" | "json"; limit?: number;
}): void {
  const { db, project } = openCtx(opts);
  const rows = listTestCases(db, { project, platform: opts.platform, status: opts.status, kind: opts.kind, role: opts.role, limit: opts.limit });
  if (opts.format === "json") {
    process.stdout.write(JSON.stringify(rows.map((r) => ({ ...r, steps_json: undefined, steps: JSON.parse(r.steps_json) })), null, 2) + "\n");
  } else {
    if (rows.length === 0) { console.log("(no rows)"); db.close(); return; }
    console.log(`${rows.length} test cases (project=${project}${opts.platform ? `, platform=${opts.platform}` : ""}${opts.status ? `, status=${opts.status}` : ""})`);
    console.log("");
    console.log(`${"ID".padEnd(60)}  ${"STATUS".padEnd(8)}  ${"PLATFORM".padEnd(12)}  ${"KIND".padEnd(8)}  ROLE`);
    console.log("─".repeat(105));
    for (const r of rows) {
      const status = r.status ?? "pending";
      console.log(`${r.id.slice(0, 60).padEnd(60)}  ${status.padEnd(8)}  ${r.platform.padEnd(12)}  ${r.kind.padEnd(8)}  ${r.role ?? ""}`);
    }
  }
  db.close();
}

export function testNext(opts: CommonOpts & { platform?: string; kind?: string; role?: string }): void {
  const { db, project } = openCtx(opts);
  const row = getNextPending(db, { project, platform: opts.platform, kind: opts.kind, role: opts.role });
  if (!row) {
    console.error(`No pending test case for project=${project}${opts.platform ? ` platform=${opts.platform}` : ""}`);
    process.exit(2);
  }
  process.stdout.write(JSON.stringify({ ...row, steps_json: undefined, steps: JSON.parse(row.steps_json) }, null, 2) + "\n");
  db.close();
}

export function testMark(opts: CommonOpts & { id: string; status: "pass" | "fail" | "blocked"; notes?: string }): void {
  const { db } = openCtx(opts);
  const ok = markTestCase(db, opts.id, opts.status, opts.notes ?? "");
  if (!ok) { console.error(`No such test case: ${opts.id}`); process.exit(2); }
  console.log(`✓ ${opts.id} → ${opts.status}${opts.notes ? ` ("${opts.notes.slice(0, 60)}")` : ""}`);
  db.close();
}

export function testReset(opts: CommonOpts & { platform?: string }): void {
  const { db, project } = openCtx(opts);
  const n = resetTestCases(db, { project, platform: opts.platform });
  console.log(`✓ reset ${n} test cases (project=${project}${opts.platform ? `, platform=${opts.platform}` : ""})`);
  db.close();
}

export function testStatus(opts: CommonOpts & { format?: "table" | "json" }): void {
  const { db, project } = openCtx(opts);
  const rows = coverage(db, project);
  if (rows.length === 0) { console.log(`(no test cases for project=${project} — run "flowdoc test sync" first)`); db.close(); return; }
  if (opts.format === "json") {
    process.stdout.write(JSON.stringify({ project, coverage: rows }, null, 2) + "\n");
    db.close();
    return;
  }
  console.log(`Coverage for project=${project}`);
  console.log("");
  console.log(`${"PLATFORM".padEnd(14)}  ${"KIND".padEnd(11)}  ${"TOTAL".padStart(6)}  ${"PASS".padStart(6)}  ${"FAIL".padStart(6)}  ${"BLOCK".padStart(6)}  ${"PEND".padStart(6)}  PROGRESS`);
  console.log("─".repeat(85));
  const tot = { total: 0, pass: 0, fail: 0, blocked: 0, pending: 0 };
  for (const r of rows) {
    const done = r.pass + r.fail + r.blocked;
    const pct = r.total === 0 ? 0 : Math.round((100 * done) / r.total);
    const bar = "█".repeat(Math.floor(pct / 10)) + "░".repeat(10 - Math.floor(pct / 10));
    console.log(`${r.platform.padEnd(14)}  ${r.kind.padEnd(11)}  ${String(r.total).padStart(6)}  ${String(r.pass).padStart(6)}  ${String(r.fail).padStart(6)}  ${String(r.blocked).padStart(6)}  ${String(r.pending).padStart(6)}  ${bar} ${pct}%`);
    tot.total += r.total; tot.pass += r.pass; tot.fail += r.fail; tot.blocked += r.blocked; tot.pending += r.pending;
  }
  console.log("─".repeat(85));
  const done = tot.pass + tot.fail + tot.blocked;
  const pct = tot.total === 0 ? 0 : Math.round((100 * done) / tot.total);
  console.log(`${"TOTAL".padEnd(14)}  ${"".padEnd(11)}  ${String(tot.total).padStart(6)}  ${String(tot.pass).padStart(6)}  ${String(tot.fail).padStart(6)}  ${String(tot.blocked).padStart(6)}  ${String(tot.pending).padStart(6)}  ${pct}% complete`);
  db.close();
}
