import { useMemo, useState } from "react";
import type { FlowDoc, Scenario } from "../../schema";
import type { RunsData } from "../runs";

interface Props {
  doc: FlowDoc;
  runs: RunsData;
  activeScenarioIds: Set<string>;
  overlayRole: string | null;
  onSelect: (scenarioId: string, additive: boolean) => void;
  onSelectRole: (role: string) => void;
  scenarioColor: Map<string, string>;
}

const ROLE_ORDER = ["anon", "client", "worker", "dispatcher", "manager", "admin", "any"];

const ROLE_COLORS: Record<string, string> = {
  anon: "#64748b",
  client: "#c026d3",
  worker: "#ea580c",
  dispatcher: "#16a34a",
  manager: "#2563eb",
  admin: "#9333ea",
  any: "#94a3b8",
};

type ScenarioStatus = "untested" | "pass" | "fail" | "drift" | "partial";

function scenarioStatus(sc: Scenario, runs: RunsData): ScenarioStatus {
  if (!runs.baselineByState || Object.keys(runs.baselineByState).length === 0) return "untested";
  const statuses: string[] = [];
  for (const n of sc.path) {
    const byPlat = runs.baselineByState[n];
    if (!byPlat) continue;
    for (const plat of Object.keys(byPlat)) {
      statuses.push(byPlat[plat].status);
    }
  }
  if (statuses.length === 0) return "untested";
  if (statuses.some((s) => s === "error")) return "fail";
  if (statuses.some((s) => s === "drift")) return "drift";
  if (statuses.every((s) => s === "match")) return "pass";
  return "partial";
}

const STATUS_LABEL: Record<ScenarioStatus, string> = {
  untested: "·",
  pass: "✓",
  fail: "✕",
  drift: "△",
  partial: "◐",
};

export function ScenariosSidebar({
  doc,
  runs,
  activeScenarioIds,
  overlayRole,
  onSelect,
  onSelectRole,
  scenarioColor,
}: Props) {
  const scenarios = doc.scenarios ?? [];
  const stateByNum = useMemo(() => new Map((doc.states ?? []).map((s) => [s.num, s])), [doc.states]);

  const [query, setQuery] = useState("");
  const [collapsedRoles, setCollapsedRoles] = useState<Set<string>>(new Set());

  const counts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const s of scenarios) {
      const r = s.role ?? "any";
      c[r] = (c[r] ?? 0) + 1;
    }
    return c;
  }, [scenarios]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return scenarios;
    return scenarios.filter((s) => {
      if (s.title.toLowerCase().includes(q)) return true;
      if (s.id.toLowerCase().includes(q)) return true;
      for (const n of s.path) {
        const t = stateByNum.get(n)?.title?.toLowerCase() ?? "";
        if (t.includes(q)) return true;
      }
      return false;
    });
  }, [scenarios, query, stateByNum]);

  const grouped = useMemo(() => {
    const m = new Map<string, Scenario[]>();
    for (const s of filtered) {
      const r = s.role ?? "any";
      if (!m.has(r)) m.set(r, []);
      m.get(r)!.push(s);
    }
    for (const arr of m.values()) arr.sort((a, b) => b.path.length - a.path.length);
    return m;
  }, [filtered]);

  function toggleCollapse(r: string, e: React.MouseEvent) {
    e.stopPropagation();
    setCollapsedRoles((prev) => {
      const next = new Set(prev);
      if (next.has(r)) next.delete(r);
      else next.add(r);
      return next;
    });
  }

  return (
    <div className="flowdoc-sidebar-panel">
      <div className="flowdoc-sidebar-head">
        <input
          type="search"
          className="flowdoc-sidebar-search"
          placeholder="Filter scenarios… (cmd/ctrl-click items to multi-select)"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <div className="flowdoc-sidebar-hint">
          Click a <b>role</b> to highlight all its paths · Click a <b>scenario</b> to focus its path · Cmd/Ctrl-click to add to selection
        </div>
      </div>

      <div className="flowdoc-sidebar-list">
        {[...grouped.entries()]
          .sort(([a], [b]) => ROLE_ORDER.indexOf(a) - ROLE_ORDER.indexOf(b))
          .map(([role, items]) => {
            const collapsed = collapsedRoles.has(role);
            const isOverlayActive = overlayRole === role;
            return (
              <div key={role} className="flowdoc-sidebar-group">
                <button
                  type="button"
                  className={`flowdoc-sidebar-group-head ${isOverlayActive ? "overlay-on" : ""}`}
                  onClick={() => onSelectRole(role)}
                  style={{
                    borderLeftColor: ROLE_COLORS[role],
                    background: isOverlayActive ? ROLE_COLORS[role] : undefined,
                    color: isOverlayActive ? "#fff" : undefined,
                  }}
                  title={`Highlight all ${items.length} ${role} paths on canvas`}
                >
                  <span
                    className="flowdoc-sidebar-group-arrow"
                    onClick={(e) => toggleCollapse(role, e)}
                    role="button"
                    aria-label="Toggle group"
                  >
                    {collapsed ? "▸" : "▾"}
                  </span>
                  <span className="flowdoc-sidebar-group-label">{role.toUpperCase()}</span>
                  <span className="flowdoc-sidebar-group-count">{items.length}</span>
                </button>
                {!collapsed &&
                  items.map((sc) => {
                    const st = scenarioStatus(sc, runs);
                    const isOn = activeScenarioIds.has(sc.id);
                    const colorDot = isOn ? scenarioColor.get(sc.id) : null;
                    const optCount = ((sc as any).optionAssignments ?? []).length;
                    const optList = ((sc as any).optionAssignments ?? []).slice(0, 6).map((a: any) =>
                      `#${a.stateNum} ${a.target.kind === "control" ? `c[${a.target.idx}]` : a.target.name}=${a.option}`
                    ).join(" · ");
                    const tip = (sc.narrative ?? sc.title) + (optCount ? `\n\nOptions exercised (${optCount}):\n${optList}` : "");
                    return (
                      <button
                        key={sc.id}
                        type="button"
                        className={`flowdoc-sidebar-item st-${st} ${isOn ? "on" : ""}`}
                        onClick={(e) => onSelect(sc.id, e.metaKey || e.ctrlKey || e.shiftKey)}
                        title={tip}
                      >
                        <span
                          className="flowdoc-sidebar-item-bullet"
                          style={{ background: colorDot ?? "transparent", borderColor: colorDot ?? "#cbd5e1" }}
                        />
                        <span className={`flowdoc-sidebar-item-status st-${st}`}>{STATUS_LABEL[st]}</span>
                        <span className="flowdoc-sidebar-item-id">{sc.id.toUpperCase()}</span>
                        <span className="flowdoc-sidebar-item-len">{sc.path.length}</span>
                        <span className="flowdoc-sidebar-item-title">{sc.title}</span>
                        {optCount > 0 && (
                          <span className="flowdoc-sidebar-item-opts" title={`${optCount} option pick(s) — hover for details`}>⚙{optCount}</span>
                        )}
                      </button>
                    );
                  })}
              </div>
            );
          })}
        {filtered.length === 0 && (
          <div className="flowdoc-sidebar-empty">No scenarios match.</div>
        )}
      </div>

      <div className="flowdoc-sidebar-foot">
        <div className="flowdoc-sidebar-counts-bottom">
          <span><b>{scenarios.length}</b> total</span>
          {ROLE_ORDER.filter((r) => (counts[r] ?? 0) > 0).map((r) => (
            <span key={r} style={{ color: ROLE_COLORS[r] }}>· {r.slice(0, 3).toUpperCase()} {counts[r]}</span>
          ))}
        </div>
      </div>
    </div>
  );
}
