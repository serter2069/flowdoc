import { useCallback, useMemo, useRef, useState } from "react";
import type { FlowDoc, Screen } from "../schema";
import { collectEdges } from "../schema";
import { SitemapGraph } from "./components/SitemapGraph";
import { SitemapSidebar } from "./components/SitemapSidebar";
import { SitemapDetail } from "./components/SitemapDetail";
import { CoverageMatrix } from "./components/CoverageMatrix";
import { StateCanvas } from "./components/StateCanvas";
import type { RunsData } from "./runs";

type ViewTab = "graph" | "matrix" | "canvas";

export function App({ data, runs }: { data: FlowDoc; runs: RunsData }) {
  const hasStates = !!(data.states && data.states.length);
  const [tab, setTab] = useState<ViewTab>(hasStates ? "canvas" : runs.runs.length ? "matrix" : "graph");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [roleFilter, setRoleFilter] = useState<string | null>(null);
  const [kindFilter, setKindFilter] = useState<string | null>(null);
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());
  const [showHelp, setShowHelp] = useState(false);

  const searchInputRef = useRef<HTMLInputElement | null>(null);

  const screens = useMemo<Screen[]>(() => data.screens ?? [], [data.screens]);

  const filteredScreens = useMemo<Screen[]>(() => {
    return screens.filter((s) => {
      if (kindFilter && s.kind !== kindFilter) return false;
      if (roleFilter) {
        if (!s.roles?.includes(roleFilter) && !s.roles?.includes("all")) {
          return false;
        }
      }
      if (s.group && collapsedGroups.has(s.group)) return false;
      return true;
    });
  }, [screens, roleFilter, kindFilter, collapsedGroups]);

  const edges = useMemo(() => collectEdges(data), [data]);

  const filteredIds = useMemo(
    () => new Set(filteredScreens.map((s) => s.id)),
    [filteredScreens]
  );

  const toggleGroup = useCallback((groupId: string) => {
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(groupId)) next.delete(groupId);
      else next.add(groupId);
      return next;
    });
  }, []);

  const focusSearch = useCallback(() => {
    searchInputRef.current?.focus();
    searchInputRef.current?.select();
  }, []);

  const clearSelection = useCallback(() => {
    setSelectedId(null);
  }, []);

  return (
    <div className={`app ${tab === "matrix" ? "app-matrix" : ""} ${tab === "canvas" ? "app-canvas" : ""}`}>
      <header className="topbar">
        <div className="title">
          {typeof window !== "undefined" && window.location.hostname.includes("flowchart.smartlaunchhub") && (
            <select
              className="flowdoc-project-switcher"
              defaultValue={window.location.pathname.split("/").filter(Boolean)[0] ?? ""}
              onChange={(e) => {
                const slug = e.target.value;
                if (slug && slug !== window.location.pathname.split("/").filter(Boolean)[0]) {
                  window.location.href = `/${slug}/`;
                }
              }}
            >
              <option value="pluto">Pluto</option>
              <option value="aresgun">AresGun</option>
              <option value="dressit">DressIT</option>
            </select>
          )}
          <h1>{data.title}</h1>
          {data.subtitle ? <span className="sub">{data.subtitle}</span> : null}
        </div>
        <div className="topbar-tabs">
          {hasStates && (
            <button type="button" className={`tab ${tab === "canvas" ? "on" : ""}`} onClick={() => setTab("canvas")}>
              ⊕ Canvas
              <span className="tab-count">{data.states?.length ?? 0}</span>
            </button>
          )}
          {!hasStates && screens.length > 0 && (
            <button type="button" className={`tab ${tab === "graph" ? "on" : ""}`} onClick={() => setTab("graph")}>
              ◆ Graph
            </button>
          )}
          {(runs.runs.length > 0 || (runs.baselineRunsCount ?? 0) > 0) && (
            <button type="button" className={`tab ${tab === "matrix" ? "on" : ""}`} onClick={() => setTab("matrix")}>
              ▦ Coverage matrix
              {runs.runs.length ? <span className="tab-count">{runs.runs.length} runs</span> : null}
            </button>
          )}
        </div>
        <div className="topbar-right">
          <RebuildButton />
          <button
            type="button"
            className="kbd-help-btn"
            onClick={() => setShowHelp((v) => !v)}
            title="Keyboard shortcuts"
          >
            ⌨ ?
          </button>
          <span className="badge">
            {hasStates
              ? `${data.states?.length} states · ${data.transitions?.length ?? 0} transitions · ${data.scenarios?.length ?? 0} scenarios`
              : `${screens.length} screens · ${edges.length} nav edges`
            }
            {data.roles?.length ? ` · ${data.roles.length} roles` : ""}
          </span>
        </div>
      </header>

      {tab === "graph" ? (
        <>
          <SitemapSidebar
            roles={data.roles ?? []}
            groups={data.groups ?? []}
            screens={screens}
            filteredScreens={filteredScreens}
            collapsedGroups={collapsedGroups}
            selectedId={selectedId}
            roleFilter={roleFilter}
            kindFilter={kindFilter}
            searchInputRef={searchInputRef}
            onSelectScreen={setSelectedId}
            onRoleFilter={(id) => setRoleFilter(id === roleFilter ? null : id)}
            onKindFilter={(k) => setKindFilter(k === kindFilter ? null : k)}
            onToggleGroup={toggleGroup}
          />

          <main className="canvas">
            <SitemapGraph
              screens={screens}
              edges={edges}
              groups={data.groups ?? []}
              roles={data.roles ?? []}
              visibleScreenIds={filteredIds}
              collapsedGroups={collapsedGroups}
              selectedId={selectedId}
              onSelect={setSelectedId}
              onFocusSearch={focusSearch}
              onClearSelection={clearSelection}
            />
          </main>

          <aside className="detail">
            <SitemapDetail
              screen={screens.find((s) => s.id === selectedId) ?? null}
              allScreens={screens}
              roles={data.roles ?? []}
              groups={data.groups ?? []}
              edges={edges}
              onJumpTo={setSelectedId}
            />
          </aside>
        </>
      ) : tab === "matrix" ? (
        <main className="canvas canvas-matrix">
          <CoverageMatrix screens={screens} runs={runs} />
        </main>
      ) : (
        <main className="canvas canvas-fullbleed">
          <StateCanvas doc={data} runs={runs} />
        </main>
      )}

      {showHelp ? (
        <div className="kbd-help" onClick={() => setShowHelp(false)}>
          <div className="kbd-help-card" onClick={(e) => e.stopPropagation()}>
            <div className="kbd-help-head">
              <h3>Keyboard shortcuts</h3>
              <button
                type="button"
                className="kbd-help-close"
                onClick={() => setShowHelp(false)}
              >
                ✕
              </button>
            </div>
            <ul>
              <li>
                <kbd>f</kbd>
                <span>Fit the whole sitemap to the canvas</span>
              </li>
              <li>
                <kbd>/</kbd>
                <span>Focus the screen search</span>
              </li>
              <li>
                <kbd>c</kbd>
                <span>Clear the current selection</span>
              </li>
              <li>
                <kbd>esc</kbd>
                <span>Clear selection / close this dialog</span>
              </li>
              <li>
                <kbd>↑</kbd> <kbd>↓</kbd> <kbd>←</kbd> <kbd>→</kbd>
                <span>Pan the canvas</span>
              </li>
              <li>
                <kbd>+</kbd> <kbd>−</kbd>
                <span>Zoom in / out</span>
              </li>
              <li>
                <kbd>?</kbd>
                <span>Show / hide this dialog</span>
              </li>
            </ul>
            <p className="kbd-help-hint">
              Two-finger trackpad scroll = pan. Pinch = zoom.
            </p>
          </div>
        </div>
      ) : null}
    </div>
  );
}

// ─── Rebuild-from-source button ──────────────────────────────
// POSTs to /_rebuild/<project> on flowchart.smartlaunchhub.com, streams
// log lines back via Server-Sent Events, reloads the page when done.
function RebuildButton() {
  const [state, setState] = useState<"idle" | "running" | "done" | "fail">("idle");
  const [logs, setLogs] = useState<string[]>([]);
  const [openLog, setOpenLog] = useState(false);

  if (typeof window === "undefined") return null;
  const onFlowchart = window.location.hostname.includes("flowchart.smartlaunchhub");
  if (!onFlowchart) return null;

  const slug = window.location.pathname.split("/").filter(Boolean)[0];
  if (!slug) return null;

  async function go() {
    setState("running");
    setLogs(["▶ POST /_rebuild/" + slug]);
    setOpenLog(true);
    try {
      const res = await fetch(`/_rebuild/${slug}`, { method: "POST" });
      if (!res.ok || !res.body) {
        setLogs((l) => [...l, `✕ HTTP ${res.status}`]);
        setState("fail");
        return;
      }
      // Parse SSE stream manually (EventSource doesn't support POST)
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const frames = buffer.split("\n\n");
        buffer = frames.pop() ?? "";
        for (const frame of frames) {
          const ev = /^event: (\w+)/.exec(frame);
          const data = /^data: (.*)$/m.exec(frame);
          if (!ev || !data) continue;
          let payload: any = {};
          try { payload = JSON.parse(data[1]); } catch { /* */ }
          if (ev[1] === "log" || ev[1] === "err") setLogs((l) => [...l, payload.line ?? ""]);
          else if (ev[1] === "step") setLogs((l) => [...l, "─── " + payload.cmd]);
          else if (ev[1] === "done") {
            setLogs((l) => [...l, `✓ done in ${Math.round((payload.ms ?? 0) / 100) / 10}s — reloading…`]);
            setState("done");
            setTimeout(() => window.location.reload(), 1500);
          } else if (ev[1] === "fail") {
            setLogs((l) => [...l, "✕ " + JSON.stringify(payload)]);
            setState("fail");
          }
        }
      }
    } catch (e: any) {
      setLogs((l) => [...l, "✕ " + String(e)]);
      setState("fail");
    }
  }

  return (
    <>
      <button
        type="button"
        className={`flowdoc-rebuild-btn ${state}`}
        onClick={state === "idle" ? go : () => setOpenLog((v) => !v)}
        title={state === "idle" ? `Re-scan + rebuild ${slug} from source` : "Show rebuild log"}
        disabled={state === "running"}
      >
        {state === "idle" && `↻ Rebuild ${slug}`}
        {state === "running" && `⟳ Rebuilding…`}
        {state === "done" && `✓ Rebuilt`}
        {state === "fail" && `✕ Failed (show log)`}
      </button>
      {openLog && (
        <div className="flowdoc-rebuild-log-panel" onClick={() => setOpenLog(false)}>
          <div className="flowdoc-rebuild-log" onClick={(e) => e.stopPropagation()}>
            <div className="flowdoc-rebuild-log-head">
              <b>Rebuild log · {slug}</b>
              <button type="button" onClick={() => setOpenLog(false)}>✕</button>
            </div>
            <pre>{logs.join("\n")}</pre>
          </div>
        </div>
      )}
    </>
  );
}
