import { useMemo, useState } from "react";
import type { FlowDoc } from "../../schema";
import { expandScenarioTree, type ScenarioRoute } from "../../commands/scenario-tree";

interface Props { doc: FlowDoc; }

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
    </div>
  );
}
