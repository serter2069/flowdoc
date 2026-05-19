import { Command } from "commander";
import { buildCommand } from "./commands/build.js";
import { initCommand } from "./commands/init.js";
import { serveCommand } from "./commands/serve.js";
import { scanCommand } from "./commands/scan.js";
import { scanLaravelCommand } from "./commands/scan-laravel.js";
import { scanRnCommand } from "./commands/scan-rn.js";
import { scanExpoCommand } from "./commands/scan-expo-router.js";
import { crawlCommand } from "./commands/crawl.js";
import { discoverCommand } from "./commands/discover.js";
import { generateCommand } from "./commands/generate.js";
import { baselineCommand } from "./commands/baseline.js";
import { enumerateCommand } from "./commands/enumerate.js";
import { rebuildCommand } from "./commands/rebuild.js";
import { exportCommand } from "./commands/export.js";
import { watchCommand } from "./commands/watch.js";

const program = new Command();

program
  .name("flowdoc")
  .description(
    "Document workflows between packages/components as a clickable, animated diagram driven by JSON."
  )
  .version("0.1.0");

program
  .command("init")
  .description("Create a starter flows.json in the current directory")
  .option("-o, --out <path>", "Output path", "flows.json")
  .option("--force", "Overwrite an existing file", false)
  .action(initCommand);

program
  .command("build")
  .description("Render a flows.json to a single self-contained HTML file")
  .argument("[flows]", "Path to flows.json", "flows.json")
  .option("-o, --out <path>", "Output HTML path", "flowdoc.html")
  .option("--with-runs <db>", "Embed run results from a flowdoc.db (SQLite) — adds the Coverage matrix tab")
  .option("--with-test-db <db>", "Embed handwritten-route test statuses from a flowdoc.db (defaults to <flows-dir>/.flowdoc/flowdoc.db)")
  .action((flowsArg: string, opts: any) => buildCommand(flowsArg, { out: opts.out, withRuns: opts.withRuns, withTestDb: opts.withTestDb }));

program
  .command("scan")
  .description("Scan a Next.js / Expo Router project and generate flows.json from routes")
  .argument("[dir]", "Project root (auto-detects app/ or src/app/)", ".")
  .option("-o, --out <path>", "Output path", "flows.json")
  .option("-f, --framework <fw>", "next | expo | auto", "auto")
  .option("--merge", "Merge into existing flows.json instead of overwriting", false)
  .action(scanCommand);

program
  .command("scan-laravel")
  .description("Scan a Laravel project: routes/web.php + Notifications + Jobs + Models → states/transitions/actions")
  .argument("[dir]", "Laravel project root (must have composer.json with laravel/framework)", ".")
  .option("-o, --out <path>", "Output path", "flows.json")
  .option("--merge", "Merge new states into existing flows.json (preserves positions of existing)", false)
  .action(scanLaravelCommand);

program
  .command("scan-rn")
  .description("Scan a React Native (or RN-Web) project: src/screens/*Screen.tsx → frontend states + navigation + API-call cross-links")
  .argument("[dir]", "RN project root (auto-detects src/screens)", ".")
  .option("-o, --out <path>", "Output path (when not merging)", "flows-rn.json")
  .option("--merge <path>", "Merge RN states into an existing backend flows.json (adds cross-stack API edges)")
  .action((dirArg: string | undefined, opts: any) => scanRnCommand(dirArg, { out: opts.out, merge: opts.merge }));

program
  .command("scan-expo")
  .description("Scan an Expo Router project (app/*.tsx file-based routes) → frontend states + navigation + optional backend API states")
  .argument("[dir]", "Expo project root (auto-detects app/ or src/app/)", ".")
  .option("-o, --out <path>", "Output path (when not merging)", "flows-expo.json")
  .option("--merge <path>", "Merge into an existing flows.json instead of overwriting")
  .option("--api-dir <path>", "Explicit backend routes dir (Express). Default: <root>/../api-server/src/routes")
  .action((dirArg: string | undefined, opts: any) => scanExpoCommand(dirArg, { out: opts.out, merge: opts.merge, apiDir: opts.apiDir }));

program
  .command("serve")
  .description(
    "Serve a flows.json with live reload — rebuild + browser refresh on changes"
  )
  .argument("[flows]", "Path to flows.json", "flows.json")
  .option("-p, --port <port>", "Port to listen on", "4173")
  .action(serveCommand);

program
  .command("crawl")
  .description("Walk flows.json with Playwright, record pass/fail+screenshot per screen into SQLite")
  .argument("[flows]", "Path to flows.json", "flows.json")
  .requiredOption("-u, --base-url <url>", "Base URL of the deployed app (e.g. https://admin.example.com)")
  .option("-o, --out <dir>", "Output dir (db + screenshots)", ".flowdoc")
  .option("-s, --screen <id>", "Crawl one screen only")
  .option("-r, --role <role>", "Filter to screens visible to this role")
  .option("--cookies <file>", "Playwright cookies JSON for auth")
  .option("--headed", "Run with a visible browser window", false)
  .option("--timeout <ms>", "Per-page timeout", (v) => parseInt(v, 10), 15000)
  .option("--params <list>", "Comma-separated route params, e.g. id=42,slug=foo")
  .option("-p, --platform <name>", "Platform: web-desktop | web-mobile | web-tablet | ios | android", "web-desktop")
  .option("--viewport <preset>", "Override viewport preset (defaults to platform's preset)")
  .action(crawlCommand);

program
  .command("discover")
  .description("Visit each screen, enumerate interactive elements + find untracked routes")
  .argument("[flows]", "Path to flows.json", "flows.json")
  .requiredOption("-u, --base-url <url>", "Base URL of the deployed app")
  .option("-o, --out <dir>", "Output dir", ".flowdoc")
  .option("--cookies <file>", "Playwright cookies JSON for auth")
  .option("--headed", "Run with a visible browser window", false)
  .option("--timeout <ms>", "Per-page timeout", (v) => parseInt(v, 10), 15000)
  .option("--apply", "Append newly discovered routes back into flows.json", false)
  .option("--params <list>", "Comma-separated route params, e.g. id=42,slug=foo")
  .action(discoverCommand);

program
  .command("generate")
  .description("Generate Playwright test specs from scenarios[] and state actions[] (role-matrix)")
  .argument("[flows]", "Path to flows.json", "flows.json")
  .requiredOption("-u, --base-url <url>", "Base URL of the deployed app")
  .option("-o, --out <dir>", "Output dir", "tests")
  .option("--roles <list>", "Comma-separated role projects to emit (defaults to flows.json roles)")
  .option("--no-actions", "Skip action-matrix tests, only emit scenario tests")
  .option("--no-scenarios", "Skip scenario tests, only emit action-matrix tests")
  .action((flowsArg: string | undefined, opts: any) => {
    generateCommand(flowsArg, {
      baseUrl: opts.baseUrl,
      out: opts.out,
      roles: opts.roles,
      includeActions: opts.actions !== false,
      includeScenarios: opts.scenarios !== false,
    });
  });

const baselineCmd = program.command("baseline").description("Visual baselines — Percy-style snapshot + diff per scenario step");
baselineCmd
  .command("accept [flows]")
  .description("Run scenarios and save screenshots as the new baseline (truth)")
  .requiredOption("-u, --base-url <url>", "Base URL of the deployed app")
  .option("-o, --out <dir>", "Output dir", ".flowdoc")
  .option("-s, --scenario <id>", "Only this scenario (default: all)")
  .option("--cookies <file>", "Playwright cookies JSON or storageState file")
  .option("-p, --platform <name>", "web-desktop | web-mobile | web-tablet", "web-desktop")
  .option("--timeout <ms>", "Per-page timeout", (v) => parseInt(v, 10), 15000)
  .option("--headed", "Visible browser window", false)
  .action((flowsArg: string, opts: any) => baselineCommand(flowsArg, "accept", {
    baseUrl: opts.baseUrl, out: opts.out, scenario: opts.scenario, cookies: opts.cookies,
    platform: opts.platform, threshold: 0.1, driftPct: 1.0, timeout: opts.timeout, headed: opts.headed,
  }));

baselineCmd
  .command("run [flows]")
  .description("Run scenarios + diff against baselines. New states get auto-baselined.")
  .requiredOption("-u, --base-url <url>", "Base URL of the deployed app")
  .option("-o, --out <dir>", "Output dir", ".flowdoc")
  .option("-s, --scenario <id>", "Only this scenario (default: all)")
  .option("--cookies <file>", "Playwright cookies JSON or storageState file")
  .option("-p, --platform <name>", "web-desktop | web-mobile | web-tablet", "web-desktop")
  .option("--threshold <n>", "Per-pixel match tolerance 0..1", (v) => parseFloat(v), 0.1)
  .option("--drift-pct <n>", "% pixels different to flag as drift", (v) => parseFloat(v), 1.0)
  .option("--timeout <ms>", "Per-page timeout", (v) => parseInt(v, 10), 15000)
  .option("--headed", "Visible browser window", false)
  .action((flowsArg: string, opts: any) => baselineCommand(flowsArg, "run", {
    baseUrl: opts.baseUrl, out: opts.out, scenario: opts.scenario, cookies: opts.cookies,
    platform: opts.platform, threshold: opts.threshold, driftPct: opts.driftPct, timeout: opts.timeout, headed: opts.headed,
  }));

baselineCmd
  .command("list [flows]")
  .description("Show baseline coverage (matched / drift / untested per scenario × platform)")
  .option("-o, --out <dir>", "Output dir", ".flowdoc")
  .action((flowsArg: string, opts: any) => baselineCommand(flowsArg, "list", {
    baseUrl: "", out: opts.out, platform: "web-desktop", threshold: 0.1, driftPct: 1.0, timeout: 15000, headed: false,
  }));

program
  .command("enumerate")
  .description("Enumerate all unique paths through the state graph and reconcile scenarios — drops invalid ones, preserves valid ones (with baselines), appends new")
  .argument("[flows]", "Path to flows.json", "flows.json")
  .option("-o, --out <path>", "Write generated scenarios to a separate JSON file (skips reconcile)")
  .option("--append", "Legacy: append-only without reconcile (does NOT drop invalid existing scenarios)", false)
  .option("--no-reconcile", "Skip reconcile (just enumerate to stdout/file)")
  .option("--max-len <n>", "Max steps per scenario", (v) => parseInt(v, 10), 14)
  .option("--max-scenarios <n>", "Hard cap to avoid combinatorial explosion", (v) => parseInt(v, 10), 500)
  .option("--baseline-dir <dir>", "Clean baseline screenshots + SQLite rows for dropped scenarios", ".flowdoc")
  .action((flowsArg: string | undefined, opts: any) => {
    // Default behavior: reconcile in-place. --append wins (legacy). --no-reconcile + --out for export.
    const reconcile = opts.append ? false : (opts.reconcile !== false && !opts.out);
    enumerateCommand(flowsArg, {
      out: opts.out,
      maxLen: opts.maxLen,
      maxScenarios: opts.maxScenarios,
      appendInPlace: opts.append,
      reconcile,
      baselineDir: opts.baselineDir,
    });
  });

program
  .command("rebuild")
  .description("One-shot: reconcile scenarios + build HTML viewer + optionally cp to publish targets")
  .argument("[flows]", "Path to flows.json", "flows.json")
  .option("-o, --out <path>", "Output HTML path", "sitemap.html")
  .option("--with-runs <db>", "SQLite DB (auto-detects <baseline-dir>/flowdoc.db if omitted)")
  .option("--baseline-dir <dir>", "Where baselines + SQLite live (for cleanup of dropped scenarios)", ".flowdoc")
  .option("--max-len <n>", "Max steps per auto-scenario", (v) => parseInt(v, 10), 14)
  .option("--max-scenarios <n>", "Hard cap on auto-scenarios", (v) => parseInt(v, 10), 500)
  .option("-p, --publish-to <path...>", "Copy the built HTML to these paths (can repeat: -p a.html -p b.html)")
  .option("--no-enumerate", "Skip reconcile, only build (use when graph hasn't changed)")
  .action((flowsArg: string | undefined, opts: any) => {
    rebuildCommand(flowsArg, {
      out: opts.out,
      withRuns: opts.withRuns,
      baselineDir: opts.baselineDir,
      maxLen: opts.maxLen,
      maxScenarios: opts.maxScenarios,
      publishTo: opts.publishTo,
      skipEnumerate: opts.enumerate === false,
    });
  });

program
  .command("export")
  .description("Export all scenarios with statuses — CSV for a tester, JSON for AI context")
  .argument("[flows]", "Path to flows.json", "flows.json")
  .option("-f, --format <fmt>", "csv | json", "csv")
  .option("-o, --out <path>", "Output path", "scenarios.csv")
  .option("--baseline-dir <dir>", "Where baselines + SQLite live (statuses come from here)", ".flowdoc")
  .action((flowsArg: string | undefined, opts: any) => {
    exportCommand(flowsArg ?? "flows.json", {
      format: opts.format === "json" ? "json" : "csv",
      out: opts.out,
      baselineDir: opts.baselineDir,
    });
  });

const test = program.command("test").description("Test-case tracking — persistent per-project SQLite. Lets agents pick pending cases and mark pass/fail/blocked.");

test
  .command("sync")
  .description("Expand scenarioTrees × platforms and upsert into the test_cases DB")
  .argument("[flows]", "Path to flows.json", "flows.json")
  .option("--db <path>", "SQLite DB path", ".flowdoc/flowdoc.db")
  .option("--project <name>", "Project name (auto-inferred from flows.json title if omitted)")
  .option("--platforms <list>", "Comma-separated platforms", "web-desktop,web-mobile,ios,android")
  .option("--tree <id>", "Only sync this scenario tree id")
  .option("--max-comb <n>", "Max branch-combination size", (v) => parseInt(v, 10), 3)
  .action(async (flowsArg: string | undefined, opts: any) => {
    const { testSync } = await import("./commands/test.js");
    testSync({
      flows: flowsArg ?? "flows.json",
      dbPath: opts.db, project: opts.project,
      platforms: String(opts.platforms).split(",").map((s: string) => s.trim()).filter(Boolean),
      treeId: opts.tree, maxCombinationSize: opts.maxComb,
    });
  });

test
  .command("list")
  .description("List test cases — filter by platform/status/kind/role")
  .option("--db <path>", "SQLite DB path", ".flowdoc/flowdoc.db")
  .option("--project <name>", "Project name", "default")
  .option("--platform <p>", "Filter by platform")
  .option("--status <s>", "Filter by status (pass | fail | blocked | pending)")
  .option("--kind <k>", "Filter by kind (happy | edge | security | regression)")
  .option("--role <r>", "Filter by role")
  .option("--limit <n>", "Max rows", (v) => parseInt(v, 10))
  .option("-f, --format <fmt>", "table | json", "table")
  .action(async (opts: any) => {
    const { testList } = await import("./commands/test.js");
    testList({ dbPath: opts.db, project: opts.project, platform: opts.platform, status: opts.status, kind: opts.kind, role: opts.role, limit: opts.limit, format: opts.format });
  });

test
  .command("next")
  .description("Get one pending test case as JSON — agent pipes this through its runner")
  .option("--db <path>", ".flowdoc/flowdoc.db", ".flowdoc/flowdoc.db")
  .option("--project <name>", "Project name", "default")
  .option("--platform <p>", "Filter by platform")
  .option("--kind <k>", "Filter by kind")
  .option("--role <r>", "Filter by role")
  .action(async (opts: any) => {
    const { testNext } = await import("./commands/test.js");
    testNext({ dbPath: opts.db, project: opts.project, platform: opts.platform, kind: opts.kind, role: opts.role });
  });

test
  .command("mark <id>")
  .description("Mark a test case pass | fail | blocked with optional notes")
  .requiredOption("--status <s>", "pass | fail | blocked")
  .option("--notes <text>", "Notes / failure reason / screenshot path", "")
  .option("--db <path>", "SQLite DB path", ".flowdoc/flowdoc.db")
  .option("--project <name>", "Project name (informational only)")
  .action(async (id: string, opts: any) => {
    const { testMark } = await import("./commands/test.js");
    testMark({ id, status: opts.status, notes: opts.notes, dbPath: opts.db, project: opts.project });
  });

test
  .command("reset")
  .description("Clear status/notes/completed_at so cases re-enter the pending queue")
  .option("--db <path>", "SQLite DB path", ".flowdoc/flowdoc.db")
  .option("--project <name>", "Project name", "default")
  .option("--platform <p>", "Only reset this platform")
  .action(async (opts: any) => {
    const { testReset } = await import("./commands/test.js");
    testReset({ dbPath: opts.db, project: opts.project, platform: opts.platform });
  });

test
  .command("failures")
  .description("Triage view — only fail (and optionally blocked) cases with notes and step preview")
  .option("--db <path>", "SQLite DB path", ".flowdoc/flowdoc.db")
  .option("--project <name>", "Project name", "default")
  .option("--platform <p>", "Filter by platform")
  .option("--include-blocked", "Include blocked cases too", false)
  .option("--since <iso>", "Only failures completed at or after this datetime")
  .option("-f, --format <fmt>", "table | json", "table")
  .action(async (opts: any) => {
    const { testFailures } = await import("./commands/test.js");
    testFailures({ dbPath: opts.db, project: opts.project, platform: opts.platform, includeBlocked: !!opts.includeBlocked, since: opts.since, format: opts.format });
  });

test
  .command("status")
  .description("Coverage matrix — per-platform × per-kind counts and % complete")
  .option("--db <path>", "SQLite DB path", ".flowdoc/flowdoc.db")
  .option("--project <name>", "Project name", "default")
  .option("-f, --format <fmt>", "table | json", "table")
  .action(async (opts: any) => {
    const { testStatus } = await import("./commands/test.js");
    testStatus({ dbPath: opts.db, project: opts.project, format: opts.format });
  });

program
  .command("run")
  .description("Run handwritten scenario routes through Playwright against a live deploy; report pass/fail per route")
  .argument("[flows]", "Path to flows.json", "flows.json")
  .requiredOption("-u, --base-url <url>", "Base URL of the deployed app (e.g. https://pluto.smartlaunchhub.com)")
  .option("-o, --out <path>", "Report JSON output path", "scenario-report.json")
  .option("-s, --screenshots <dir>", "Per-step screenshots dir", ".flowdoc/scenario-screens")
  .option("--baseline-dir <dir>", "Visual-diff baselines dir (one PNG per step-id)", ".flowdoc/baselines")
  .option("--tree <id>", "Only run routes from this scenario tree id")
  .option("--max-routes <n>", "Cap at N routes (safety)", (v) => parseInt(v, 10))
  .option("--llm", "Use Claude API to assert each step's expect (needs ANTHROPIC_API_KEY)", false)
  .option("--model <id>", "Claude model id", "claude-haiku-4-5-20251001")
  .option("--api-key <key>", "Override ANTHROPIC_API_KEY")
  .option("--headed", "Run with a visible browser (debug)", false)
  .option("--timeout <ms>", "Per-step timeout", (v) => parseInt(v, 10), 15000)
  .option("--update-visual", "Overwrite visual baselines instead of diffing — use after intentional UI change", false)
  .action(async (flowsArg: string | undefined, opts: any) => {
    const { runScenariosCommand } = await import("./commands/run-scenarios.js");
    await runScenariosCommand(flowsArg ?? "flows.json", {
      baseUrl: opts.baseUrl,
      out: opts.out,
      screenshots: opts.screenshots,
      baselineDir: opts.baselineDir,
      treeId: opts.tree,
      maxRoutes: opts.maxRoutes,
      llm: !!opts.llm,
      apiKey: opts.apiKey,
      model: opts.model,
      headed: !!opts.headed,
      timeoutMs: opts.timeout,
      updateVisual: !!opts.updateVisual,
    });
  });

const runner = program.command("runner").description("Self-hosted scenario runner — daemon on Hetzner that gets kicked by webhook / cron / canvas button");

runner
  .command("start")
  .description("Boot the runner HTTP daemon (long-running; bind to 127.0.0.1)")
  .option("-p, --port <port>", "Port to listen on", (v) => parseInt(v, 10), 7799)
  .option("-c, --config <path>", "Projects config path", "/etc/flowdoc/projects.json")
  .option("-d, --data <dir>", "Data dir for job reports + screenshots", "/var/lib/flowdoc")
  .option("--token <token>", "Override FLOWDOC_RUNNER_TOKEN")
  .action(async (opts: any) => {
    const { runnerDaemonCommand } = await import("./commands/runner-daemon.js");
    await runnerDaemonCommand({
      port: opts.port,
      configPath: opts.config,
      dataDir: opts.data,
      token: opts.token ?? process.env.FLOWDOC_RUNNER_TOKEN,
    });
  });

runner
  .command("kick <project>")
  .description("Send a /run request to the daemon — queues a new scenario run")
  .option("-u, --url <url>", "Daemon URL", "http://127.0.0.1:7799")
  .option("--token <token>", "Bearer token (defaults to FLOWDOC_RUNNER_TOKEN env)")
  .option("--tree <id>", "Limit to one scenario tree")
  .option("--base-url <url>", "Override the projects.json baseUrl for this run")
  .option("--llm", "Enable LLM screenshot assertions", false)
  .option("--dry-run", "Don't actually run Playwright; just exercise the queue", false)
  .action(async (project: string, opts: any) => {
    const { runnerKick } = await import("./commands/runner-daemon.js");
    await runnerKick({
      url: opts.url, token: opts.token ?? process.env.FLOWDOC_RUNNER_TOKEN,
      project, treeId: opts.tree, baseUrl: opts.baseUrl,
      llm: !!opts.llm, dryRun: !!opts.dryRun,
    });
  });

runner
  .command("status")
  .description("Show daemon health + last 10 jobs")
  .option("-u, --url <url>", "Daemon URL", "http://127.0.0.1:7799")
  .option("--token <token>", "Bearer token (defaults to FLOWDOC_RUNNER_TOKEN env)")
  .action(async (opts: any) => {
    const { runnerStatus } = await import("./commands/runner-daemon.js");
    await runnerStatus({ url: opts.url, token: opts.token ?? process.env.FLOWDOC_RUNNER_TOKEN });
  });

program
  .command("validate")
  .description("Lint scenarioTrees against the state graph — catch hallucinated steps that reference UI affordances that don't exist")
  .argument("[flows]", "Path to flows.json", "flows.json")
  .option("-f, --format <fmt>", "text | json", "text")
  .option("--fail-on-warning", "Exit with code 1 if any warnings are found", false)
  .option("--max-comb <n>", "Max branch-combination size when expanding trees", (v) => parseInt(v, 10), 3)
  .action(async (flowsArg: string | undefined, opts: any) => {
    const { validateCommand } = await import("./commands/validate.js");
    validateCommand(flowsArg ?? "flows.json", {
      format: opts.format === "json" ? "json" : "text",
      failOnWarning: !!opts.failOnWarning,
      maxCombinationSize: opts.maxComb,
    });
  });

program
  .command("gaps")
  .description("Coverage diff — what's covered by handwritten trees vs auto-scenarios, and what's missed by both")
  .argument("[flows]", "Path to flows.json", "flows.json")
  .option("-f, --format <fmt>", "text | json", "text")
  .option("-o, --out <path>", "Write report to file (default: stdout)")
  .action(async (flowsArg: string | undefined, opts: any) => {
    const { gapsCommand } = await import("./commands/gaps.js");
    gapsCommand(flowsArg ?? "flows.json", {
      format: opts.format === "json" ? "json" : "text",
      out: opts.out,
    });
  });

program
  .command("scenarios")
  .description("Expand handwritten scenario trees into runnable routes; export as table")
  .argument("[flows]", "Path to flows.json", "flows.json")
  .option("-f, --format <fmt>", "csv | json", "csv")
  .option("-o, --out <path>", "Output path", "scenarios-routes.csv")
  .option("--max-comb <n>", "Max combination size for branches (default 3)", (v) => parseInt(v, 10), 3)
  .option("--tree <id>", "Only expand the scenario tree with this id")
  .option("--platforms <list>", "Comma-separated platforms to fan out per route (e.g. web-desktop,web-mobile,ios,android)")
  .option("--all-platforms", "Shortcut for --platforms web-desktop,web-mobile,ios,android")
  .action(async (flowsArg: string | undefined, opts: any) => {
    const { scenariosCommand, DEFAULT_PLATFORMS } = await import("./commands/scenarios.js");
    const platforms = opts.allPlatforms
      ? DEFAULT_PLATFORMS
      : (opts.platforms ? String(opts.platforms).split(",").map((s) => s.trim()).filter(Boolean) : []);
    scenariosCommand(flowsArg ?? "flows.json", {
      format: opts.format === "json" ? "json" : "csv",
      out: opts.out,
      maxCombinationSize: opts.maxComb,
      treeId: opts.tree,
      platforms,
    });
  });

program
  .command("watch")
  .description("Watch flows.json (and optional source dirs) — auto rebuild + republish on every change")
  .argument("[flows]", "Path to flows.json", "flows.json")
  .option("-o, --out <path>", "Output HTML path", "sitemap.html")
  .option("--with-runs <db>", "SQLite DB (auto-detects)")
  .option("--baseline-dir <dir>", "Baseline + SQLite dir", ".flowdoc")
  .option("--max-len <n>", "Max steps per auto-scenario", (v) => parseInt(v, 10), 14)
  .option("--max-scenarios <n>", "Hard cap on auto-scenarios", (v) => parseInt(v, 10), 500)
  .option("-p, --publish-to <path...>", "Copy built HTML to these paths on every rebuild")
  .option("-s, --watch-source <dir...>", "Also watch these source dirs (recursive, .ts/.tsx/.js/.jsx/.php)")
  .option("--debounce <ms>", "Debounce ms after a change", (v) => parseInt(v, 10), 500)
  .action((flowsArg: string | undefined, opts: any) => {
    watchCommand(flowsArg, {
      out: opts.out, withRuns: opts.withRuns, baselineDir: opts.baselineDir,
      maxLen: opts.maxLen, maxScenarios: opts.maxScenarios,
      publishTo: opts.publishTo, watchSource: opts.watchSource,
      debounceMs: opts.debounce,
    });
  });

program.parseAsync(process.argv).catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
