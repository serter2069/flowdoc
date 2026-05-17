import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import Database from "better-sqlite3";
import { chromium, type BrowserContext, type Page } from "playwright";
import { validateFlowDoc, type FlowDoc, type Screen } from "../schema.js";

type Platform = "web-desktop" | "web-mobile" | "web-tablet" | "ios" | "android";

interface CrawlOpts {
  baseUrl: string;
  out: string;
  screen?: string;
  role?: string;
  cookies?: string;
  headed: boolean;
  timeout: number;
  params?: string;
  platform: Platform;
  viewport?: string;
}

const VIEWPORTS: Record<string, { width: number; height: number; deviceScaleFactor?: number; isMobile?: boolean; userAgent?: string }> = {
  "web-desktop": { width: 1280, height: 800 },
  "web-mobile": { width: 390, height: 844, deviceScaleFactor: 3, isMobile: true, userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1" },
  "web-tablet": { width: 820, height: 1180, deviceScaleFactor: 2 },
};

interface RunCtx {
  db: Database.Database;
  runId: string;
  outDir: string;
}

function nowId(): string {
  return new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
}

function openDb(dbPath: string): Database.Database {
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS runs (
      id TEXT PRIMARY KEY,
      started_at TEXT NOT NULL,
      base_url TEXT NOT NULL,
      role TEXT,
      platform TEXT,
      viewport TEXT,
      total INTEGER, passed INTEGER, failed INTEGER, skipped INTEGER
    );
    CREATE TABLE IF NOT EXISTS screen_runs (
      run_id TEXT NOT NULL,
      screen_id TEXT NOT NULL,
      url TEXT NOT NULL,
      status TEXT NOT NULL,
      http_status INTEGER,
      ms INTEGER,
      screenshot TEXT,
      error TEXT,
      PRIMARY KEY (run_id, screen_id)
    );
    CREATE TABLE IF NOT EXISTS discovered (
      run_id TEXT NOT NULL,
      screen_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      selector TEXT,
      label TEXT,
      href TEXT
    );
  `);
  // Lightweight migration: add platform/viewport columns to existing dbs.
  const cols = db.prepare(`PRAGMA table_info(runs)`).all() as { name: string }[];
  const names = new Set(cols.map((c) => c.name));
  if (!names.has("platform")) db.exec(`ALTER TABLE runs ADD COLUMN platform TEXT`);
  if (!names.has("viewport")) db.exec(`ALTER TABLE runs ADD COLUMN viewport TEXT`);
  const srCols = db.prepare(`PRAGMA table_info(screen_runs)`).all() as { name: string }[];
  if (!new Set(srCols.map((c) => c.name)).has("platform")) db.exec(`ALTER TABLE screen_runs ADD COLUMN platform TEXT`);
  return db;
}

function loadFlows(path: string): FlowDoc {
  const raw = readFileSync(resolve(process.cwd(), path), "utf8");
  return validateFlowDoc(JSON.parse(raw));
}

function parseParams(s?: string): Record<string, string> {
  if (!s) return {};
  const out: Record<string, string> = {};
  for (const pair of s.split(",")) {
    const [k, v] = pair.split("=");
    if (k && v) out[k.trim()] = v.trim();
  }
  return out;
}

function resolvePath(p: string, params: Record<string, string>): string | null {
  const parts = p.split("/").map((seg) => {
    if (seg.startsWith(":")) {
      const key = seg.slice(1).replace(/\*$/, "");
      return params[key] ?? null;
    }
    return seg;
  });
  if (parts.some((x) => x === null)) return null;
  return parts.join("/");
}

function eligibleScreens(doc: FlowDoc, opts: CrawlOpts): Screen[] {
  let scs = (doc.screens ?? []).filter((s) => s.path && !s.path.includes("(") && s.kind !== "external");
  if (opts.role) scs = scs.filter((s) => !s.roles || s.roles.includes(opts.role!));
  if (opts.screen) scs = scs.filter((s) => s.id === opts.screen);
  return scs;
}

async function applyAuth(ctx: BrowserContext, file: string) {
  const parsed = JSON.parse(readFileSync(file, "utf8"));
  if (Array.isArray(parsed)) {
    await ctx.addCookies(parsed);
  } else if (parsed && typeof parsed === "object" && Array.isArray(parsed.cookies)) {
    if (parsed.cookies.length) await ctx.addCookies(parsed.cookies);
  }
}

function isStorageStateFile(file: string): boolean {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) && Array.isArray(parsed.cookies);
  } catch {
    return false;
  }
}

async function crawlScreen(page: Page, screen: Screen, baseUrl: string, params: Record<string, string>, timeout: number, ctx: RunCtx): Promise<{ status: "pass" | "fail" | "skip"; httpStatus?: number; ms?: number; error?: string; screenshot?: string }> {
  const resolved = resolvePath(screen.path!, params);
  if (!resolved) {
    return { status: "skip", error: `unresolved params in ${screen.path}` };
  }
  const url = baseUrl.replace(/\/$/, "") + resolved;
  const t0 = Date.now();
  try {
    const resp = await page.goto(url, { waitUntil: "domcontentloaded", timeout });
    const httpStatus = resp?.status();
    await page.waitForLoadState("networkidle", { timeout: Math.min(timeout, 5000) }).catch(() => {});
    const ms = Date.now() - t0;
    const shot = join(ctx.outDir, `${screen.id}.png`);
    await page.screenshot({ path: shot, fullPage: false }).catch(() => {});
    const bodyText = (await page.evaluate(() => document.body?.innerText ?? "").catch(() => "")).slice(0, 5000);
    const looksLike404 = /404|not found|page not found/i.test(bodyText.slice(0, 200));
    if (!httpStatus || httpStatus >= 500 || (httpStatus === 404)) {
      return { status: "fail", httpStatus, ms, screenshot: shot, error: `HTTP ${httpStatus}` };
    }
    if (looksLike404) {
      return { status: "fail", httpStatus, ms, screenshot: shot, error: "404 text in body" };
    }
    return { status: "pass", httpStatus, ms, screenshot: shot };
  } catch (err) {
    return { status: "fail", ms: Date.now() - t0, error: (err as Error).message };
  }
}

export async function crawlCommand(flowsArg: string, opts: CrawlOpts) {
  const flowsPath = flowsArg ?? "flows.json";
  const doc = loadFlows(flowsPath);
  const outDir = resolve(process.cwd(), opts.out);
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
  const dbPath = join(outDir, "flowdoc.db");
  const db = openDb(dbPath);
  const runId = nowId();
  const runDir = join(outDir, "runs", runId);
  mkdirSync(runDir, { recursive: true });
  const ctx: RunCtx = { db, runId, outDir: runDir };
  const params = parseParams(opts.params);
  const screens = eligibleScreens(doc, opts);
  if (!screens.length) {
    console.error("No eligible screens (need .path, not a route group, and matching --role/--screen).");
    process.exit(1);
  }
  const platform = opts.platform || "web-desktop";
  if (platform === "ios" || platform === "android") {
    console.error(`Platform '${platform}' requires Maestro integration (not yet implemented). Use 'web-desktop' or 'web-mobile' for now.`);
    process.exit(2);
  }
  const vp = VIEWPORTS[opts.viewport || platform] || VIEWPORTS["web-desktop"];
  console.log(`▶ run ${runId} [${platform} ${vp.width}x${vp.height}]: ${screens.length} screens against ${opts.baseUrl}`);
  const browser = await chromium.launch({ headless: !opts.headed });
  const useStorage = opts.cookies && isStorageStateFile(opts.cookies);
  const ctxOpts: Parameters<typeof browser.newContext>[0] = {
    viewport: { width: vp.width, height: vp.height },
    deviceScaleFactor: vp.deviceScaleFactor,
    isMobile: vp.isMobile,
    userAgent: vp.userAgent,
  };
  if (useStorage) ctxOpts.storageState = opts.cookies;
  const browserCtx = await browser.newContext(ctxOpts);
  if (opts.cookies && !useStorage) await applyAuth(browserCtx, opts.cookies);
  const page = await browserCtx.newPage();
  const insertScreen = db.prepare(`INSERT OR REPLACE INTO screen_runs(run_id,screen_id,url,status,http_status,ms,screenshot,error,platform) VALUES (?,?,?,?,?,?,?,?,?)`);
  let passed = 0, failed = 0, skipped = 0;
  for (const s of screens) {
    const r = await crawlScreen(page, s, opts.baseUrl, params, opts.timeout, ctx);
    const url = opts.baseUrl.replace(/\/$/, "") + (resolvePath(s.path!, params) ?? s.path!);
    insertScreen.run(runId, s.id, url, r.status, r.httpStatus ?? null, r.ms ?? null, r.screenshot ?? null, r.error ?? null, platform);
    const mark = r.status === "pass" ? "✓" : r.status === "fail" ? "✗" : "·";
    const tail = r.error ? `  ${r.error}` : r.httpStatus ? `  ${r.httpStatus} ${r.ms}ms` : "";
    console.log(`  ${mark} ${s.id.padEnd(28)} ${s.path}${tail}`);
    if (r.status === "pass") passed++;
    else if (r.status === "fail") failed++;
    else skipped++;
  }
  db.prepare(`INSERT INTO runs(id,started_at,base_url,role,platform,viewport,total,passed,failed,skipped) VALUES (?,?,?,?,?,?,?,?,?,?)`)
    .run(runId, new Date().toISOString(), opts.baseUrl, opts.role ?? null, platform, `${vp.width}x${vp.height}`, screens.length, passed, failed, skipped);
  await browser.close();
  db.close();
  console.log(`\n▶ done: ${passed} pass · ${failed} fail · ${skipped} skip`);
  console.log(`  run dir: ${runDir}`);
  console.log(`  db: ${dbPath}`);
  if (failed) process.exit(2);
}
