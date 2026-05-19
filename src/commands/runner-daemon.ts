import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { runScenariosCommand } from "./run-scenarios.js";

interface ProjectConfig {
  flows: string;
  baseUrl: string;
  platforms?: string[];
  apiKey?: string;
  model?: string;
}

interface ProjectsConfig {
  [name: string]: ProjectConfig;
}

interface RunRequest {
  project: string;
  baseUrl?: string;        // override projects.json
  treeIds?: string[];
  platforms?: string[];
  llm?: boolean;
  maxRoutes?: number;
  dryRun?: boolean;
}

type JobStatus = "queued" | "running" | "passed" | "failed" | "error";

interface Job {
  id: string;
  project: string;
  status: JobStatus;
  queuedAt: string;
  startedAt?: string;
  finishedAt?: string;
  durationMs?: number;
  request: RunRequest;
  log: string[];
  resultPath?: string;
  passed?: number;
  failed?: number;
  total?: number;
  error?: string;
}

interface DaemonOpts {
  port: number;
  configPath: string;
  token?: string;
  dataDir: string;
}

const MAX_LOG_LINES = 1000;
const MAX_JOBS_HISTORY = 200;

const jobs: Job[] = [];                       // newest first
let runningJobId: string | null = null;
const queue: string[] = [];                   // jobIds awaiting execution

/**
 * Boot the runner HTTP daemon. Long-running process; never returns.
 *
 * Design notes:
 *   - Single-threaded queue (Playwright is heavy; running two at once on a
 *     small VM blows memory). Multiple POST /run during a run are queued
 *     in submission order.
 *   - Auth: optional Bearer token via FLOWDOC_RUNNER_TOKEN env var. If
 *     unset, daemon binds 127.0.0.1 only and trusts the caller.
 *   - State is in-memory; jobs older than MAX_JOBS_HISTORY are dropped.
 *     Per-run reports are kept on disk under dataDir/jobs/<jobId>.json
 *     so the canvas can fetch the full detail.
 */
export async function runnerDaemonCommand(opts: DaemonOpts): Promise<void> {
  if (!existsSync(opts.dataDir)) mkdirSync(opts.dataDir, { recursive: true });
  if (!existsSync(`${opts.dataDir}/jobs`)) mkdirSync(`${opts.dataDir}/jobs`, { recursive: true });

  let projects: ProjectsConfig = {};
  if (existsSync(opts.configPath)) {
    try { projects = JSON.parse(readFileSync(opts.configPath, "utf8")) as ProjectsConfig; }
    catch (e) { console.error(`⚠ failed to parse ${opts.configPath}: ${(e as Error).message}`); }
  } else {
    console.warn(`⚠ projects config not found at ${opts.configPath} — daemon will reject /run`);
  }

  const server = createServer((req, res) => handle(req, res, { projects, opts }).catch((err) => {
    sendJson(res, 500, { error: (err as Error).message });
  }));

  server.listen(opts.port, "127.0.0.1", () => {
    console.log(`✓ flowdoc-runner listening on http://127.0.0.1:${opts.port}`);
    console.log(`  config: ${opts.configPath} (${Object.keys(projects).length} projects)`);
    console.log(`  data:   ${opts.dataDir}`);
    if (opts.token) console.log("  auth:   bearer token required");
  });
}

async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: { projects: ProjectsConfig; opts: DaemonOpts },
): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");

  // CORS for the static canvas served from flowchart.smartlaunchhub.com
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") { res.statusCode = 204; res.end(); return; }

  // Auth — skip for liveness probe + read-only results endpoint. The latter
  // exists so the canvas (static HTML, no token) can poll for status counts
  // without exposing /run, /jobs, or per-job logs to the public.
  const isPublicRead =
    req.method === "GET" &&
    (url.pathname === "/health" || /^\/results\/[a-zA-Z0-9_-]+$/.test(url.pathname));
  if (ctx.opts.token && !isPublicRead) {
    const auth = req.headers["authorization"] ?? "";
    if (auth !== `Bearer ${ctx.opts.token}`) {
      sendJson(res, 401, { error: "unauthorized" });
      return;
    }
  }

  if (req.method === "GET" && url.pathname === "/health") {
    sendJson(res, 200, { ok: true, runningJobId, queued: queue.length, jobsHistory: jobs.length });
    return;
  }

  if (req.method === "GET" && url.pathname === "/jobs") {
    sendJson(res, 200, jobs.slice(0, 50).map(stripLogs));
    return;
  }

  const jobMatch = url.pathname.match(/^\/jobs\/([a-zA-Z0-9_-]+)$/);
  if (req.method === "GET" && jobMatch) {
    const j = jobs.find((x) => x.id === jobMatch[1]);
    if (!j) { sendJson(res, 404, { error: "not found" }); return; }
    sendJson(res, 200, j);
    return;
  }

  const resultsMatch = url.pathname.match(/^\/results\/([a-zA-Z0-9_-]+)$/);
  if (req.method === "GET" && resultsMatch) {
    const project = resultsMatch[1];
    const latest = jobs.find((j) => j.project === project && (j.status === "passed" || j.status === "failed"));
    if (!latest) { sendJson(res, 200, { project, lastRun: null }); return; }
    sendJson(res, 200, {
      project,
      lastRun: {
        jobId: latest.id,
        startedAt: latest.startedAt,
        finishedAt: latest.finishedAt,
        total: latest.total,
        passed: latest.passed,
        failed: latest.failed,
      },
    });
    return;
  }

  if (req.method === "POST" && url.pathname === "/run") {
    const body = await readBody(req);
    let parsed: RunRequest;
    try { parsed = JSON.parse(body) as RunRequest; }
    catch { sendJson(res, 400, { error: "invalid JSON body" }); return; }
    if (!parsed.project) { sendJson(res, 400, { error: "missing project" }); return; }
    const pc = ctx.projects[parsed.project];
    if (!pc) { sendJson(res, 404, { error: `unknown project '${parsed.project}'` }); return; }

    const job: Job = {
      id: shortId(),
      project: parsed.project,
      status: "queued",
      queuedAt: new Date().toISOString(),
      request: parsed,
      log: [`queued at ${new Date().toISOString()}`],
    };
    jobs.unshift(job);
    while (jobs.length > MAX_JOBS_HISTORY) jobs.pop();
    queue.push(job.id);

    // Kick the worker (async, fire-and-forget)
    void drainQueue(ctx);

    sendJson(res, 202, { jobId: job.id, status: job.status });
    return;
  }

  sendJson(res, 404, { error: "not found" });
}

async function drainQueue(ctx: { projects: ProjectsConfig; opts: DaemonOpts }): Promise<void> {
  if (runningJobId) return;
  const jobId = queue.shift();
  if (!jobId) return;
  const job = jobs.find((j) => j.id === jobId);
  if (!job) return;
  runningJobId = jobId;
  job.status = "running";
  job.startedAt = new Date().toISOString();
  appendLog(job, `started at ${job.startedAt}`);

  try {
    const pc = ctx.projects[job.project];
    const reportPath = `${ctx.opts.dataDir}/jobs/${job.id}.json`;
    appendLog(job, `runner-daemon → runScenariosCommand`);
    appendLog(job, `  flows:    ${pc.flows}`);
    appendLog(job, `  baseUrl:  ${job.request.baseUrl ?? pc.baseUrl}`);
    appendLog(job, `  llm:      ${job.request.llm ?? false}`);
    if (job.request.treeIds && job.request.treeIds.length > 0) appendLog(job, `  treeIds:  ${job.request.treeIds.join(", ")}`);

    if (job.request.dryRun) {
      appendLog(job, "dryRun=true — skipping actual Playwright run");
      job.status = "passed";
      job.passed = 0; job.failed = 0; job.total = 0;
    } else {
      const treeId = job.request.treeIds && job.request.treeIds.length === 1 ? job.request.treeIds[0] : undefined;
      await runScenariosCommand(pc.flows, {
        baseUrl: job.request.baseUrl ?? pc.baseUrl,
        out: reportPath,
        screenshots: `${ctx.opts.dataDir}/screens/${job.id}`,
        baselineDir: `${ctx.opts.dataDir}/baselines/${job.project}`,
        treeId,
        maxRoutes: job.request.maxRoutes,
        llm: job.request.llm ?? false,
        apiKey: pc.apiKey,
        model: pc.model ?? "claude-opus-4-7",
        headed: false,
        timeoutMs: 20000,
      });

      // Parse the report runScenariosCommand just wrote
      if (existsSync(reportPath)) {
        const report = JSON.parse(readFileSync(reportPath, "utf8")) as { total: number; passed: number; failed: number };
        job.total = report.total;
        job.passed = report.passed;
        job.failed = report.failed;
        job.resultPath = reportPath;
        job.status = report.failed > 0 ? "failed" : "passed";
        appendLog(job, `✓ ${report.total} routes — ${report.passed} pass, ${report.failed} fail`);
      } else {
        job.status = "error";
        job.error = "runScenariosCommand returned without writing report";
        appendLog(job, `✗ no report file`);
      }
    }
  } catch (err) {
    job.status = "error";
    job.error = (err as Error).message;
    appendLog(job, `✗ error: ${(err as Error).message}`);
  } finally {
    job.finishedAt = new Date().toISOString();
    job.durationMs = job.startedAt ? Date.parse(job.finishedAt) - Date.parse(job.startedAt) : undefined;
    runningJobId = null;
    void drainQueue(ctx);     // process next in queue
  }
}

function appendLog(job: Job, line: string): void {
  job.log.push(`${new Date().toISOString()} ${line}`);
  while (job.log.length > MAX_LOG_LINES) job.log.shift();
}

function stripLogs(j: Job): Omit<Job, "log"> {
  const { log: _log, ...rest } = j;
  return rest;
}

function shortId(): string {
  return randomUUID().split("-")[0];
}

async function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolveBody, rejectBody) => {
    let buf = "";
    req.on("data", (chunk) => { buf += chunk; });
    req.on("end", () => resolveBody(buf));
    req.on("error", rejectBody);
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(body));
}

/** Helper for the kick CLI command — single-shot HTTP POST to /run. */
export async function runnerKick(opts: {
  url: string;
  token?: string;
  project: string;
  treeId?: string;
  baseUrl?: string;
  platforms?: string[];
  llm?: boolean;
  dryRun?: boolean;
}): Promise<void> {
  const body = JSON.stringify({
    project: opts.project,
    treeIds: opts.treeId ? [opts.treeId] : undefined,
    baseUrl: opts.baseUrl,
    platforms: opts.platforms,
    llm: opts.llm,
    dryRun: opts.dryRun,
  });
  const res = await fetch(`${opts.url}/run`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
    },
    body,
  });
  const text = await res.text();
  if (!res.ok) {
    console.error(`✗ runner returned ${res.status}: ${text}`);
    process.exit(1);
  }
  const data = JSON.parse(text) as { jobId: string; status: string };
  console.log(`✓ queued job ${data.jobId} (status: ${data.status})`);
  console.log(`  GET ${opts.url}/jobs/${data.jobId} to inspect progress`);
}

export async function runnerStatus(opts: { url: string; token?: string }): Promise<void> {
  const headers: Record<string, string> = opts.token ? { authorization: `Bearer ${opts.token}` } : {};
  const health = await fetch(`${opts.url}/health`, { headers });
  if (!health.ok) {
    console.error(`✗ daemon unreachable (HTTP ${health.status})`);
    process.exit(1);
  }
  const h = (await health.json()) as { runningJobId: string | null; queued: number; jobsHistory: number };
  console.log(`✓ daemon online — running=${h.runningJobId ?? "(idle)"} queue=${h.queued} history=${h.jobsHistory}`);
  const jobsRes = await fetch(`${opts.url}/jobs`, { headers });
  const recent = (await jobsRes.json()) as Array<Job>;
  for (const j of recent.slice(0, 10)) {
    const status = j.status.padEnd(8);
    const pf = j.total !== undefined ? ` ${j.passed}/${j.total} pass, ${j.failed} fail` : "";
    console.log(`  ${j.id}  ${status}  ${j.project.padEnd(16)}${pf}  ${j.startedAt ?? j.queuedAt}`);
  }
}

export { type Job, type ProjectsConfig };

void resolve; void dirname;
