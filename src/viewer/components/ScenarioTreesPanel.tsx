import { useMemo, useState } from "react";
import type { FlowDoc } from "../../schema";
import { expandScenarioTree, type ScenarioRoute, toCsv } from "../../commands/scenario-tree";

interface Props {
  doc: FlowDoc;
  activeRouteId: string | null;
  onActivateRoute: (route: ScenarioRoute | null) => void;
}

const KIND_COLOR: Record<string, string> = {
  happy: "#16a34a",
  edge: "#ea580c",
  security: "#dc2626",
  regression: "#9333ea",
};

const ROLE_ORDER = ["anon", "client", "worker", "dispatcher", "manager", "admin", "any"];

const ROLE_COLOR: Record<string, string> = {
  anon: "#64748b",
  client: "#0ea5e9",
  worker: "#16a34a",
  dispatcher: "#f59e0b",
  manager: "#2563eb",
  admin: "#9333ea",
  any: "#94a3b8",
};

function statusDot(s: string): string {
  switch (s) {
    case "pass":    return "✓";
    case "fail":    return "✗";
    case "blocked": return "⊘";
    case "partial": return "◐";
    case "pending":
    default:        return "○";
  }
}

export function ScenarioTreesPanel({ doc, activeRouteId, onActivateRoute }: Props) {
  const trees = doc.scenarioTrees ?? [];
  const [expandedTrees, setExpandedTrees] = useState<Set<string>>(new Set());
  const [collapsedRoles, setCollapsedRoles] = useState<Set<string>>(new Set());

  const routesByTree = useMemo(() => {
    const m = new Map<string, ScenarioRoute[]>();
    for (const t of trees) {
      try { m.set(t.id, expandScenarioTree(t, { maxCombinationSize: 3 })); }
      catch { m.set(t.id, []); }
    }
    return m;
  }, [trees]);

  // Group trees by role — Сергей's ask. Within a role, the trees appear in
  // the order they're defined; happy first, then edge, then security tends
  // to fall out naturally from author order, which is what we want.
  const treesByRole = useMemo(() => {
    const m = new Map<string, typeof trees>();
    for (const t of trees) {
      const role = t.role ?? "any";
      if (!m.has(role)) m.set(role, []);
      m.get(role)!.push(t);
    }
    return m;
  }, [trees]);

  const totalRoutes = useMemo(() => {
    let n = 0;
    for (const r of routesByTree.values()) n += r.length;
    return n;
  }, [routesByTree]);

  function downloadCsv() {
    const all: ScenarioRoute[] = [];
    for (const r of routesByTree.values()) all.push(...r);
    const csv = toCsv(all, doc.states ?? []);
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${(doc.title ?? "scenarios").replace(/\W+/g, "-")}-routes.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  function toggleTree(id: string) {
    setExpandedTrees((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  function toggleRole(role: string) {
    setCollapsedRoles((s) => {
      const next = new Set(s);
      if (next.has(role)) next.delete(role); else next.add(role);
      return next;
    });
  }

  if (trees.length === 0) {
    return (
      <div className="flowdoc-trees-panel flowdoc-trees-empty">
        <div className="flowdoc-trees-head">
          <span className="flowdoc-trees-title">Handwritten scenarios</span>
        </div>
        <div className="flowdoc-trees-empty-msg">
          No scenarioTrees[] in flows.json yet. Add handwritten intent trees
          grouped by role to describe what should be tested.
        </div>
      </div>
    );
  }

  return (
    <div className="flowdoc-trees-panel">
      <div className="flowdoc-trees-head">
        <span className="flowdoc-trees-title">Handwritten scenarios</span>
        <span className="flowdoc-trees-count">{trees.length} trees · {totalRoutes} routes</span>
        <button className="flowdoc-trees-dl" onClick={downloadCsv} title="Download all routes as CSV">↓ CSV</button>
      </div>
      <div className="flowdoc-trees-list">
        {[...treesByRole.entries()]
          .sort(([a], [b]) => ROLE_ORDER.indexOf(a) - ROLE_ORDER.indexOf(b))
          .map(([role, list]) => {
            const collapsed = collapsedRoles.has(role);
            const roleRoutes = list.reduce((n, t) => n + (routesByTree.get(t.id)?.length ?? 0), 0);
            const color = ROLE_COLOR[role] ?? "#64748b";
            return (
              <div key={role} className="flowdoc-trees-role-group">
                <button
                  className="flowdoc-trees-role-head"
                  onClick={() => toggleRole(role)}
                  style={{ borderLeftColor: color }}
                  title={`${list.length} trees · ${roleRoutes} routes`}
                >
                  <span className="flowdoc-trees-role-arrow">{collapsed ? "▸" : "▾"}</span>
                  <span className="flowdoc-trees-role-label" style={{ color }}>{role.toUpperCase()}</span>
                  <span className="flowdoc-trees-role-count">{list.length} · {roleRoutes}</span>
                </button>
                {!collapsed && list.map((tree) => {
                  const routes = routesByTree.get(tree.id) ?? [];
                  const open = expandedTrees.has(tree.id);
                  return (
                    <div key={tree.id} className={`flowdoc-tree ${open ? "open" : ""}`}>
                      <button className="flowdoc-tree-head" onClick={() => toggleTree(tree.id)}>
                        <span className="flowdoc-tree-caret">{open ? "▾" : "▸"}</span>
                        <span className="flowdoc-tree-kind" style={{ background: KIND_COLOR[tree.kind] }}>{tree.kind}</span>
                        <span className="flowdoc-tree-title-text">{tree.title}</span>
                        <span className="flowdoc-tree-route-count">{routes.length}</span>
                      </button>
                      {open && (
                        <ul className="flowdoc-tree-routes">
                          {routes.map((r) => {
                            const isActive = activeRouteId === r.routeId;
                            const tailLabel = r.title.split("·").pop()?.trim() ?? r.title;
                            const statusEntry = (doc.routeStatus ?? []).find((rs) => rs.routeId === r.routeId);
                            const summary = statusEntry?.summary ?? "pending";
                            const perPlatformTooltip = statusEntry?.perPlatform
                              .map((p) => `  ${p.platform.padEnd(12)}  ${p.status ?? "pending"}${p.notes ? ` — ${p.notes.slice(0, 60)}` : ""}`)
                              .join("\n") ?? "no test runs yet";
                            const tooltip = `${r.steps.map((s, i) => `${i + 1}. ${s.step}${s.expect ? `\n   ↳ ${s.expect}` : ""}`).join("\n")}\n\nTest status (${summary}):\n${perPlatformTooltip}`;
                            return (
                              <li
                                key={r.routeId}
                                className={`flowdoc-tree-route flowdoc-status-${summary} ${isActive ? "active" : ""}`}
                                onClick={() => onActivateRoute(isActive ? null : r)}
                                title={tooltip}
                              >
                                <span className={`flowdoc-tree-route-status flowdoc-status-${summary}`}>{statusDot(summary)}</span>
                                <span className="flowdoc-tree-route-id">{r.routeId.split("-").pop()}</span>
                                <span className="flowdoc-tree-route-len">{r.steps.length}</span>
                                <span className="flowdoc-tree-route-label">{tailLabel}</span>
                              </li>
                            );
                          })}
                        </ul>
                      )}
                    </div>
                  );
                })}
              </div>
            );
          })}
      </div>
    </div>
  );
}
