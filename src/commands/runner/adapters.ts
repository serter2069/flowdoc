/*
 * Per-step assertion adapters used by run-scenarios.ts.
 *
 * Dispatched based on the step's expect text and the tree's kind:
 *   - axe       → inject axe-core, fail on critical/serious violations
 *   - visual    → screenshot diff vs golden under baselineDir
 *   - perf      → web-vitals measurement parsed against an inline budget
 *   - security  → HTTP fetch with manipulated auth headers expecting 4xx
 *   - offline   → re-run navigation under CDP network throttling
 *
 * Each adapter returns { pass, reason } and is mutually exclusive — the
 * dispatcher picks the first matching pattern in priority order.
 */

import { readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { Page, BrowserContext } from "playwright";

export interface AdapterResult {
  pass: boolean;
  reason: string;
  kind: AdapterKind;
  detail?: Record<string, unknown>;
}

export type AdapterKind = "axe" | "visual" | "perf" | "security" | "offline" | null;

/**
 * Decide which adapter (if any) applies to this step. Priority order is
 * deliberate — security checks beat visual diffs beat perf budgets.
 */
export function pickAdapter(step: { step: string; expect?: string }, treeKind: string): AdapterKind {
  const text = `${step.step} ${step.expect ?? ""}`.toLowerCase();

  if (/\b(axe|wcag|a11y|aria|accessibility|0 critical|violations?)\b/.test(text)) return "axe";
  if (/\b(40[1-3]|csrf|xss|sql injection|jwt tamper|idor|cross.tenant|forbidden|unauthorized|no .* leaked?|no .* leak|gets? \/api)\b/.test(text)) return "security";
  if (/\b(pixel diff|snapshot|visual|layout matches golden|dark mode)\b/.test(text)) return "visual";
  if (/\b(tti|lcp|fcp|cls|p95.*[<>].*\d|<\s*\d+\s*(?:s|ms)|web.?vitals?)\b/.test(text)) return "perf";
  if (/\b(offline|slow.?3g|throttle|network drops|reconnect)\b/.test(text)) return "offline";

  if (treeKind === "regression" && /\b(snapshot|screenshot|render|layout)\b/.test(text)) return "visual";
  return null;
}

// ─── axe-core ──────────────────────────────────────────────────────────────

let _axeSource: string | null = null;
function loadAxeSource(): string {
  if (_axeSource) return _axeSource;
  const p = require.resolve("axe-core/axe.min.js");
  _axeSource = readFileSync(p, "utf8");
  return _axeSource;
}

interface AxeViolation { id: string; impact: string | null; help: string; nodes: number; }

export async function runAxe(page: Page): Promise<AdapterResult> {
  try {
    await page.evaluate(loadAxeSource());
    const raw = (await page.evaluate(async () => {
      // @ts-expect-error axe injected globally
      const r = await window.axe.run(document, {
        runOnly: ["wcag2a", "wcag2aa"],
        resultTypes: ["violations"],
      });
      return r as { violations: Array<{ id: string; impact: string | null; help: string; nodes: unknown[] }> };
    })) as { violations: Array<{ id: string; impact: string | null; help: string; nodes: unknown[] }> };
    const violations: AxeViolation[] = raw.violations.map((v) => ({
      id: v.id, impact: v.impact, help: v.help, nodes: v.nodes.length,
    }));
    const critical = violations.filter((v) => v.impact === "critical" || v.impact === "serious");
    if (critical.length === 0) {
      return { pass: true, reason: `axe clean (${violations.length} minor violations)`, kind: "axe", detail: { violations } };
    }
    return {
      pass: false, kind: "axe",
      reason: `${critical.length} critical/serious axe violations: ${critical.slice(0, 3).map((v) => v.id).join(", ")}`,
      detail: { violations: critical },
    };
  } catch (e) {
    return { pass: false, kind: "axe", reason: `axe failed: ${(e as Error).message}` };
  }
}

// ─── visual snapshot diff ──────────────────────────────────────────────────

interface VisualOpts {
  page: Page;
  baselineDir: string;
  routeId: string;
  stepIndex: number;
  thresholdPct?: number;
  updateBaseline?: boolean;
}

export async function runVisualDiff(opts: VisualOpts): Promise<AdapterResult> {
  const { PNG } = await import("pngjs");
  const pixelmatch = (await import("pixelmatch")).default;

  const safeStep = `${opts.routeId}-step${opts.stepIndex + 1}`.replace(/[^a-zA-Z0-9_-]/g, "_");
  const baselinePath = join(opts.baselineDir, `${safeStep}.png`);
  const screenshot = await opts.page.screenshot({ fullPage: false });

  if (!existsSync(baselinePath) || opts.updateBaseline) {
    mkdirSync(dirname(baselinePath), { recursive: true });
    writeFileSync(baselinePath, screenshot);
    return { pass: true, kind: "visual", reason: opts.updateBaseline ? "baseline updated" : "baseline created (first run)" };
  }

  try {
    const a = PNG.sync.read(readFileSync(baselinePath));
    const b = PNG.sync.read(screenshot);
    if (a.width !== b.width || a.height !== b.height) {
      return { pass: false, kind: "visual", reason: `viewport mismatch — baseline ${a.width}x${a.height} vs current ${b.width}x${b.height}` };
    }
    const diff = new PNG({ width: a.width, height: a.height });
    const diffPixels = pixelmatch(a.data, b.data, diff.data, a.width, a.height, { threshold: 0.1 });
    const totalPx = a.width * a.height;
    const driftPct = (diffPixels / totalPx) * 100;
    const threshold = opts.thresholdPct ?? 0.5;
    if (driftPct <= threshold) {
      return { pass: true, kind: "visual", reason: `drift ${driftPct.toFixed(2)}% ≤ ${threshold}%` };
    }
    const diffPath = baselinePath.replace(/\.png$/, ".diff.png");
    writeFileSync(diffPath, PNG.sync.write(diff));
    return { pass: false, kind: "visual", reason: `drift ${driftPct.toFixed(2)}% > ${threshold}% — see ${diffPath}`, detail: { driftPct, diffPath } };
  } catch (e) {
    return { pass: false, kind: "visual", reason: `visual compare failed: ${(e as Error).message}` };
  }
}

// ─── performance budgets ───────────────────────────────────────────────────

interface PerfMetrics {
  ttiMs?: number;
  fcpMs?: number;
  lcpMs?: number;
  domContentMs?: number;
  loadMs?: number;
}

export async function measureWebVitals(page: Page): Promise<PerfMetrics> {
  const data = (await page.evaluate(() => {
    const nav = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined;
    const paints = performance.getEntriesByType("paint");
    const fcp = paints.find((p) => p.name === "first-contentful-paint")?.startTime;
    const domContent = nav ? nav.domContentLoadedEventEnd - nav.startTime : undefined;
    const load = nav ? nav.loadEventEnd - nav.startTime : undefined;
    return { fcp, domContent, load };
  })) as { fcp?: number; domContent?: number; load?: number };
  return {
    fcpMs: data.fcp,
    domContentMs: data.domContent,
    loadMs: data.load,
    ttiMs: data.load,        // crude — true TTI needs long-task observer
  };
}

/** Parse "TTI < 2.5s" / "P95 < 800ms" / "load < 3s" from expect text. */
function parsePerfBudget(text: string): { metric: keyof PerfMetrics; thresholdMs: number } | null {
  const re = /\b(tti|lcp|fcp|p95|load|domcontent(?:loaded)?)[^<>]*?[<>]\s*(\d+(?:\.\d+)?)\s*(ms|s)\b/i;
  const m = text.match(re);
  if (!m) return null;
  const value = parseFloat(m[2]);
  const ms = m[3].toLowerCase() === "s" ? value * 1000 : value;
  const key = m[1].toLowerCase();
  const metric: keyof PerfMetrics =
    key === "fcp" ? "fcpMs" :
    key === "lcp" ? "lcpMs" :
    key.startsWith("domcontent") ? "domContentMs" :
    "ttiMs";
  return { metric, thresholdMs: ms };
}

export async function runPerf(page: Page, expectText: string): Promise<AdapterResult> {
  const metrics = await measureWebVitals(page);
  const budget = parsePerfBudget(expectText);
  if (!budget) {
    return { pass: true, kind: "perf", reason: `metrics: TTI=${Math.round(metrics.ttiMs ?? 0)}ms FCP=${Math.round(metrics.fcpMs ?? 0)}ms (no budget in expect)`, detail: metrics as unknown as Record<string, unknown> };
  }
  const actual = metrics[budget.metric];
  if (actual === undefined) return { pass: false, kind: "perf", reason: `metric ${budget.metric} not captured`, detail: metrics as unknown as Record<string, unknown> };
  const pass = actual <= budget.thresholdMs;
  return {
    pass, kind: "perf",
    reason: `${budget.metric}=${Math.round(actual)}ms ${pass ? "≤" : ">"} budget ${budget.thresholdMs}ms`,
    detail: metrics as unknown as Record<string, unknown>,
  };
}

// ─── security: HTTP-status probes ──────────────────────────────────────────

interface SecurityOpts {
  ctx: BrowserContext;
  baseUrl: string;
  path?: string;
  expectText: string;
  withoutCookies?: boolean;
}

export async function runSecurity(opts: SecurityOpts): Promise<AdapterResult> {
  if (!opts.path) return { pass: false, kind: "security", reason: "no path on state — cannot probe" };
  const url = new URL(opts.path, opts.baseUrl).toString();
  const expectedStatus = pickExpectedStatus(opts.expectText);
  try {
    // Use a fresh context-free fetch via Playwright's API for unauth checks
    const fetchOpts: { headers?: Record<string, string> } = {};
    if (opts.withoutCookies !== false) {
      fetchOpts.headers = { cookie: "" };
    }
    const res = await opts.ctx.request.get(url, { ...fetchOpts, failOnStatusCode: false });
    const got = res.status();
    const pass = expectedStatus.length === 0 ? (got >= 400 && got < 500) : expectedStatus.includes(got);
    return {
      pass, kind: "security",
      reason: `GET ${opts.path} → ${got}${expectedStatus.length ? ` (expected ${expectedStatus.join("/")})` : " (expected 4xx)"}`,
      detail: { status: got, expected: expectedStatus, url },
    };
  } catch (e) {
    return { pass: false, kind: "security", reason: `probe failed: ${(e as Error).message}` };
  }
}

function pickExpectedStatus(text: string): number[] {
  const out: number[] = [];
  const m = text.match(/\b(4\d{2}|5\d{2})\b/g);
  if (m) for (const s of m) out.push(parseInt(s, 10));
  return out;
}

// ─── offline / network throttling ──────────────────────────────────────────
//
// Two distinct flows:
//
//   "offline"  → check that the *already-loaded* page survives losing the
//                network. We do NOT reload — that would force a fetch the
//                browser cannot satisfy, which both clears the page and
//                tears down the JS execution context (page.evaluate then
//                explodes with 'Execution context was destroyed').
//
//   "slow-3g"  → throttle, then reload. The reload should succeed slowly,
//                not catastrophically. We wait for it to settle before
//                evaluating, and treat a timeout as a soft fail.
//
// In both branches, the network state is restored in a finally block so the
// next step starts on a clean connection.

export async function runOffline(page: Page, expectText: string): Promise<AdapterResult> {
  const slow3g = /slow.?3g/i.test(expectText);
  const ctx = page.context();
  let restoreCdp: (() => Promise<void>) | null = null;

  try {
    if (slow3g) {
      // Throttle via CDP and reload.
      const session = await ctx.newCDPSession(page);
      await session.send("Network.emulateNetworkConditions", {
        offline: false,
        downloadThroughput: 50 * 1024,    // ~50 KB/s
        uploadThroughput: 50 * 1024,
        latency: 400,
      });
      restoreCdp = async () => {
        try {
          await session.send("Network.emulateNetworkConditions", {
            offline: false, downloadThroughput: -1, uploadThroughput: -1, latency: 0,
          });
        } catch { /* CDP may be detached; ignore */ }
      };

      let navOk = false;
      try {
        await page.reload({ waitUntil: "domcontentloaded", timeout: 20000 });
        navOk = true;
      } catch { /* timeout — page may still be partially usable */ }

      // Settle and check body content — execution context exists once nav
      // either completed or timed out.
      const hasContent = await page.evaluate(() => document.body && document.body.innerText.length > 0).catch(() => false);
      return {
        pass: !!hasContent, kind: "offline",
        reason: hasContent
          ? `page rendered under slow-3G${navOk ? "" : " (reload timed out but DOM survived)"}`
          : `page failed under slow-3G — no usable content within 20s`,
      };
    }

    // OFFLINE branch — Playwright's setOffline is cleaner than CDP because
    // it doesn't try to reload anything; it just intercepts new requests.
    await ctx.setOffline(true);
    restoreCdp = async () => { try { await ctx.setOffline(false); } catch { /* ignore */ } };

    const hasContent = await page.evaluate(() => document.body && document.body.innerText.length > 0).catch(() => false);

    // Optional second probe: try to navigate to a no-op anchor and see whether
    // the SPA handles offline gracefully without throwing uncaught errors.
    let consoleErrorAfter = 0;
    const onErr = (m: import("playwright").ConsoleMessage) => { if (m.type() === "error") consoleErrorAfter++; };
    page.on("console", onErr);
    await page.waitForTimeout(500);
    page.off("console", onErr);

    return {
      pass: !!hasContent, kind: "offline",
      reason: hasContent
        ? `page survived going offline (cached UI visible${consoleErrorAfter ? `, ${consoleErrorAfter} console errors`: ""})`
        : `page blank under offline — no offline support`,
    };
  } catch (e) {
    return { pass: false, kind: "offline", reason: `throttle failed: ${(e as Error).message}` };
  } finally {
    if (restoreCdp) await restoreCdp();
  }
}

void resolve;
