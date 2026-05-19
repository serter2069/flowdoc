import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, join, dirname } from "node:path";
import { validateFlowDoc, type State } from "../schema.js";
import { expandScenarioTree, resolveRouteRefs, type ScenarioRoute } from "./scenario-tree.js";
import { pickAdapter, runAxe, runVisualDiff, runPerf, runSecurity, runOffline, type AdapterResult } from "./runner/adapters.js";

interface RunOpts {
  baseUrl: string;                        // e.g. https://pluto.smartlaunchhub.com
  out: string;                            // report path (JSON)
  screenshots?: string;                   // dir for per-step PNGs (default .flowdoc/scenario-screens)
  baselineDir?: string;                   // dir for visual-diff goldens (default .flowdoc/baselines)
  treeId?: string;                        // limit to one tree
  maxRoutes?: number;                     // safety cap
  llm: boolean;                           // run LLM-based assertions
  apiKey?: string;                        // Anthropic API key (else from env)
  model: string;                          // claude model id
  headed: boolean;                        // run with visible browser (debug)
  timeoutMs: number;                      // per-step timeout
  updateVisual?: boolean;                 // overwrite visual baselines instead of comparing
}

interface StepResult {
  step: string;
  stateRef?: number;
  url?: string;
  loaded: boolean;
  consoleErrors: string[];
  pageErrors: string[];
  screenshotPath?: string;
  llmVerdict?: { pass: boolean; reason: string };
  adapter?: AdapterResult;
  status: "pass" | "fail" | "skip";
}
interface RouteResult {
  routeId: string;
  treeId: string;
  title: string;
  kind: string;
  role?: string;
  status: "pass" | "fail";
  failedAt?: number;             // step index that failed
  steps: StepResult[];
}
interface RunReport {
  baseUrl: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  llm: boolean;
  total: number;
  passed: number;
  failed: number;
  routes: RouteResult[];
}

/**
 * Execute every handwritten route in flows.json against a live deployment.
 * Each step navigates to its stateRef's path under baseUrl, captures a
 * screenshot + console errors, optionally asks Claude whether the screenshot
 * matches the step's `expect` text. Outputs a JSON report.
 *
 * Deliberately light: this is a "smoke runner", not a full E2E framework.
 * It catches "page is broken / 500 / route 404 / console explodes" — which
 * is what 80% of breakage looks like. For full assertions, hand the report
 * + scenario CSV to a downstream agent.
 */
export async function runScenariosCommand(flowsArg: string, opts: RunOpts): Promise<void> {
  const { chromium }: typeof import("playwright") = await import("playwright");
  const flowsPath = resolve(process.cwd(), flowsArg);
  const doc = validateFlowDoc(JSON.parse(readFileSync(flowsPath, "utf8")), { strictScenarios: false });
  const trees = doc.scenarioTrees ?? [];
  if (trees.length === 0) {
    console.error("No scenarioTrees[] in flows.json. Write handwritten trees first.");
    process.exit(1);
  }
  const states = doc.states ?? [];
  const byNum = new Map(states.map((s) => [s.num, s]));

  const targetTrees = opts.treeId ? trees.filter((t) => t.id === opts.treeId) : trees;
  let routes: ScenarioRoute[] = [];
  for (const t of targetTrees) routes = routes.concat(expandScenarioTree(t, { maxCombinationSize: 3 }));
  const { ok } = resolveRouteRefs(routes, states);
  routes = ok;
  if (opts.maxRoutes && routes.length > opts.maxRoutes) {
    console.log(`Capping at ${opts.maxRoutes} routes (of ${routes.length})`);
    routes = routes.slice(0, opts.maxRoutes);
  }

  const screensDir = opts.screenshots
    ? resolve(process.cwd(), opts.screenshots)
    : resolve(process.cwd(), ".flowdoc/scenario-screens");
  mkdirSync(screensDir, { recursive: true });

  const apiKey = opts.apiKey ?? process.env.ANTHROPIC_API_KEY;
  if (opts.llm && !apiKey) {
    console.warn("⚠ --llm requested but ANTHROPIC_API_KEY not set; falling back to rule-based asserts");
    opts.llm = false;
  }

  const startedAt = new Date().toISOString();
  const t0 = Date.now();

  const browser = await chromium.launch({ headless: !opts.headed });
  const ctx = await browser.newContext();
  const routesOut: RouteResult[] = [];
  let passCount = 0;

  for (const route of routes) {
    process.stdout.write(`▶ ${route.routeId} ${route.title.slice(0, 60)} `);
    const page = await ctx.newPage();
    const steps: StepResult[] = [];
    let routeFailed = false;
    let failedAt: number | undefined;

    for (let i = 0; i < route.steps.length; i++) {
      const step = route.steps[i];
      const state: State | undefined = step.stateRef !== undefined ? byNum.get(step.stateRef) : undefined;
      const url = state?.path ? new URL(state.path, opts.baseUrl).toString() : undefined;
      const consoleErrors: string[] = [];
      const pageErrors: string[] = [];
      const onPageErr = (e: Error) => pageErrors.push(e.message);
      const onConsoleErr = (m: import("playwright").ConsoleMessage) => { if (m.type() === "error") consoleErrors.push(m.text()); };
      page.on("pageerror", onPageErr);
      page.on("console", onConsoleErr);

      let loaded = false;
      try {
        if (url) {
          await page.goto(url, { waitUntil: "domcontentloaded", timeout: opts.timeoutMs });
          loaded = true;
        }
      } catch (e) {
        loaded = false;
      }

      const safeId = `${route.routeId}-step${i + 1}`.replace(/[^a-zA-Z0-9_-]/g, "_");
      const shotPath = join(screensDir, `${safeId}.png`);
      try { await page.screenshot({ path: shotPath, fullPage: false }); } catch {}

      let llmVerdict: StepResult["llmVerdict"] | undefined;
      if (opts.llm && step.expect && apiKey) {
        try {
          llmVerdict = await llmAssert(apiKey, opts.model, step.expect, shotPath);
        } catch (e) {
          llmVerdict = { pass: false, reason: `LLM call failed: ${(e as Error).message}` };
        }
      }

      // Specialized adapter dispatch (axe / visual / perf / security / offline).
      // Picked from step text + tree kind; absent adapter means we fall back to
      // the basic Playwright load + console-error checks.
      let adapter: AdapterResult | undefined;
      const adapterKind = pickAdapter(step, route.kind);
      // Security adapter doesn't need page load — it probes via request API.
      const adapterCanRunWithoutLoad = adapterKind === "security";
      if (adapterKind && (loaded || adapterCanRunWithoutLoad)) {
        try {
          if (adapterKind === "axe") {
            adapter = await runAxe(page);
          } else if (adapterKind === "visual") {
            adapter = await runVisualDiff({
              page, baselineDir: opts.baselineDir ?? resolve(process.cwd(), ".flowdoc/baselines"),
              routeId: route.routeId, stepIndex: i,
              updateBaseline: opts.updateVisual,
            });
          } else if (adapterKind === "perf") {
            adapter = await runPerf(page, step.expect ?? "");
          } else if (adapterKind === "security") {
            adapter = await runSecurity({
              ctx, baseUrl: opts.baseUrl,
              path: state?.path, expectText: `${step.step} ${step.expect ?? ""}`,
            });
          } else if (adapterKind === "offline") {
            adapter = await runOffline(page, `${step.step} ${step.expect ?? ""}`);
          }
        } catch (e) {
          adapter = { pass: false, kind: adapterKind, reason: `adapter ${adapterKind} threw: ${(e as Error).message}` };
        }
      }

      page.off("pageerror", onPageErr);
      page.off("console", onConsoleErr);

      const failedHere =
        (url && !loaded) ||
        pageErrors.length > 0 ||
        consoleErrors.length > 0 ||
        (llmVerdict && !llmVerdict.pass) ||
        (adapter && !adapter.pass);
      const status: StepResult["status"] = !url ? "skip" : (failedHere ? "fail" : "pass");

      steps.push({
        step: step.step,
        stateRef: step.stateRef,
        url,
        loaded,
        consoleErrors: consoleErrors.slice(0, 5),
        pageErrors: pageErrors.slice(0, 5),
        screenshotPath: shotPath,
        llmVerdict,
        adapter,
        status,
      });
      if (status === "fail" && !routeFailed) { routeFailed = true; failedAt = i; break; }
    }

    await page.close();
    const routeResult: RouteResult = {
      routeId: route.routeId,
      treeId: route.treeId,
      title: route.title,
      kind: route.kind,
      role: route.role,
      status: routeFailed ? "fail" : "pass",
      failedAt,
      steps,
    };
    routesOut.push(routeResult);
    if (routeResult.status === "pass") passCount++;
    console.log(routeFailed ? `✗ failed at step ${(failedAt ?? 0) + 1}` : "✓");
  }

  await browser.close();

  const finishedAt = new Date().toISOString();
  const report: RunReport = {
    baseUrl: opts.baseUrl, startedAt, finishedAt,
    durationMs: Date.now() - t0,
    llm: opts.llm,
    total: routesOut.length,
    passed: passCount,
    failed: routesOut.length - passCount,
    routes: routesOut,
  };
  const outPath = resolve(process.cwd(), opts.out);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(report, null, 2) + "\n", "utf8");
  console.log("");
  console.log(`✓ ran ${report.total} routes — ${report.passed} pass, ${report.failed} fail`);
  console.log(`  screenshots: ${screensDir}`);
  console.log(`  report:      ${opts.out}`);
}

/**
 * Ask Claude whether the screenshot reflects the step's `expect` text. We
 * pass the image as base64 + the expectation as plain text. Model returns a
 * strict JSON verdict that we parse. Failures of the call itself bubble up
 * to the caller — runScenariosCommand marks the step failed with the reason.
 */
async function llmAssert(apiKey: string, model: string, expect: string, screenshotPath: string): Promise<{ pass: boolean; reason: string }> {
  const png = readFileSync(screenshotPath);
  const b64 = png.toString("base64");
  const body = {
    model,
    max_tokens: 200,
    messages: [
      {
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: "image/png", data: b64 } },
          {
            type: "text",
            text:
              `You are a QA verifier. The screenshot is the rendered page after a test step.\n` +
              `Expected: ${expect}\n` +
              `Respond ONLY with a single JSON object on one line: {"pass": true|false, "reason": "..."}` +
              `\nMark pass=true if the page state is consistent with the expectation. ` +
              `Mark pass=false on obvious failures (error pages, missing key UI, blank screens, wrong route).`,
          },
        ],
      },
    ],
  };
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = (await res.json()) as { content?: Array<{ type: string; text?: string }> };
  const text = data.content?.find((b) => b.type === "text")?.text ?? "";
  const m = text.match(/\{[\s\S]*?\}/);
  if (!m) return { pass: false, reason: `LLM didn't return JSON: "${text.slice(0, 100)}"` };
  try {
    const v = JSON.parse(m[0]) as { pass?: boolean; reason?: string };
    return { pass: !!v.pass, reason: v.reason ?? "" };
  } catch {
    return { pass: false, reason: `Bad JSON: ${m[0].slice(0, 100)}` };
  }
}
