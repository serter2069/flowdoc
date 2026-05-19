import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Schema for handwritten-scenario test runs. Lives alongside the existing
 * baseline_runs table in .flowdoc/flowdoc.db. Idempotent — sync upserts by
 * test_case_id, status/notes/completed_at survive across syncs so an agent's
 * "pass" mark doesn't get wiped when the route definition is unchanged.
 */
export interface TestCaseRow {
  id: string;                      // {project}__{routeId}__{platform}
  project: string;
  route_id: string;
  tree_id: string;
  platform: string;                // web-desktop / web-mobile / ios / android / custom
  title: string;
  role: string | null;
  kind: string;
  steps_json: string;              // JSON-encoded steps[] for the agent
  status: "pass" | "fail" | "blocked" | null;
  completed_at: string | null;     // ISO datetime
  notes: string;
  created_at: string;
  updated_at: string;
}

export function openTestDb(dbPath: string): Database.Database {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS test_cases (
      id TEXT PRIMARY KEY,
      project TEXT NOT NULL,
      route_id TEXT NOT NULL,
      tree_id TEXT NOT NULL,
      platform TEXT NOT NULL,
      title TEXT NOT NULL,
      role TEXT,
      kind TEXT NOT NULL,
      steps_json TEXT NOT NULL,
      status TEXT,
      completed_at TEXT,
      notes TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_tc_project_platform ON test_cases (project, platform);
    CREATE INDEX IF NOT EXISTS idx_tc_completed ON test_cases (project, status);
    CREATE INDEX IF NOT EXISTS idx_tc_route ON test_cases (project, route_id);
  `);
  return db;
}

export function syncTestCases(
  db: Database.Database,
  project: string,
  cases: Array<{
    routeId: string; treeId: string; platform: string; title: string;
    role?: string; kind: string; steps: unknown[];
  }>,
): { inserted: number; updated: number; dropped: number } {
  const desired = new Set<string>();
  for (const c of cases) desired.add(`${project}__${c.routeId}__${c.platform}`);

  // Find rows that should be dropped (no longer in cases for this project)
  const existing = db.prepare(`SELECT id FROM test_cases WHERE project = ?`).all(project) as Array<{ id: string }>;
  const toDrop = existing.filter((r) => !desired.has(r.id)).map((r) => r.id);

  const insertStmt = db.prepare(`
    INSERT INTO test_cases (id, project, route_id, tree_id, platform, title, role, kind, steps_json)
    VALUES (@id, @project, @routeId, @treeId, @platform, @title, @role, @kind, @stepsJson)
    ON CONFLICT(id) DO UPDATE SET
      title = excluded.title,
      role = excluded.role,
      kind = excluded.kind,
      steps_json = excluded.steps_json,
      updated_at = datetime('now')
  `);
  const dropStmt = db.prepare(`DELETE FROM test_cases WHERE id = ?`);

  let inserted = 0;
  let updated = 0;
  const beforeCount = (db.prepare(`SELECT COUNT(*) AS n FROM test_cases WHERE project = ?`).get(project) as { n: number }).n;

  const tx = db.transaction(() => {
    for (const c of cases) {
      const id = `${project}__${c.routeId}__${c.platform}`;
      const isExisting = (db.prepare(`SELECT 1 FROM test_cases WHERE id = ?`).get(id) !== undefined);
      insertStmt.run({
        id, project, routeId: c.routeId, treeId: c.treeId, platform: c.platform,
        title: c.title, role: c.role ?? null, kind: c.kind, stepsJson: JSON.stringify(c.steps),
      });
      if (isExisting) updated++; else inserted++;
    }
    for (const id of toDrop) dropStmt.run(id);
  });
  tx();

  const afterCount = (db.prepare(`SELECT COUNT(*) AS n FROM test_cases WHERE project = ?`).get(project) as { n: number }).n;
  // Sanity — inserted should match growth
  if (afterCount - beforeCount !== inserted - toDrop.length) {
    // Off-by-one with the duplicate-detection — recompute from final counts.
    inserted = Math.max(0, afterCount - (beforeCount - toDrop.length));
    updated = cases.length - inserted;
  }
  return { inserted, updated, dropped: toDrop.length };
}

export function listTestCases(
  db: Database.Database,
  filters: { project?: string; platform?: string; status?: "pass" | "fail" | "blocked" | "pending"; kind?: string; role?: string; limit?: number },
): TestCaseRow[] {
  const where: string[] = [];
  const params: Record<string, unknown> = {};
  if (filters.project) { where.push("project = @project"); params.project = filters.project; }
  if (filters.platform) { where.push("platform = @platform"); params.platform = filters.platform; }
  if (filters.kind) { where.push("kind = @kind"); params.kind = filters.kind; }
  if (filters.role) { where.push("role = @role"); params.role = filters.role; }
  if (filters.status === "pending") where.push("status IS NULL");
  else if (filters.status) { where.push("status = @status"); params.status = filters.status; }
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const limitSql = filters.limit ? `LIMIT ${filters.limit}` : "";
  return db.prepare(`SELECT * FROM test_cases ${whereSql} ORDER BY id ${limitSql}`).all(params) as TestCaseRow[];
}

export function getNextPending(
  db: Database.Database,
  filters: { project: string; platform?: string; kind?: string; role?: string },
): TestCaseRow | undefined {
  return listTestCases(db, { ...filters, status: "pending", limit: 1 })[0];
}

export function markTestCase(
  db: Database.Database,
  id: string,
  status: "pass" | "fail" | "blocked",
  notes: string = "",
): boolean {
  const r = db.prepare(`
    UPDATE test_cases
    SET status = ?, notes = ?, completed_at = datetime('now'), updated_at = datetime('now')
    WHERE id = ?
  `).run(status, notes, id);
  return r.changes > 0;
}

/**
 * Merge a runner-job report into test_cases. For every route in the report
 * we upsert a (project, route_id, platform='web-desktop') row with the run's
 * pass/fail status and a short reason (first failing step). Mobile platforms
 * stay untouched — Playwright doesn't test them.
 */
export function ingestRunReport(
  db: Database.Database,
  args: {
    project: string;
    platform: string;             // typically 'web-desktop'
    routes: Array<{
      routeId: string;
      treeId: string;
      title: string;
      role?: string;
      kind: string;
      status: "pass" | "fail";
      failedAt?: number;
      steps: Array<{ step: string; expect?: string; status: "pass" | "fail" | "skip"; adapter?: { reason?: string }; consoleErrors?: string[]; pageErrors?: string[] }>;
    }>;
  },
): { upserted: number; passed: number; failed: number } {
  const { project, platform, routes } = args;
  const upsert = db.prepare(`
    INSERT INTO test_cases (id, project, route_id, tree_id, platform, title, role, kind, steps_json, status, notes, completed_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
    ON CONFLICT(id) DO UPDATE SET
      status = excluded.status,
      notes = excluded.notes,
      completed_at = datetime('now'),
      updated_at = datetime('now')
  `);
  let passed = 0, failed = 0;
  const tx = db.transaction(() => {
    for (const rt of routes) {
      const id = `${project}__${rt.routeId}__${platform}`;
      let notes = "";
      if (rt.status === "fail") {
        const i = rt.failedAt ?? 0;
        const s = rt.steps[i];
        const reason = s?.adapter?.reason
          ?? (s?.pageErrors?.[0] && `page: ${s.pageErrors[0]}`)
          ?? (s?.consoleErrors?.[0] && `console: ${s.consoleErrors[0]}`)
          ?? "see job report";
        notes = `step ${i + 1}: ${s?.step ?? ""} — ${reason}`.slice(0, 500);
      }
      upsert.run(id, project, rt.routeId, rt.treeId, platform, rt.title, rt.role ?? null, rt.kind, JSON.stringify(rt.steps), rt.status, notes);
      if (rt.status === "pass") passed++; else failed++;
    }
  });
  tx();
  return { upserted: routes.length, passed, failed };
}

export function resetTestCases(
  db: Database.Database,
  filters: { project: string; platform?: string },
): number {
  const where: string[] = ["project = @project"];
  const params: Record<string, unknown> = { project: filters.project };
  if (filters.platform) { where.push("platform = @platform"); params.platform = filters.platform; }
  const r = db.prepare(`
    UPDATE test_cases
    SET status = NULL, notes = '', completed_at = NULL, updated_at = datetime('now')
    WHERE ${where.join(" AND ")}
  `).run(params);
  return r.changes;
}

export interface CoverageRow {
  platform: string;
  kind: string;
  total: number;
  pass: number;
  fail: number;
  blocked: number;
  pending: number;
}
export function coverage(db: Database.Database, project: string): CoverageRow[] {
  return db.prepare(`
    SELECT
      platform, kind,
      COUNT(*) AS total,
      SUM(CASE WHEN status = 'pass'    THEN 1 ELSE 0 END) AS pass,
      SUM(CASE WHEN status = 'fail'    THEN 1 ELSE 0 END) AS fail,
      SUM(CASE WHEN status = 'blocked' THEN 1 ELSE 0 END) AS blocked,
      SUM(CASE WHEN status IS NULL     THEN 1 ELSE 0 END) AS pending
    FROM test_cases WHERE project = ?
    GROUP BY platform, kind
    ORDER BY platform, kind
  `).all(project) as CoverageRow[];
}

export function inferProjectFromTitle(title?: string): string {
  if (!title) return "default";
  // "Pluto — auto-scanned (Laravel) + RN frontend" → "pluto"
  const first = title.split(/[\s—–\-(]/)[0]?.trim().toLowerCase();
  return (first ?? "default").replace(/[^a-z0-9_-]/g, "") || "default";
}
