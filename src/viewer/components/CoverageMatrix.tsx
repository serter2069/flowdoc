import { useMemo, useState } from "react";
import type { Screen } from "../../schema";
import type { RunsData, RunStatus, ScreenRun } from "../runs";

const PLATFORM_ORDER = ["web-desktop", "web-mobile", "web-tablet", "ios", "android"];
const PLATFORM_LABEL: Record<string, string> = {
  "web-desktop": "Web · Desktop",
  "web-mobile": "Web · Mobile",
  "web-tablet": "Web · Tablet",
  ios: "iOS",
  android: "Android",
};

interface Props {
  screens: Screen[];
  runs: RunsData;
}

type SortKey = "id" | "path" | "group" | "kind";
type FilterKey = "all" | "untested" | "fail" | "pass";

function statusCell(run: ScreenRun | undefined): { label: string; cls: string; title: string } {
  if (!run || run.status === "untested") return { label: "—", cls: "cell-untested", title: "Not tested on this platform" };
  if (run.status === "pass") return { label: "✓", cls: "cell-pass", title: `pass · ${run.httpStatus ?? ""} · ${run.ms ?? "?"}ms` };
  if (run.status === "fail") return { label: "✗", cls: "cell-fail", title: `FAIL · ${run.error || `HTTP ${run.httpStatus}`}` };
  return { label: "·", cls: "cell-skip", title: `skipped · ${run.error || ""}` };
}

export function CoverageMatrix({ screens, runs }: Props) {
  const [sortKey, setSortKey] = useState<SortKey>("group");
  const [sortDir, setSortDir] = useState<1 | -1>(1);
  const [filter, setFilter] = useState<FilterKey>("all");
  const [query, setQuery] = useState("");

  const platforms = useMemo(() => {
    const present = new Set([...runs.platforms, "web-desktop", "web-mobile", "ios", "android"]);
    return PLATFORM_ORDER.filter((p) => present.has(p));
  }, [runs.platforms]);

  const rows = useMemo(() => {
    let list = screens.map((s) => {
      const byPlatform: Record<string, ScreenRun | undefined> = {};
      for (const p of platforms) byPlatform[p] = runs.byScreen[s.id]?.[p];
      const statuses = platforms.map((p) => byPlatform[p]?.status ?? "untested") as RunStatus[];
      const summary: RunStatus = statuses.includes("fail") ? "fail" : statuses.every((s) => s === "untested") ? "untested" : statuses.includes("untested") ? "pass" : "pass";
      return { screen: s, byPlatform, summary };
    });

    if (filter !== "all") {
      list = list.filter((r) => r.summary === filter || (filter === "untested" && Object.values(r.byPlatform).every((v) => !v)));
    }
    if (query.trim()) {
      const q = query.trim().toLowerCase();
      list = list.filter((r) => r.screen.id.toLowerCase().includes(q) || r.screen.name.toLowerCase().includes(q) || (r.screen.path ?? "").toLowerCase().includes(q));
    }
    list.sort((a, b) => {
      const ka = (a.screen as Record<string, unknown>)[sortKey] ?? "";
      const kb = (b.screen as Record<string, unknown>)[sortKey] ?? "";
      return String(ka).localeCompare(String(kb)) * sortDir;
    });
    return list;
  }, [screens, runs, platforms, filter, query, sortKey, sortDir]);

  const totals = useMemo(() => {
    const t = { screens: rows.length, byPlatform: {} as Record<string, { pass: number; fail: number; untested: number }> };
    for (const p of platforms) t.byPlatform[p] = { pass: 0, fail: 0, untested: 0 };
    for (const r of rows) {
      for (const p of platforms) {
        const st = r.byPlatform[p]?.status ?? "untested";
        if (st === "pass") t.byPlatform[p].pass++;
        else if (st === "fail") t.byPlatform[p].fail++;
        else t.byPlatform[p].untested++;
      }
    }
    return t;
  }, [rows, platforms]);

  const toggleSort = (k: SortKey) => {
    if (k === sortKey) setSortDir(sortDir === 1 ? -1 : 1);
    else { setSortKey(k); setSortDir(1); }
  };

  return (
    <div className="coverage-wrap">
      <div className="coverage-toolbar">
        <input
          className="coverage-search"
          placeholder="Filter screens (name, id, path)…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <div className="coverage-filter">
          {(["all", "fail", "untested", "pass"] as FilterKey[]).map((f) => (
            <button key={f} type="button" className={`chip ${filter === f ? "on" : ""}`} onClick={() => setFilter(f)}>
              {f}
            </button>
          ))}
        </div>
        <div className="coverage-totals">
          <span>{rows.length} screens shown</span>
          {platforms.map((p) => (
            <span key={p} className="totals-pill">
              {PLATFORM_LABEL[p] ?? p}: <b className="cell-pass">{totals.byPlatform[p].pass}</b> / <b className="cell-fail">{totals.byPlatform[p].fail}</b> / <span className="cell-untested">{totals.byPlatform[p].untested}</span>
            </span>
          ))}
        </div>
      </div>

      <div className="coverage-table-wrap">
        <table className="coverage-table">
          <thead>
            <tr>
              <th className="th-sort" onClick={() => toggleSort("group")}>Group</th>
              <th className="th-sort" onClick={() => toggleSort("id")}>Screen</th>
              <th className="th-sort" onClick={() => toggleSort("path")}>Path</th>
              <th className="th-sort" onClick={() => toggleSort("kind")}>Kind</th>
              {platforms.map((p) => (
                <th key={p} className="th-platform" title={PLATFORM_LABEL[p] ?? p}>
                  {PLATFORM_LABEL[p] ?? p}
                </th>
              ))}
              <th>Last run</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const anyRun = platforms.map((p) => r.byPlatform[p]).find((x) => x);
              return (
                <tr key={r.screen.id} className={`row-${r.summary}`}>
                  <td className="td-group">{r.screen.group ?? "—"}</td>
                  <td className="td-id"><b>{r.screen.name}</b><div className="td-id-slug">{r.screen.id}</div></td>
                  <td className="td-path"><code>{r.screen.path ?? "—"}</code></td>
                  <td className="td-kind">{r.screen.kind ?? "screen"}</td>
                  {platforms.map((p) => {
                    const c = statusCell(r.byPlatform[p]);
                    return <td key={p} className={`td-status ${c.cls}`} title={c.title}>{c.label}{r.byPlatform[p]?.ms ? <span className="ms">{r.byPlatform[p]!.ms}ms</span> : null}</td>;
                  })}
                  <td className="td-runtime">{anyRun?.startedAt ? new Date(anyRun.startedAt).toLocaleString() : "—"}</td>
                </tr>
              );
            })}
            {rows.length === 0 ? (
              <tr><td colSpan={4 + platforms.length + 1} className="td-empty">No screens match filter.</td></tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </div>
  );
}
