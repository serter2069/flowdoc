import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import Database from "better-sqlite3";
import pixelmatch from "pixelmatch";
import { PNG } from "pngjs";
import { chromium, type BrowserContext } from "playwright";
import { validateFlowDoc, type FlowDoc, type Scenario } from "../schema.js";

type Platform = "web-desktop" | "web-mobile" | "web-tablet";
type BaselineMode = "run" | "accept" | "list";

interface BaselineOpts {
  baseUrl: string;
  out: string;
  cookies?: string;
  scenario?: string;
  platform: Platform;
  threshold: number;       // 0..1 pixel match tolerance per pixel (default .1)
  driftPct: number;        // % of pixels different to mark as drift (default 1.0)
  timeout: number;
  headed: boolean;
}

const VIEWPORTS: Record<Platform, { width: number; height: number; userAgent?: string; isMobile?: boolean; deviceScaleFactor?: number }> = {
  "web-desktop": { width: 1280, height: 800 },
  "web-mobile": { width: 390, height: 844, deviceScaleFactor: 3, isMobile: true, userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1" },
  "web-tablet": { width: 820, height: 1180, deviceScaleFactor: 2 },
};

function openDb(dbPath: string): Database.Database {
  if (!existsSync(dirname(dbPath))) mkdirSync(dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS baseline_runs (
      run_id TEXT NOT NULL,
      scenario_id TEXT NOT NULL,
      step_idx INTEGER NOT NULL,
      state_num INTEGER NOT NULL,
      platform TEXT NOT NULL,
      status TEXT NOT NULL,           -- match | drift | new | error | skipped
      pixel_diff_pct REAL,
      pixel_diff_count INTEGER,
      total_pixels INTEGER,
      ms INTEGER,
      baseline_path TEXT,
      current_path TEXT,
      diff_path TEXT,
      ran_at TEXT NOT NULL,
      PRIMARY KEY (run_id, scenario_id, step_idx, platform)
    );
  `);
  return db;
}

function loadFlows(p: string): FlowDoc {
  const raw = readFileSync(resolve(process.cwd(), p), "utf8");
  return validateFlowDoc(JSON.parse(raw));
}

function nowId(): string {
  return new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
}

async function applyAuthFromFile(ctx: BrowserContext, file: string) {
  const parsed = JSON.parse(readFileSync(file, "utf8"));
  if (Array.isArray(parsed)) {
    if (parsed.length) await ctx.addCookies(parsed);
  } else if (parsed && Array.isArray(parsed.cookies)) {
    if (parsed.cookies.length) await ctx.addCookies(parsed.cookies);
  }
}

function isStorageStateFile(file: string): boolean {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) && Array.isArray(parsed.cookies);
  } catch { return false; }
}

interface DiffResult {
  status: "match" | "drift" | "new" | "error" | "skipped";
  pixelDiffCount: number;
  pixelDiffPct: number;
  totalPixels: number;
  diffPath?: string;
  error?: string;
}

function diffImages(baselinePath: string, currentPath: string, diffPath: string, threshold: number): DiffResult {
  try {
    const baseline = PNG.sync.read(readFileSync(baselinePath));
    const current = PNG.sync.read(readFileSync(currentPath));
    if (baseline.width !== current.width || baseline.height !== current.height) {
      // Pad to common size with white
      return {
        status: "drift",
        pixelDiffCount: Math.abs(baseline.width * baseline.height - current.width * current.height),
        pixelDiffPct: 100,
        totalPixels: baseline.width * baseline.height,
        error: `size mismatch: baseline ${baseline.width}x${baseline.height} vs current ${current.width}x${current.height}`,
      };
    }
    const { width, height } = baseline;
    const diff = new PNG({ width, height });
    const diffCount = pixelmatch(baseline.data, current.data, diff.data, width, height, { threshold });
    const total = width * height;
    const pct = (diffCount / total) * 100;
    if (diffCount > 0) {
      writeFileSync(diffPath, PNG.sync.write(diff));
    }
    return {
      status: diffCount === 0 ? "match" : "drift",
      pixelDiffCount: diffCount,
      pixelDiffPct: pct,
      totalPixels: total,
      diffPath: diffCount > 0 ? diffPath : undefined,
    };
  } catch (err) {
    return {
      status: "error",
      pixelDiffCount: 0,
      pixelDiffPct: 0,
      totalPixels: 0,
      error: (err as Error).message,
    };
  }
}

async function runScenario(scenario: Scenario, doc: FlowDoc, mode: BaselineMode, opts: BaselineOpts, db: Database.Database, runId: string) {
  const stateByNum = new Map((doc.states ?? []).map((s) => [s.num, s]));
  const baselineDir = join(resolve(process.cwd(), opts.out), "baseline", scenario.id);
  const currentDir = join(resolve(process.cwd(), opts.out), "baseline", "runs", runId, scenario.id);
  if (!existsSync(baselineDir)) mkdirSync(baselineDir, { recursive: true });
  if (!existsSync(currentDir)) mkdirSync(currentDir, { recursive: true });

  const vp = VIEWPORTS[opts.platform];
  const browser = await chromium.launch({ headless: !opts.headed });
  const useStorage = opts.cookies && isStorageStateFile(opts.cookies);
  const browserCtx = await browser.newContext({
    viewport: { width: vp.width, height: vp.height },
    deviceScaleFactor: vp.deviceScaleFactor,
    isMobile: vp.isMobile,
    userAgent: vp.userAgent,
    ...(useStorage ? { storageState: opts.cookies } : {}),
  });
  if (opts.cookies && !useStorage) await applyAuthFromFile(browserCtx, opts.cookies);
  const page = await browserCtx.newPage();

  const insert = db.prepare(`INSERT OR REPLACE INTO baseline_runs(run_id,scenario_id,step_idx,state_num,platform,status,pixel_diff_pct,pixel_diff_count,total_pixels,ms,baseline_path,current_path,diff_path,ran_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const ran_at = new Date().toISOString();

  console.log(`▶ scenario ${scenario.id} [${opts.platform} ${vp.width}x${vp.height}] mode=${mode}`);

  for (let i = 0; i < scenario.path.length; i++) {
    const stateNum = scenario.path[i];
    const state = stateByNum.get(stateNum);
    if (!state) continue;
    const stepLabel = `step ${(i + 1).toString().padStart(2, " ")} · #${stateNum} ${state.title.slice(0, 40)}`;

    // Only screenshot states that have a navigable path. Others get skipped.
    const reachable = state.path && !state.path.includes("{") && !state.path.includes(":");
    if (!reachable) {
      console.log(`  · ${stepLabel} — skipped (no direct path)`);
      insert.run(runId, scenario.id, i + 1, stateNum, opts.platform, "skipped", null, null, null, null, null, null, null, ran_at);
      continue;
    }

    const url = opts.baseUrl.replace(/\/$/, "") + state.path;
    const baselinePath = join(baselineDir, `${i + 1}__${opts.platform}.png`);
    const currentPath = join(currentDir, `${i + 1}__${opts.platform}.png`);
    const diffPath = join(currentDir, `${i + 1}__${opts.platform}__diff.png`);

    const t0 = Date.now();
    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: opts.timeout });
      await page.waitForLoadState("networkidle", { timeout: Math.min(opts.timeout, 5000) }).catch(() => {});
      await page.screenshot({ path: currentPath, fullPage: false });
    } catch (err) {
      const ms = Date.now() - t0;
      console.log(`  ✗ ${stepLabel} — ${(err as Error).message.split("\n")[0].slice(0, 60)}`);
      insert.run(runId, scenario.id, i + 1, stateNum, opts.platform, "error", null, null, null, ms, null, null, null, ran_at);
      continue;
    }
    const ms = Date.now() - t0;

    if (mode === "accept") {
      writeFileSync(baselinePath, readFileSync(currentPath));
      console.log(`  ✓ ${stepLabel} — accepted as baseline`);
      insert.run(runId, scenario.id, i + 1, stateNum, opts.platform, "match", 0, 0, vp.width * vp.height, ms, baselinePath, currentPath, null, ran_at);
      continue;
    }

    // run mode: if no baseline yet, save as baseline
    if (!existsSync(baselinePath)) {
      writeFileSync(baselinePath, readFileSync(currentPath));
      console.log(`  ✓ ${stepLabel} — NEW baseline saved (${ms}ms)`);
      insert.run(runId, scenario.id, i + 1, stateNum, opts.platform, "new", 0, 0, vp.width * vp.height, ms, baselinePath, currentPath, null, ran_at);
      continue;
    }

    // diff against baseline
    const result = diffImages(baselinePath, currentPath, diffPath, opts.threshold);
    const status = result.status === "drift" && result.pixelDiffPct < opts.driftPct ? "match" : result.status;
    const mark = status === "match" ? "✓" : status === "drift" ? "△" : "✗";
    const tail = status === "drift" ? `  ${result.pixelDiffPct.toFixed(2)}% drift (${result.pixelDiffCount} px)` : status === "error" ? `  ${result.error}` : ` ${ms}ms`;
    console.log(`  ${mark} ${stepLabel}${tail}`);
    insert.run(runId, scenario.id, i + 1, stateNum, opts.platform, status, result.pixelDiffPct, result.pixelDiffCount, result.totalPixels, ms, baselinePath, currentPath, result.diffPath ?? null, ran_at);
  }

  await browser.close();
}

export async function baselineCommand(flowsArg: string | undefined, mode: BaselineMode, opts: BaselineOpts) {
  const flowsPath = flowsArg ?? "flows.json";
  const doc = loadFlows(flowsPath);
  const outDir = resolve(process.cwd(), opts.out);
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
  const dbPath = join(outDir, "flowdoc.db");
  const db = openDb(dbPath);

  const scenarios = (doc.scenarios ?? []).filter((s) => !opts.scenario || s.id === opts.scenario);
  if (!scenarios.length) {
    console.error(opts.scenario ? `Scenario "${opts.scenario}" not found.` : "No scenarios[] in flows.json.");
    process.exit(1);
  }

  if (mode === "list") {
    const rows = db.prepare(`
      SELECT scenario_id, platform, COUNT(*) as steps,
             SUM(CASE WHEN status='match' THEN 1 ELSE 0 END) as matched,
             SUM(CASE WHEN status='drift' THEN 1 ELSE 0 END) as drift,
             SUM(CASE WHEN status='new' THEN 1 ELSE 0 END) as new_,
             SUM(CASE WHEN status='error' THEN 1 ELSE 0 END) as err,
             SUM(CASE WHEN status='skipped' THEN 1 ELSE 0 END) as skipped,
             MAX(ran_at) as last_run
      FROM baseline_runs
      GROUP BY scenario_id, platform
      ORDER BY scenario_id, platform
    `).all() as Array<{ scenario_id: string; platform: string; steps: number; matched: number; drift: number; new_: number; err: number; skipped: number; last_run: string }>;
    if (!rows.length) {
      console.log("No baseline runs yet. Try: flowdoc baseline run --base-url <url>");
      db.close();
      return;
    }
    console.log(`scenario          platform        steps  ✓match  △drift  ★new  ✗err  ·skip  last_run`);
    for (const r of rows) {
      console.log(`${r.scenario_id.padEnd(18)}${r.platform.padEnd(16)}${String(r.steps).padStart(5)}${String(r.matched).padStart(8)}${String(r.drift).padStart(8)}${String(r.new_).padStart(6)}${String(r.err).padStart(6)}${String(r.skipped).padStart(7)}  ${r.last_run.slice(0, 19)}`);
    }
    db.close();
    return;
  }

  const runId = (mode === "accept" ? "accept-" : "") + nowId();
  for (const scenario of scenarios) {
    await runScenario(scenario, doc, mode, opts, db, runId);
  }
  db.close();

  console.log("");
  if (mode === "accept") {
    console.log(`✓ baselines updated for ${scenarios.length} scenario(s) on ${opts.platform}`);
    console.log(`  baseline dir: ${join(outDir, "baseline")}`);
  } else {
    console.log(`✓ run ${runId} complete — ${scenarios.length} scenario(s) on ${opts.platform}`);
    console.log(`  diffs: ${join(outDir, "baseline", "runs", runId)}`);
    console.log(`  query: sqlite3 ${dbPath} "SELECT scenario_id,step_idx,status,pixel_diff_pct FROM baseline_runs WHERE run_id='${runId}'"`);
  }
}
