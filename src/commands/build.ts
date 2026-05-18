import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import Database from "better-sqlite3";
import { validateFlowDoc } from "../schema.js";

function loadViewerTemplate(): string {
  const candidates = [
    resolve(__dirname, "viewer/index.html"),
    resolve(__dirname, "../dist/viewer/index.html"),
    resolve(__dirname, "../viewer/index.html"),
  ];
  for (const c of candidates) {
    try {
      return readFileSync(c, "utf8");
    } catch {
      // try next
    }
  }
  throw new Error(
    "Could not locate viewer template. Did you run `npm run build:viewer`?"
  );
}

interface ScreenRunRow {
  run_id: string;
  screen_id: string;
  status: string;
  http_status: number | null;
  ms: number | null;
  screenshot: string | null;
  error: string | null;
  platform: string | null;
}

interface RunRow {
  id: string;
  started_at: string;
  base_url: string;
  role: string | null;
  platform: string | null;
  viewport: string | null;
  total: number;
  passed: number;
  failed: number;
  skipped: number;
}

interface BaselineRunRow {
  run_id: string;
  scenario_id: string;
  step_idx: number;
  state_num: number;
  platform: string;
  status: string;
  pixel_diff_pct: number | null;
  pixel_diff_count: number | null;
  ms: number | null;
  baseline_path: string | null;
  current_path: string | null;
  diff_path: string | null;
  ran_at: string;
}

function loadRunsFromDb(dbPath: string): unknown {
  const db = new Database(dbPath, { readonly: true });
  try {
    let runs: RunRow[] = [];
    let screenRuns: ScreenRunRow[] = [];
    let baselineRuns: BaselineRunRow[] = [];
    try { runs = db.prepare(`SELECT id, started_at, base_url, role, platform, viewport, total, passed, failed, skipped FROM runs ORDER BY started_at DESC`).all() as RunRow[]; } catch {}
    try { screenRuns = db.prepare(`SELECT run_id, screen_id, status, http_status, ms, screenshot, error, platform FROM screen_runs`).all() as ScreenRunRow[]; } catch {}
    try { baselineRuns = db.prepare(`SELECT run_id, scenario_id, step_idx, state_num, platform, status, pixel_diff_pct, pixel_diff_count, ms, baseline_path, current_path, diff_path, ran_at FROM baseline_runs ORDER BY ran_at DESC`).all() as BaselineRunRow[]; } catch {}

    // For each screen, for each platform, pick the LATEST run.
    const runById = new Map(runs.map((r) => [r.id, r]));
    type ScreenRun = { status: string; httpStatus?: number; ms?: number; runId?: string; startedAt?: string; error?: string };
    const byScreen: Record<string, Record<string, ScreenRun>> = {};
    const platformsSeen = new Set<string>();

    // Sort screenRuns by run started_at desc, then take first per (screen,platform).
    screenRuns.sort((a, b) => {
      const ta = runById.get(a.run_id)?.started_at ?? "";
      const tb = runById.get(b.run_id)?.started_at ?? "";
      return tb.localeCompare(ta);
    });

    for (const sr of screenRuns) {
      const platform = sr.platform || runById.get(sr.run_id)?.platform || "web-desktop";
      platformsSeen.add(platform);
      if (!byScreen[sr.screen_id]) byScreen[sr.screen_id] = {};
      if (byScreen[sr.screen_id][platform]) continue; // already have a newer one
      byScreen[sr.screen_id][platform] = {
        status: sr.status,
        httpStatus: sr.http_status ?? undefined,
        ms: sr.ms ?? undefined,
        runId: sr.run_id,
        startedAt: runById.get(sr.run_id)?.started_at,
        error: sr.error ?? undefined,
      };
    }

    // Aggregate baseline runs: for each (state_num, platform) take the LATEST drift-status.
    type BaselineByState = Record<number, Record<string, { status: string; driftPct?: number; scenarioId: string; stepIdx: number; ranAt: string; diffPath?: string; baselinePath?: string; currentPath?: string }>>;
    const baselineByState: BaselineByState = {};
    const baselinePlatformsSeen = new Set<string>();
    for (const b of baselineRuns) {
      baselinePlatformsSeen.add(b.platform);
      if (!baselineByState[b.state_num]) baselineByState[b.state_num] = {};
      const existing = baselineByState[b.state_num][b.platform];
      // baselineRuns already sorted ran_at DESC, so first hit per (state,platform) is newest
      if (existing) continue;
      baselineByState[b.state_num][b.platform] = {
        status: b.status,
        driftPct: b.pixel_diff_pct ?? undefined,
        scenarioId: b.scenario_id,
        stepIdx: b.step_idx,
        ranAt: b.ran_at,
        diffPath: b.diff_path ?? undefined,
        baselinePath: b.baseline_path ?? undefined,
        currentPath: b.current_path ?? undefined,
      };
    }

    return {
      platforms: Array.from(platformsSeen),
      byScreen,
      runs: runs.map((r) => ({
        id: r.id,
        startedAt: r.started_at,
        platform: r.platform || "web-desktop",
        viewport: r.viewport ?? undefined,
        baseUrl: r.base_url,
        total: r.total,
        passed: r.passed,
        failed: r.failed,
        skipped: r.skipped,
      })),
      baselinePlatforms: Array.from(baselinePlatformsSeen),
      baselineByState,
      baselineRunsCount: new Set(baselineRuns.map((b) => b.run_id)).size,
    };
  } finally {
    db.close();
  }
}

/**
 * Read test_cases from .flowdoc/flowdoc.db (if present) and aggregate into
 * the per-route summary shape embedded in flows.json at build time. Pure
 * read — no schema migration if the table doesn't exist yet, just returns [].
 */
function loadRouteStatusFromDb(dbPath: string): unknown[] {
  const db = new Database(dbPath, { readonly: true });
  try {
    // table may not exist — fail silently to []
    const hasTable = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='test_cases'`).get();
    if (!hasTable) return [];
    const rows = db.prepare(`
      SELECT route_id AS routeId, platform, status, notes, completed_at AS completedAt
      FROM test_cases
    `).all() as Array<{ routeId: string; platform: string; status: string | null; notes: string; completedAt: string | null }>;
    // Group by routeId
    const byRoute = new Map<string, Array<{ platform: string; status: "pass" | "fail" | "blocked" | null; notes?: string; completedAt?: string }>>();
    for (const r of rows) {
      const arr = byRoute.get(r.routeId) ?? [];
      arr.push({
        platform: r.platform,
        status: (r.status as "pass" | "fail" | "blocked" | null) ?? null,
        notes: r.notes || undefined,
        completedAt: r.completedAt ?? undefined,
      });
      byRoute.set(r.routeId, arr);
    }
    return [...byRoute.entries()].map(([routeId, perPlatform]) => ({
      routeId, perPlatform, summary: summarize(perPlatform),
    }));
  } finally {
    db.close();
  }
}

function summarize(perPlatform: Array<{ status: "pass" | "fail" | "blocked" | null }>): "pass" | "fail" | "blocked" | "partial" | "pending" {
  const has = (s: string) => perPlatform.some((p) => p.status === s);
  const all = (s: string | null) => perPlatform.every((p) => p.status === s);
  if (perPlatform.length === 0) return "pending";
  if (has("fail")) return "fail";
  if (has("blocked")) return "blocked";
  if (all("pass")) return "pass";
  if (all(null)) return "pending";
  return "partial";
}

export function renderHtml(flowsJsonPath: string, runsDbPath?: string, testDbPath?: string): string {
  const raw = readFileSync(resolve(process.cwd(), flowsJsonPath), "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`${flowsJsonPath} is not valid JSON: ${(err as Error).message}`);
  }
  const doc = validateFlowDoc(parsed);
  // Auto-detect .flowdoc/flowdoc.db next to flows.json. The same DB stores
  // both baseline_runs (visual-diff) and test_cases (handwritten-route runs).
  const flowsDir = dirname(resolve(process.cwd(), flowsJsonPath));
  const autoDb = join(flowsDir, ".flowdoc", "flowdoc.db");
  const dbForTests = testDbPath ? resolve(process.cwd(), testDbPath) : (existsSync(autoDb) ? autoDb : undefined);
  if (dbForTests) {
    const routeStatus = loadRouteStatusFromDb(dbForTests);
    if (routeStatus.length > 0) (doc as { routeStatus?: unknown[] }).routeStatus = routeStatus;
  }

  const template = loadViewerTemplate();
  const inlined = JSON.stringify(doc).replace(/</g, "\\u003c");

  let runsInlined = "null";
  if (runsDbPath) {
    const abs = resolve(process.cwd(), runsDbPath);
    if (!existsSync(abs)) throw new Error(`runs DB not found: ${runsDbPath}`);
    const runsData = loadRunsFromDb(abs);
    runsInlined = JSON.stringify(runsData).replace(/</g, "\\u003c");
  }

  return template
    .replace("__FLOWDOC_DATA__", () => inlined)
    .replace("__FLOWDOC_RUNS__", () => runsInlined);
}

export function buildCommand(flowsArg: string, opts: { out: string; withRuns?: string; withTestDb?: string }) {
  const flowsPath = flowsArg ?? "flows.json";
  const outPath = resolve(process.cwd(), opts.out);
  const html = renderHtml(flowsPath, opts.withRuns, opts.withTestDb);
  writeFileSync(outPath, html, "utf8");
  const sizeKB = (html.length / 1024).toFixed(1);
  console.log(`✓ ${opts.out} (${sizeKB} KB)`);
  if (opts.withRuns) console.log(`  embedded runs from ${opts.withRuns}`);
  console.log(`  Open it in any browser — no server required.`);
}
