import React, { useMemo, useState } from "react";
import type { FlowDoc, ScenarioTree } from "../../schema";
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

export function ScenarioTreesPanel({ doc, activeRouteId, onActivateRoute }: Props) {
  const trees = doc.scenarioTrees ?? [];
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  // Pre-compute routes per tree (memoized — the doc is read-only).
  const routesByTree = useMemo(() => {
    const m = new Map<string, ScenarioRoute[]>();
    for (const t of trees) {
      try { m.set(t.id, expandScenarioTree(t, { maxCombinationSize: 3 })); }
      catch (e) { m.set(t.id, []); }
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

  function toggle(id: string) {
    setExpanded((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id); else next.add(id);
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
          to describe what should be tested — they expand into runnable routes.
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
        {trees.map((tree) => {
          const routes = routesByTree.get(tree.id) ?? [];
          const open = expanded.has(tree.id);
          return (
            <div key={tree.id} className={`flowdoc-tree ${open ? "open" : ""}`}>
              <button className="flowdoc-tree-head" onClick={() => toggle(tree.id)}>
                <span className="flowdoc-tree-caret">{open ? "▾" : "▸"}</span>
                <span className="flowdoc-tree-kind" style={{ background: KIND_COLOR[tree.kind] }}>{tree.kind}</span>
                <span className="flowdoc-tree-role">{tree.role ?? "any"}</span>
                <span className="flowdoc-tree-title-text">{tree.title}</span>
                <span className="flowdoc-tree-route-count">{routes.length}</span>
              </button>
              {open && (
                <ul className="flowdoc-tree-routes">
                  {routes.map((r) => {
                    const isActive = activeRouteId === r.routeId;
                    return (
                      <li
                        key={r.routeId}
                        className={`flowdoc-tree-route ${isActive ? "active" : ""}`}
                        onClick={() => onActivateRoute(isActive ? null : r)}
                        title={r.steps.map((s, i) => `${i + 1}. ${s.step}`).join("\n")}
                      >
                        <span className="flowdoc-tree-route-id">{r.routeId.split("-").pop()}</span>
                        <span className="flowdoc-tree-route-len">{r.steps.length}</span>
                        <span className="flowdoc-tree-route-label">{r.title.split("·").slice(1).join("·").trim() || r.title}</span>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
