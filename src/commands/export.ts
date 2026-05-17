import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import Database from "better-sqlite3";
import type { FlowDoc, Scenario, State } from "../schema.js";

interface ExportOpts {
  format: "csv" | "json";
  out: string;
  baselineDir?: string;       // .flowdoc — for baseline statuses
}

interface ScenarioRow {
  id: string;
  role: string;
  title: string;
  steps: number;
  path: number[];
  path_titles: string[];
  narrative: string;
  status: "pass" | "fail" | "drift" | "partial" | "untested";
  platforms_tested: string[];
  last_run_at: string | null;
  notes: string;
}

function computeStatus(sc: Scenario, baselineByState: Record<number, Record<string, any>>): { status: ScenarioRow["status"]; platforms: string[]; lastRunAt: string | null } {
  const statuses: string[] = [];
  const platSet = new Set<string>();
  let lastRunAt: string | null = null;
  for (const n of sc.path) {
    const byPlat = baselineByState[n];
    if (!byPlat) continue;
    for (const [plat, info] of Object.entries(byPlat)) {
      statuses.push((info as any).status);
      platSet.add(plat);
      const r = (info as any).ranAt;
      if (r && (!lastRunAt || r > lastRunAt)) lastRunAt = r;
    }
  }
  let status: ScenarioRow["status"];
  if (statuses.length === 0) status = "untested";
  else if (statuses.some((s) => s === "error")) status = "fail";
  else if (statuses.some((s) => s === "drift")) status = "drift";
  else if (statuses.every((s) => s === "match")) status = "pass";
  else status = "partial";
  return { status, platforms: [...platSet].sort(), lastRunAt };
}

function csvEscape(v: string | number): string {
  const s = String(v);
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

export function exportCommand(flowsArg: string, opts: ExportOpts) {
  const flowsPath = resolve(process.cwd(), flowsArg);
  if (!existsSync(flowsPath)) { console.error(`flows.json not found: ${flowsPath}`); process.exit(1); }
  const doc: FlowDoc = JSON.parse(readFileSync(flowsPath, "utf8"));
  const states: State[] = doc.states ?? [];
  const stateByNum = new Map(states.map((s) => [s.num, s]));
  const scenarios = doc.scenarios ?? [];

  // Pull baseline status from SQLite if available
  let baselineByState: Record<number, Record<string, any>> = {};
  if (opts.baselineDir) {
    const dbPath = resolve(process.cwd(), opts.baselineDir, "flowdoc.db");
    if (existsSync(dbPath)) {
      const db = new Database(dbPath, { readonly: true });
      try {
        const rows = db.prepare(`SELECT state_num, platform, status, ran_at FROM baseline_runs`).all() as any[];
        for (const r of rows) {
          if (!baselineByState[r.state_num]) baselineByState[r.state_num] = {};
          baselineByState[r.state_num][r.platform] = { status: r.status, ranAt: r.ran_at };
        }
      } catch {/* table may not exist */}
      db.close();
    }
  }

  const rows: ScenarioRow[] = scenarios.map((sc) => {
    const { status, platforms, lastRunAt } = computeStatus(sc, baselineByState);
    return {
      id: sc.id,
      role: sc.role ?? "any",
      title: sc.title,
      steps: sc.path.length,
      path: sc.path,
      path_titles: sc.path.map((n) => stateByNum.get(n)?.title ?? `#${n}`),
      narrative: sc.narrative ?? "",
      status,
      platforms_tested: platforms,
      last_run_at: lastRunAt,
      notes: "",
    };
  });

  const outPath = resolve(process.cwd(), opts.out);
  if (opts.format === "json") {
    const payload = {
      project: doc.title ?? "",
      generated_at: new Date().toISOString(),
      totals: {
        scenarios: rows.length,
        by_status: rows.reduce((m, r) => { m[r.status] = (m[r.status] ?? 0) + 1; return m; }, {} as Record<string, number>),
        by_role: rows.reduce((m, r) => { m[r.role] = (m[r.role] ?? 0) + 1; return m; }, {} as Record<string, number>),
      },
      states: states.map((s) => ({ num: s.num, id: s.id, title: s.title, kind: s.kind, roles: s.roles, path: s.path })),
      transitions: doc.transitions ?? [],
      scenarios: rows,
    };
    writeFileSync(outPath, JSON.stringify(payload, null, 2) + "\n", "utf8");
  } else {
    // CSV: one row per scenario
    const headers = [
      "id", "role", "title", "status", "steps",
      "path_nums", "path_titles", "platforms_tested", "last_run_at", "narrative", "notes_for_tester",
    ];
    const lines = [headers.join(",")];
    for (const r of rows) {
      lines.push([
        csvEscape(r.id),
        csvEscape(r.role),
        csvEscape(r.title),
        csvEscape(r.status),
        csvEscape(r.steps),
        csvEscape(r.path.join(" → ")),
        csvEscape(r.path_titles.join(" → ")),
        csvEscape(r.platforms_tested.join(";")),
        csvEscape(r.last_run_at ?? ""),
        csvEscape(r.narrative),
        csvEscape(r.notes),
      ].join(","));
    }
    writeFileSync(outPath, lines.join("\n") + "\n", "utf8");
  }
  const byStatus = rows.reduce((m, r) => { m[r.status] = (m[r.status] ?? 0) + 1; return m; }, {} as Record<string, number>);
  console.log(`✓ exported ${rows.length} scenarios → ${opts.out}`);
  console.log(`  by status: ${Object.entries(byStatus).map(([k, v]) => `${k}=${v}`).join(", ")}`);
}
