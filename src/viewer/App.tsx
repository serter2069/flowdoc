import { useCallback, useMemo, useRef, useState } from "react";
import type { FlowDoc, Screen } from "../schema";
import { collectEdges } from "../schema";
import { SitemapGraph } from "./components/SitemapGraph";
import { SitemapSidebar } from "./components/SitemapSidebar";
import { SitemapDetail } from "./components/SitemapDetail";

export function App({ data }: { data: FlowDoc }) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [roleFilter, setRoleFilter] = useState<string | null>(null);
  const [kindFilter, setKindFilter] = useState<string | null>(null);
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());
  const [showHelp, setShowHelp] = useState(false);

  const searchInputRef = useRef<HTMLInputElement | null>(null);

  const filteredScreens = useMemo<Screen[]>(() => {
    return data.screens.filter((s) => {
      if (kindFilter && s.kind !== kindFilter) return false;
      if (roleFilter) {
        if (!s.roles?.includes(roleFilter) && !s.roles?.includes("all")) {
          return false;
        }
      }
      if (s.group && collapsedGroups.has(s.group)) return false;
      return true;
    });
  }, [data.screens, roleFilter, kindFilter, collapsedGroups]);

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
    <div className="app">
      <header className="topbar">
        <div className="title">
          <h1>{data.title}</h1>
          {data.subtitle ? <span className="sub">{data.subtitle}</span> : null}
        </div>
        <div className="topbar-right">
          <button
            type="button"
            className="kbd-help-btn"
            onClick={() => setShowHelp((v) => !v)}
            title="Keyboard shortcuts"
          >
            ⌨ ?
          </button>
          <span className="badge">
            {data.screens.length} screens · {edges.length} nav edges
            {data.roles?.length ? ` · ${data.roles.length} roles` : ""}
          </span>
        </div>
      </header>

      <SitemapSidebar
        roles={data.roles ?? []}
        groups={data.groups ?? []}
        screens={data.screens}
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
          screens={data.screens}
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
          screen={data.screens.find((s) => s.id === selectedId) ?? null}
          allScreens={data.screens}
          roles={data.roles ?? []}
          groups={data.groups ?? []}
          edges={edges}
          onJumpTo={setSelectedId}
        />
      </aside>

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
