import { useMemo, useState } from "react";
import type { FlowDoc } from "../../schema";
import { expandScenarioTree, type ScenarioRoute } from "../../commands/scenario-tree";

interface Props {
  doc: FlowDoc;
}

type CellStatus = "pass" | "fail" | "blocked" | "pending";
type OverallStatus = "all-pass" | "any-fail" | "mixed" | "all-pending";

const PLATFORMS = ["web-desktop", "web-mobile", "ios", "android"] as const;
type Platform = (typeof PLATFORMS)[number];

const ROLE_ORDER = ["anon", "client", "worker", "dispatcher", "manager", "admin", "any"];
const ROLE_COLOR: Record<string, string> = {
  anon: "#64748b", client: "#0ea5e9", worker: "#16a34a",
  dispatcher: "#f59e0b", manager: "#2563eb", admin: "#9333ea", any: "#94a3b8",
};

const KIND_ORDER = ["happy", "edge", "security", "regression"];
const KIND_COLOR: Record<string, string> = {
  happy: "#16a34a", edge: "#ea580c", security: "#dc2626", regression: "#9333ea",
};

const STATUS_COLOR: Record<CellStatus, string> = {
  pass: "#16a34a", fail: "#dc2626", blocked: "#f59e0b", pending: "#94a3b8",
};

function statusGlyph(s: CellStatus): string {
  return s === "pass" ? "✓" : s === "fail" ? "✗" : s === "blocked" ? "⊘" : "○";
}

interface Row {
  routeId: string;
  treeId: string;
  treeTitle: string;
  role: string;
  kind: string;
  title: string;
  stepCount: number;
  byPlatform: Record<Platform, { status: CellStatus; notes: string }>;
  passCount: number;
  doneCount: number;
  overall: OverallStatus;
}

function classifyOverall(r: Row): OverallStatus {
  const statuses = PLATFORMS.map((p) => r.byPlatform[p].status);
  if (statuses.every((s) => s === "pending")) return "all-pending";
  if (statuses.every((s) => s === "pass")) return "all-pass";
  if (statuses.some((s) => s === "fail")) return "any-fail";
  return "mixed";
}

export function TestsPanel({ doc }: Props) {
  const trees = doc.scenarioTrees ?? [];

  const rows: Row[] = useMemo(() => {
    const statusByRouteId = new Map((doc.routeStatus ?? []).map((rs) => [rs.routeId, rs]));
    const out: Row[] = [];
    for (const t of trees) {
      let routes: ScenarioRoute[] = [];
      try { routes = expandScenarioTree(t, { maxCombinationSize: 3 }); } catch { /* skip */ }
      for (const r of routes) {
        const status = statusByRouteId.get(r.routeId);
        const byPlatform = {} as Row["byPlatform"];
        let passCount = 0, doneCount = 0;
        for (const p of PLATFORMS) {
          const entry = status?.perPlatform.find((x) => x.platform === p);
          const s: CellStatus = (entry?.status as CellStatus | null | undefined) ?? "pending";
          byPlatform[p] = { status: s, notes: entry?.notes ?? "" };
          if (s === "pass") { passCount++; doneCount++; }
          else if (s === "fail" || s === "blocked") doneCount++;
        }
        const row: Row = {
          routeId: r.routeId,
          treeId: r.treeId,
          treeTitle: t.title,
          role: r.role ?? t.role ?? "any",
          kind: r.kind ?? t.kind ?? "happy",
          title: r.title,
          stepCount: r.steps.length,
          byPlatform, passCount, doneCount,
          overall: "all-pending",
        };
        row.overall = classifyOverall(row);
        out.push(row);
      }
    }
    return out;
  }, [trees, doc.routeStatus]);

  const [activeRoles, setActiveRoles] = useState<Set<string>>(new Set());
  const [activeKinds, setActiveKinds] = useState<Set<string>>(new Set());
  const [activeOverall, setActiveOverall] = useState<Set<OverallStatus>>(new Set());
  const [perPlatformFilter, setPerPlatformFilter] = useState<Record<Platform, "any" | CellStatus>>({
    "web-desktop": "any", "web-mobile": "any", ios: "any", android: "any",
  });
  const [search, setSearch] = useState("");
  const [activeTreeId, setActiveTreeId] = useState<string>("");

  const toggleSet = <T extends string>(set: Set<T>, setter: (s: Set<T>) => void, v: T) => {
    const next = new Set(set);
    if (next.has(v)) next.delete(v); else next.add(v);
    setter(next);
  };

  const filteredRows = useMemo(() => {
    const q = search.trim().toLowerCase();
    return rows.filter((r) => {
      if (activeRoles.size > 0 && !activeRoles.has(r.role)) return false;
      if (activeKinds.size > 0 && !activeKinds.has(r.kind)) return false;
      if (activeOverall.size > 0 && !activeOverall.has(r.overall)) return false;
      if (activeTreeId && r.treeId !== activeTreeId) return false;
      for (const p of PLATFORMS) {
        const want = perPlatformFilter[p];
        if (want !== "any" && r.byPlatform[p].status !== want) return false;
      }
      if (q && !(
        r.title.toLowerCase().includes(q) ||
        r.routeId.toLowerCase().includes(q) ||
        r.treeTitle.toLowerCase().includes(q)
      )) return false;
      return true;
    });
  }, [rows, activeRoles, activeKinds, activeOverall, perPlatformFilter, activeTreeId, search]);

  // Progress meters. Use the FILTERED set so the progress reflects current scope.
  const progress = useMemo(() => {
    const total = filteredRows.length * PLATFORMS.length;
    const cells: CellStatus[] = filteredRows.flatMap((r) => PLATFORMS.map((p) => r.byPlatform[p].status));
    const pass = cells.filter((s) => s === "pass").length;
    const fail = cells.filter((s) => s === "fail").length;
    const blocked = cells.filter((s) => s === "blocked").length;
    const pending = total - pass - fail - blocked;
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
    const perRole = ROLE_ORDER.map((role) => {
      const rs = filteredRows.filter((r) => r.role === role);
      const totalR = rs.length * PLATFORMS.length;
      if (totalR === 0) return null;
      const csR = rs.flatMap((r) => PLATFORMS.map((p) => r.byPlatform[p].status));
      return {
        role, total: totalR,
        pass: csR.filter((s) => s === "pass").length,
        fail: csR.filter((s) => s === "fail").length,
        blocked: csR.filter((s) => s === "blocked").length,
      };
    }).filter((x): x is NonNullable<typeof x> => !!x);
    const perKind = KIND_ORDER.map((kind) => {
      const rs = filteredRows.filter((r) => r.kind === kind);
      const totalK = rs.length * PLATFORMS.length;
      if (totalK === 0) return null;
      const csK = rs.flatMap((r) => PLATFORMS.map((p) => r.byPlatform[p].status));
      return {
        kind, total: totalK,
        pass: csK.filter((s) => s === "pass").length,
        fail: csK.filter((s) => s === "fail").length,
        blocked: csK.filter((s) => s === "blocked").length,
      };
    }).filter((x): x is NonNullable<typeof x> => !!x);
    return { total, pass, fail, blocked, pending, perPlatform, perRole, perKind };
  }, [filteredRows]);

  function copyCli(row: Row) {
    const project = (doc.title ?? "project").toLowerCase().replace(/\W+/g, "-");
    const ids = PLATFORMS.map((p) => `${project}__${row.routeId}__${p}`);
    const text = ids.map((id) => `flowdoc test mark ${id} --status pass`).join("\n");
    if (typeof navigator !== "undefined" && navigator.clipboard) {
      void navigator.clipboard.writeText(text);
    }
  }

  if (trees.length === 0) {
    return (
      <div className="flowdoc-tests-panel flowdoc-tests-empty">
        No handwritten scenarios yet. Add scenarioTrees[] to your flows.json to enable test tracking.
      </div>
    );
  }

  const uniqueRoles = Array.from(new Set(rows.map((r) => r.role))).sort(
    (a, b) => ROLE_ORDER.indexOf(a) - ROLE_ORDER.indexOf(b)
  );
  const uniqueKinds = Array.from(new Set(rows.map((r) => r.kind))).sort(
    (a, b) => KIND_ORDER.indexOf(a) - KIND_ORDER.indexOf(b)
  );

  return (
    <div className="flowdoc-tests-panel">

      <div className="flowdoc-tests-progress">
        <div className="flowdoc-tests-progress-row">
          <span className="flowdoc-tests-progress-label">Overall</span>
          <ProgressBar total={progress.total} pass={progress.pass} fail={progress.fail} blocked={progress.blocked} />
          <span className="flowdoc-tests-progress-counts">
            {progress.pass}/{progress.total} pass
            {progress.fail > 0 && <> · <span style={{ color: STATUS_COLOR.fail }}>{progress.fail} fail</span></>}
            {progress.blocked > 0 && <> · <span style={{ color: STATUS_COLOR.blocked }}>{progress.blocked} block</span></>}
            {" · "}{progress.pending} pend
          </span>
        </div>

        <div className="flowdoc-tests-progress-grid">
          <div className="flowdoc-tests-progress-col">
            <div className="flowdoc-tests-progress-col-label">By platform</div>
            {progress.perPlatform.map((pp) => (
              <div key={pp.platform} className="flowdoc-tests-progress-sub">
                <span className="flowdoc-tests-progress-sub-key">{pp.platform}</span>
                <ProgressBar total={pp.total} pass={pp.pass} fail={pp.fail} blocked={pp.blocked} thin />
                <span className="flowdoc-tests-progress-sub-val">{pp.pass}/{pp.total}</span>
              </div>
            ))}
          </div>
          <div className="flowdoc-tests-progress-col">
            <div className="flowdoc-tests-progress-col-label">By role</div>
            {progress.perRole.map((pr) => (
              <div key={pr.role} className="flowdoc-tests-progress-sub">
                <span className="flowdoc-tests-progress-sub-key" style={{ color: ROLE_COLOR[pr.role] }}>{pr.role}</span>
                <ProgressBar total={pr.total} pass={pr.pass} fail={pr.fail} blocked={pr.blocked} thin />
                <span className="flowdoc-tests-progress-sub-val">{pr.pass}/{pr.total}</span>
              </div>
            ))}
          </div>
          <div className="flowdoc-tests-progress-col">
            <div className="flowdoc-tests-progress-col-label">By kind</div>
            {progress.perKind.map((pk) => (
              <div key={pk.kind} className="flowdoc-tests-progress-sub">
                <span className="flowdoc-tests-progress-sub-key" style={{ color: KIND_COLOR[pk.kind] }}>{pk.kind}</span>
                <ProgressBar total={pk.total} pass={pk.pass} fail={pk.fail} blocked={pk.blocked} thin />
                <span className="flowdoc-tests-progress-sub-val">{pk.pass}/{pk.total}</span>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="flowdoc-tests-filters">
        <div className="flowdoc-tests-chips">
          <span className="flowdoc-tests-chip-grouplabel">Role:</span>
          {uniqueRoles.map((r) => (
            <button
              key={r}
              className={`flowdoc-tests-chip ${activeRoles.has(r) ? "on" : ""}`}
              onClick={() => toggleSet(activeRoles, setActiveRoles, r)}
              style={activeRoles.has(r) ? { background: ROLE_COLOR[r], color: "#fff", borderColor: ROLE_COLOR[r] } : { color: ROLE_COLOR[r] }}
            >{r}</button>
          ))}
        </div>
        <div className="flowdoc-tests-chips">
          <span className="flowdoc-tests-chip-grouplabel">Kind:</span>
          {uniqueKinds.map((k) => (
            <button
              key={k}
              className={`flowdoc-tests-chip ${activeKinds.has(k) ? "on" : ""}`}
              onClick={() => toggleSet(activeKinds, setActiveKinds, k)}
              style={activeKinds.has(k) ? { background: KIND_COLOR[k], color: "#fff", borderColor: KIND_COLOR[k] } : { color: KIND_COLOR[k] }}
            >{k}</button>
          ))}
        </div>
        <div className="flowdoc-tests-chips">
          <span className="flowdoc-tests-chip-grouplabel">Status:</span>
          {(["all-pass", "any-fail", "mixed", "all-pending"] as const).map((s) => (
            <button
              key={s}
              className={`flowdoc-tests-chip ${activeOverall.has(s) ? "on" : ""}`}
              onClick={() => toggleSet(activeOverall, setActiveOverall, s)}
            >{s}</button>
          ))}
        </div>
        <div className="flowdoc-tests-filter-line">
          <input
            type="text"
            placeholder="Search title / route id…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="flowdoc-tests-search"
          />
          <select
            value={activeTreeId}
            onChange={(e) => setActiveTreeId(e.target.value)}
            className="flowdoc-tests-tree-picker"
          >
            <option value="">All trees ({trees.length})</option>
            {trees.map((t) => (
              <option key={t.id} value={t.id}>{t.title}</option>
            ))}
          </select>
        </div>
        <div className="flowdoc-tests-platform-filters">
          {PLATFORMS.map((p) => (
            <label key={p} className="flowdoc-tests-pf">
              <span className="flowdoc-tests-pf-key">{p}</span>
              <select
                value={perPlatformFilter[p]}
                onChange={(e) => setPerPlatformFilter((s) => ({ ...s, [p]: e.target.value as "any" | CellStatus }))}
              >
                <option value="any">any</option>
                <option value="pass">pass</option>
                <option value="fail">fail</option>
                <option value="blocked">blocked</option>
                <option value="pending">pending</option>
              </select>
            </label>
          ))}
        </div>
      </div>

      <div className="flowdoc-tests-table-head">
        <span>Role</span>
        <span>Kind</span>
        <span>Route</span>
        {PLATFORMS.map((p) => <span key={p} className="flowdoc-tests-th-p">{p.replace("web-", "w-")}</span>)}
        <span className="flowdoc-tests-th-prog">N/4</span>
      </div>

      <div className="flowdoc-tests-table-body">
        {filteredRows.length === 0 && (
          <div className="flowdoc-tests-emptyrow">No routes match the current filters.</div>
        )}
        {filteredRows.map((row) => (
          <div
            key={row.routeId}
            className="flowdoc-tests-row"
            onClick={() => copyCli(row)}
            title={`${row.title}\n\nstepCount: ${row.stepCount}\nclick to copy CLI mark commands for all 4 platforms`}
          >
            <span className="flowdoc-tests-cell-role" style={{ color: ROLE_COLOR[row.role] }}>{row.role}</span>
            <span className="flowdoc-tests-cell-kind" style={{ color: KIND_COLOR[row.kind] }}>{row.kind}</span>
            <span className="flowdoc-tests-cell-title">{row.title}</span>
            {PLATFORMS.map((p) => {
              const cell = row.byPlatform[p];
              return (
                <span
                  key={p}
                  className={`flowdoc-tests-cell-status status-${cell.status}`}
                  title={cell.notes ? `${cell.status} — ${cell.notes}` : cell.status}
                >{statusGlyph(cell.status)}</span>
              );
            })}
            <span className={`flowdoc-tests-cell-prog ${row.passCount === PLATFORMS.length ? "all-pass" : ""}`}>
              {row.passCount}/{PLATFORMS.length}
            </span>
          </div>
        ))}
      </div>

      <div className="flowdoc-tests-footer">
        {filteredRows.length} of {rows.length} routes shown · click a row to copy CLI mark commands
      </div>
    </div>
  );
}

function ProgressBar({ total, pass, fail, blocked, thin = false }: { total: number; pass: number; fail: number; blocked: number; thin?: boolean }) {
  if (total === 0) return <div className={`flowdoc-tests-bar ${thin ? "thin" : ""}`} />;
  const passPct = (pass / total) * 100;
  const failPct = (fail / total) * 100;
  const blockedPct = (blocked / total) * 100;
  return (
    <div className={`flowdoc-tests-bar ${thin ? "thin" : ""}`}>
      <div className="flowdoc-tests-bar-seg pass" style={{ width: `${passPct}%` }} />
      <div className="flowdoc-tests-bar-seg fail" style={{ width: `${failPct}%` }} />
      <div className="flowdoc-tests-bar-seg blocked" style={{ width: `${blockedPct}%` }} />
    </div>
  );
}
