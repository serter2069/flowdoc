import { useMemo, useState, useEffect, useCallback } from "react";
import type { FlowDoc } from "../../schema";
import { expandScenarioTree, type ScenarioRoute } from "../../commands/scenario-tree";

interface Props { doc: FlowDoc; }

// Runner integration — same-origin under /_runner/, set in nginx.
const RUNNER_BASE = "/_runner";
const RUNNER_TOKEN_KEY = "flowdoc-runner-token";
const POLL_MS = 15000;

interface RunnerResults {
  project: string;
  lastRun: null | {
    jobId: string;
    startedAt?: string;
    finishedAt?: string;
    total?: number;
    passed?: number;
    failed?: number;
  };
}

interface JobInfo {
  id: string;
  project: string;
  status: "queued" | "running" | "passed" | "failed" | "error";
  total?: number;
  passed?: number;
  failed?: number;
  startedAt?: string;
  finishedAt?: string;
  log?: string[];
  error?: string;
}

interface AdapterResult {
  pass: boolean;
  kind: "axe" | "visual" | "perf" | "security" | "offline" | null;
  reason: string;
  detail?: Record<string, unknown>;
}

interface RouteStepResult {
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
  failedAt?: number;
  steps: RouteStepResult[];
}

interface FullReport {
  baseUrl: string;
  startedAt: string;
  finishedAt: string;
  total: number;
  passed: number;
  failed: number;
  routes: RouteResult[];
}

type CellStatus = "pass" | "fail" | "blocked" | "pending";
const PLATFORMS = ["web-desktop", "web-mobile", "ios", "android"] as const;
type Platform = (typeof PLATFORMS)[number];
const PLATFORM_SHORT: Record<Platform, string> = {
  "web-desktop": "Web", "web-mobile": "Mobile web", ios: "iOS", android: "Android",
};

const ROLE_ORDER = ["anon", "client", "worker", "dispatcher", "manager", "admin"];
const ROLE_COLOR: Record<string, string> = {
  anon: "#64748b", client: "#0ea5e9", worker: "#16a34a",
  dispatcher: "#f59e0b", manager: "#2563eb", admin: "#9333ea",
};

function glyph(s: CellStatus): string {
  return s === "pass" ? "✓" : s === "fail" ? "✗" : s === "blocked" ? "⊘" : "·";
}

interface Step {
  n: number;
  step: string;
  expect?: string;
  stateTitle?: string;
}

interface Row {
  routeId: string;
  treeId: string;
  role: string;
  title: string;
  steps: Step[];
  byPlatform: Record<Platform, { status: CellStatus; notes: string }>;
  passCount: number;
}

export function TestsPage({ doc }: Props) {
  const trees = doc.scenarioTrees ?? [];
  const stateTitleByNum = useMemo(() => {
    const m = new Map<number, string>();
    for (const s of doc.states ?? []) m.set(s.num, s.title ?? s.id);
    return m;
  }, [doc.states]);

  const rows: Row[] = useMemo(() => {
    const statusByRouteId = new Map((doc.routeStatus ?? []).map((rs) => [rs.routeId, rs]));
    const out: Row[] = [];
    for (const t of trees) {
      let routes: ScenarioRoute[] = [];
      try { routes = expandScenarioTree(t, { maxCombinationSize: 3 }); } catch { continue; }
      for (const r of routes) {
        const status = statusByRouteId.get(r.routeId);
        const byPlatform = {} as Row["byPlatform"];
        let passCount = 0;
        for (const p of PLATFORMS) {
          const entry = status?.perPlatform.find((x) => x.platform === p);
          const s: CellStatus = (entry?.status as CellStatus | null | undefined) ?? "pending";
          byPlatform[p] = { status: s, notes: entry?.notes ?? "" };
          if (s === "pass") passCount++;
        }
        out.push({
          routeId: r.routeId,
          treeId: r.treeId,
          role: r.role ?? t.role ?? "any",
          title: r.title,
          steps: r.steps.map((s, i) => ({
            n: i + 1,
            step: s.step,
            expect: s.expect,
            stateTitle: s.stateRef !== undefined ? stateTitleByNum.get(s.stateRef) : undefined,
          })),
          byPlatform,
          passCount,
        });
      }
    }
    return out;
  }, [trees, doc.routeStatus, stateTitleByNum]);

  const [roleFilter, setRoleFilter] = useState<string>("all");
  const [search, setSearch] = useState("");
  const [expandedId, setExpandedId] = useState<string | null>(null);

  // Runner state — null until first /results poll succeeds
  const [runnerResults, setRunnerResults] = useState<RunnerResults["lastRun"]>(null);
  const [runnerOnline, setRunnerOnline] = useState<boolean | null>(null);
  const [activeJob, setActiveJob] = useState<JobInfo | null>(null);
  const [viewingJobId, setViewingJobId] = useState<string | null>(null);
  const [viewingReport, setViewingReport] = useState<FullReport | null>(null);
  const [viewingError, setViewingError] = useState<string | null>(null);
  const [expandedRouteIds, setExpandedRouteIds] = useState<Set<string>>(new Set());
  const projectKey = (doc.title ?? "project").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").split("-")[0] || "project";

  // Poll /results — gives us last run + per-platform counts
  useEffect(() => {
    let cancelled = false;
    async function poll() {
      try {
        const res = await fetch(`${RUNNER_BASE}/results/${projectKey}`, { cache: "no-store" });
        if (!res.ok) throw new Error(String(res.status));
        const data = (await res.json()) as RunnerResults;
        if (!cancelled) { setRunnerOnline(true); setRunnerResults(data.lastRun); }
      } catch {
        if (!cancelled) setRunnerOnline(false);
      }
    }
    poll();
    const t = setInterval(poll, POLL_MS);
    return () => { cancelled = true; clearInterval(t); };
  }, [projectKey]);

  // Poll active job every 2s while a run is in progress
  useEffect(() => {
    if (!activeJob || activeJob.status === "passed" || activeJob.status === "failed" || activeJob.status === "error") return;
    let cancelled = false;
    const token = typeof localStorage !== "undefined" ? localStorage.getItem(RUNNER_TOKEN_KEY) : null;
    async function tick() {
      try {
        const res = await fetch(`${RUNNER_BASE}/jobs/${activeJob!.id}`, {
          cache: "no-store",
          headers: token ? { Authorization: `Bearer ${token}` } : {},
        });
        if (res.ok) {
          const data = (await res.json()) as JobInfo;
          if (!cancelled) setActiveJob(data);
        }
      } catch { /* ignore — next tick retries */ }
    }
    const t = setInterval(tick, 2000);
    return () => { cancelled = true; clearInterval(t); };
  }, [activeJob]);

  const kickRun = useCallback(async (treeIds?: string[]) => {
    let token = typeof localStorage !== "undefined" ? localStorage.getItem(RUNNER_TOKEN_KEY) : null;
    if (!token) {
      const entered = typeof prompt !== "undefined" ? prompt("Runner bearer token (cached locally; from /etc/flowdoc/runner.env):") : null;
      if (!entered) return;
      token = entered;
      try { localStorage.setItem(RUNNER_TOKEN_KEY, token); } catch { /* private mode */ }
    }
    try {
      const res = await fetch(`${RUNNER_BASE}/run`, {
        method: "POST",
        headers: { "content-type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ project: projectKey, treeIds }),
      });
      if (res.status === 401) {
        try { localStorage.removeItem(RUNNER_TOKEN_KEY); } catch { /* ignore */ }
        alert("Token rejected. Clear cached and try again.");
        return;
      }
      if (!res.ok) { alert(`Run failed: HTTP ${res.status}`); return; }
      const data = (await res.json()) as { jobId: string; status: string };
      setActiveJob({ id: data.jobId, project: projectKey, status: data.status as JobInfo["status"] });
    } catch (e) {
      alert(`Run failed: ${(e as Error).message}`);
    }
  }, [projectKey]);

  const filteredRows = useMemo(() => {
    const q = search.trim().toLowerCase();
    return rows.filter((r) => {
      if (roleFilter !== "all" && r.role !== roleFilter) return false;
      if (q && !r.title.toLowerCase().includes(q) && !r.routeId.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [rows, roleFilter, search]);

  const progress = useMemo(() => {
    const cells = filteredRows.flatMap((r) => PLATFORMS.map((p) => r.byPlatform[p].status));
    const total = cells.length;
    const pass = cells.filter((s) => s === "pass").length;
    const fail = cells.filter((s) => s === "fail").length;
    const blocked = cells.filter((s) => s === "blocked").length;
    const perPlatform = PLATFORMS.map((p) => {
      const cs = filteredRows.map((r) => r.byPlatform[p].status);
      return {
        platform: p,
        total: cs.length,
        pass: cs.filter((s) => s === "pass").length,
        fail: cs.filter((s) => s === "fail").length,
        blocked: cs.filter((s) => s === "blocked").length,
      };
    });
    return { total, pass, fail, blocked, perPlatform };
  }, [filteredRows]);

  const uniqueRoles = useMemo(
    () => Array.from(new Set(rows.map((r) => r.role))).sort((a, b) => ROLE_ORDER.indexOf(a) - ROLE_ORDER.indexOf(b)),
    [rows]
  );

  const failingTreeIds = useMemo(() => {
    const fails = filteredRows.filter((r) => r.passCount < PLATFORMS.length);
    const ids = new Set(fails.map((r) => r.treeId));
    return [...ids];
  }, [filteredRows]);

  const openReport = useCallback(async (jobId: string) => {
    setViewingJobId(jobId);
    setViewingReport(null);
    setViewingError(null);
    setExpandedRouteIds(new Set());
    const token = typeof localStorage !== "undefined" ? localStorage.getItem(RUNNER_TOKEN_KEY) : null;
    try {
      const res = await fetch(`${RUNNER_BASE}/jobs/${jobId}/report`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        cache: "no-store",
      });
      if (res.status === 404) {
        setViewingError("Report not ready yet — job may still be running.");
        return;
      }
      if (res.status === 401) {
        setViewingError("Bearer token rejected. Clear localStorage and re-enter.");
        return;
      }
      if (!res.ok) { setViewingError(`HTTP ${res.status}`); return; }
      const data = (await res.json()) as FullReport;
      setViewingReport(data);
    } catch (e) {
      setViewingError(`Failed to load: ${(e as Error).message}`);
    }
  }, []);

  const closeReport = useCallback(() => {
    setViewingJobId(null);
    setViewingReport(null);
    setViewingError(null);
  }, []);

  useEffect(() => {
    if (!viewingJobId) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") closeReport(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [viewingJobId, closeReport]);

  function toggleRoute(routeId: string) {
    setExpandedRouteIds((s) => {
      const next = new Set(s);
      if (next.has(routeId)) next.delete(routeId); else next.add(routeId);
      return next;
    });
  }

  function copyScenario(row: Row) {
    const project = (doc.title ?? "project").toLowerCase().replace(/\W+/g, "-");
    const lines = [
      `# ${row.title}`,
      `Role: ${row.role}`,
      `Route: ${row.routeId}`,
      ``,
      `## Steps`,
      ...row.steps.flatMap((s) => [
        `${s.n}. ${s.step}` + (s.stateTitle ? `  [${s.stateTitle}]` : ""),
        s.expect ? `   Expect: ${s.expect}` : "",
      ]).filter(Boolean),
      ``,
      `## Mark when done`,
      ...PLATFORMS.map((p) => `flowdoc test mark ${project}__${row.routeId}__${p} --status pass`),
    ].join("\n");
    if (typeof navigator !== "undefined" && navigator.clipboard) {
      void navigator.clipboard.writeText(lines);
    }
  }

  if (trees.length === 0) {
    return <div className="tests-page tests-empty">No handwritten scenario trees in flows.json.</div>;
  }

  const pct = progress.total === 0 ? 0 : Math.round((progress.pass / progress.total) * 100);

  return (
    <div className="tests-page">
      <div className="tests-runner-bar">
        <span className={`tests-runner-dot ${runnerOnline === true ? "online" : runnerOnline === false ? "offline" : "unknown"}`} />
        <span className="tests-runner-status">
          {runnerOnline === null && "checking runner…"}
          {runnerOnline === false && "runner offline (canvas read-only)"}
          {runnerOnline === true && !runnerResults && "runner online · no runs yet"}
          {runnerOnline === true && runnerResults && (
            <>runner online · last run {runnerResults.finishedAt ? new Date(runnerResults.finishedAt).toLocaleString() : "—"} · {runnerResults.passed}/{runnerResults.total} pass{runnerResults.failed ? `, ${runnerResults.failed} fail` : ""}</>
          )}
        </span>
        {runnerOnline === true && (
          <div className="tests-runner-buttons">
            <button className="tests-runner-btn" onClick={() => kickRun()} disabled={!!activeJob && activeJob.status === "running"}>▶ Run all</button>
            <button className="tests-runner-btn" onClick={() => kickRun(failingTreeIds)} disabled={!!activeJob && activeJob.status === "running" || failingTreeIds.length === 0}>↻ Re-run failing ({failingTreeIds.length})</button>
          </div>
        )}
        {activeJob && (
          <button
            className="tests-runner-job tests-runner-job-btn"
            onClick={() => (activeJob.status === "passed" || activeJob.status === "failed") && openReport(activeJob.id)}
            disabled={activeJob.status === "queued" || activeJob.status === "running"}
            title={(activeJob.status === "passed" || activeJob.status === "failed") ? "Click for details" : "Run in progress…"}
          >
            job {activeJob.id.slice(0, 8)} · <strong>{activeJob.status}</strong>
            {activeJob.status === "running" && " (Playwright working…)"}
            {(activeJob.status === "passed" || activeJob.status === "failed") && ` · ${activeJob.passed}/${activeJob.total} pass`}
            {activeJob.error && ` · ${activeJob.error}`}
          </button>
        )}
        {runnerResults && (!activeJob || activeJob.id !== runnerResults.jobId) && (
          <button
            className="tests-runner-job tests-runner-job-btn"
            onClick={() => openReport(runnerResults.jobId)}
            title="Open last run report"
          >
            ↗ last run {runnerResults.jobId.slice(0, 8)}
          </button>
        )}
      </div>
      <div className="tests-progress-wrap">
        <div className="tests-progress-top">
          <span className="tests-progress-pct">{pct}%</span>
          <div className="tests-progress-bar">
            <div className="tests-progress-seg pass" style={{ width: `${(progress.pass / Math.max(1, progress.total)) * 100}%` }} />
            <div className="tests-progress-seg fail" style={{ width: `${(progress.fail / Math.max(1, progress.total)) * 100}%` }} />
            <div className="tests-progress-seg blocked" style={{ width: `${(progress.blocked / Math.max(1, progress.total)) * 100}%` }} />
          </div>
          <span className="tests-progress-num">{progress.pass} / {progress.total}</span>
        </div>
        <div className="tests-progress-grid">
          {progress.perPlatform.map((pp) => {
            const ppPct = pp.total === 0 ? 0 : Math.round((pp.pass / pp.total) * 100);
            return (
              <div key={pp.platform} className="tests-platform">
                <span className="tests-platform-label">{PLATFORM_SHORT[pp.platform]}</span>
                <div className="tests-platform-bar">
                  <div className="seg pass" style={{ width: `${(pp.pass / Math.max(1, pp.total)) * 100}%` }} />
                  <div className="seg fail" style={{ width: `${(pp.fail / Math.max(1, pp.total)) * 100}%` }} />
                  <div className="seg blocked" style={{ width: `${(pp.blocked / Math.max(1, pp.total)) * 100}%` }} />
                </div>
                <span className="tests-platform-num">{pp.pass}/{pp.total} · {ppPct}%</span>
              </div>
            );
          })}
        </div>
      </div>

      <div className="tests-filters">
        <div className="tests-role-chips">
          <button className={`tests-chip ${roleFilter === "all" ? "on" : ""}`} onClick={() => setRoleFilter("all")}>
            All<span className="tests-chip-n">{rows.length}</span>
          </button>
          {uniqueRoles.map((r) => {
            const count = rows.filter((x) => x.role === r).length;
            const on = roleFilter === r;
            return (
              <button
                key={r}
                className={`tests-chip ${on ? "on" : ""}`}
                style={on ? { background: ROLE_COLOR[r], color: "#fff", borderColor: ROLE_COLOR[r] } : { color: ROLE_COLOR[r] }}
                onClick={() => setRoleFilter(on ? "all" : r)}
              >{r}<span className="tests-chip-n">{count}</span></button>
            );
          })}
        </div>
        <input
          type="text"
          className="tests-search"
          placeholder="Search…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>

      <div className="tests-list">
        {filteredRows.length === 0 && (
          <div className="tests-empty-row">No scenarios match.</div>
        )}
        {filteredRows.map((row) => {
          const open = expandedId === row.routeId;
          return (
            <div key={row.routeId} className={`tests-row ${open ? "open" : ""}`}>
              <button
                className="tests-row-head"
                onClick={() => setExpandedId(open ? null : row.routeId)}
              >
                <span className="tests-row-caret">{open ? "▾" : "▸"}</span>
                <span className="tests-row-role" style={{ color: ROLE_COLOR[row.role] }}>{row.role}</span>
                <span className="tests-row-title">{row.title}</span>
                <span className="tests-row-platforms">
                  {PLATFORMS.map((p) => (
                    <span
                      key={p}
                      className={`tests-row-dot status-${row.byPlatform[p].status}`}
                      title={`${PLATFORM_SHORT[p]}: ${row.byPlatform[p].status}${row.byPlatform[p].notes ? ` — ${row.byPlatform[p].notes}` : ""}`}
                    >{glyph(row.byPlatform[p].status)}</span>
                  ))}
                </span>
                <span className={`tests-row-prog ${row.passCount === PLATFORMS.length ? "all-pass" : ""}`}>
                  {row.passCount}/{PLATFORMS.length}
                </span>
              </button>
              {open && (
                <div className="tests-row-body">
                  <ol className="tests-steps">
                    {row.steps.map((s) => (
                      <li key={s.n}>
                        <div className="tests-step-line">
                          <span className="tests-step-num">{s.n}.</span>
                          <span className="tests-step-text">{s.step}</span>
                          {s.stateTitle && <span className="tests-step-state">{s.stateTitle}</span>}
                        </div>
                        {s.expect && <div className="tests-step-expect">↳ {s.expect}</div>}
                      </li>
                    ))}
                  </ol>
                  <div className="tests-row-actions">
                    <button className="tests-action-btn" onClick={() => copyScenario(row)}>
                      📋 Copy scenario
                    </button>
                    <div className="tests-row-platform-status">
                      {PLATFORMS.map((p) => {
                        const cell = row.byPlatform[p];
                        return (
                          <div key={p} className={`tests-pf-line status-${cell.status}`}>
                            <span className="tests-pf-name">{PLATFORM_SHORT[p]}</span>
                            <span className="tests-pf-status">{cell.status}</span>
                            {cell.notes && <span className="tests-pf-notes">{cell.notes}</span>}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>

      <div className="tests-footer">
        {filteredRows.length} of {rows.length} scenarios
      </div>

      {viewingJobId && (
        <div className="tests-report-overlay" onClick={closeReport}>
          <div className="tests-report-panel" onClick={(e) => e.stopPropagation()}>
            <div className="tests-report-head">
              <span className="tests-report-title">
                Job {viewingJobId.slice(0, 8)}
                {viewingReport && (
                  <>
                    {" — "}
                    <strong style={{ color: viewingReport.failed > 0 ? "#dc2626" : "#16a34a" }}>
                      {viewingReport.passed}/{viewingReport.total} pass
                    </strong>
                    {viewingReport.failed > 0 && `, ${viewingReport.failed} fail`}
                  </>
                )}
              </span>
              <button className="tests-report-close" onClick={closeReport} title="Close (esc)">✕</button>
            </div>
            {viewingError && <div className="tests-report-error">{viewingError}</div>}
            {!viewingReport && !viewingError && <div className="tests-report-loading">Loading report…</div>}
            {viewingReport && (
              <div className="tests-report-body">
                <div className="tests-report-meta">
                  {viewingReport.baseUrl} · {viewingReport.startedAt && new Date(viewingReport.startedAt).toLocaleString()}
                </div>
                <div className="tests-report-routes">
                  {viewingReport.routes
                    .slice()
                    .sort((a, b) => (a.status === "fail" ? -1 : 1) - (b.status === "fail" ? -1 : 1))
                    .map((rt) => {
                      const isOpen = expandedRouteIds.has(rt.routeId) || rt.status === "fail";
                      return (
                        <div key={rt.routeId} className={`tests-report-route ${rt.status}`}>
                          <button className="tests-report-route-head" onClick={() => toggleRoute(rt.routeId)}>
                            <span className={`tests-report-route-glyph ${rt.status}`}>
                              {rt.status === "pass" ? "✓" : "✗"}
                            </span>
                            <span className="tests-report-route-role" style={{ color: ROLE_COLOR[rt.role ?? "any"] ?? "#64748b" }}>
                              {rt.role ?? "any"}
                            </span>
                            <span className="tests-report-route-title">{rt.title}</span>
                            {rt.status === "fail" && rt.failedAt !== undefined && (
                              <span className="tests-report-route-failed-at">failed at step {rt.failedAt + 1}</span>
                            )}
                          </button>
                          {isOpen && (
                            <div className="tests-report-steps">
                              {rt.steps.map((s, i) => (
                                <div key={i} className={`tests-report-step status-${s.status}`}>
                                  <div className="tests-report-step-line">
                                    <span className="tests-report-step-num">{i + 1}.</span>
                                    <span className="tests-report-step-text">{s.step}</span>
                                    {s.url && <span className="tests-report-step-url">{s.url.replace(viewingReport.baseUrl, "")}</span>}
                                    <span className={`tests-report-step-status status-${s.status}`}>{s.status}</span>
                                  </div>
                                  {s.adapter && (
                                    <div className={`tests-report-adapter ${s.adapter.pass ? "pass" : "fail"}`}>
                                      <span className="tests-report-adapter-kind">{s.adapter.kind}</span>
                                      <span className="tests-report-adapter-reason">{s.adapter.reason}</span>
                                      {s.adapter.kind === "axe" && Array.isArray((s.adapter.detail as { violations?: unknown[] } | undefined)?.violations) && (
                                        <ul className="tests-report-adapter-violations">
                                          {((s.adapter.detail as { violations: Array<{ id: string; help: string; nodes: number }> }).violations).map((v, idx) => (
                                            <li key={idx}>
                                              <code>{v.id}</code> ({v.nodes} nodes) — {v.help}
                                            </li>
                                          ))}
                                        </ul>
                                      )}
                                    </div>
                                  )}
                                  {s.llmVerdict && !s.adapter && (
                                    <div className={`tests-report-adapter ${s.llmVerdict.pass ? "pass" : "fail"}`}>
                                      <span className="tests-report-adapter-kind">llm</span>
                                      <span className="tests-report-adapter-reason">{s.llmVerdict.reason}</span>
                                    </div>
                                  )}
                                  {(s.consoleErrors.length > 0 || s.pageErrors.length > 0) && (
                                    <div className="tests-report-errors">
                                      {s.pageErrors.slice(0, 3).map((e, idx) => <div key={`pe${idx}`} className="tests-report-err">page error: {e}</div>)}
                                      {s.consoleErrors.slice(0, 3).map((e, idx) => <div key={`ce${idx}`} className="tests-report-err">console: {e}</div>)}
                                    </div>
                                  )}
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      );
                    })}
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
