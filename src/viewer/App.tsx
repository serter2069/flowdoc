import { useMemo, useState } from "react";
import type { FlowDoc, Screen } from "../schema";
import { collectEdges } from "../schema";
import { SitemapGraph } from "./components/SitemapGraph";
import { SitemapSidebar } from "./components/SitemapSidebar";
import { SitemapDetail } from "./components/SitemapDetail";

export function App({ data }: { data: FlowDoc }) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [roleFilter, setRoleFilter] = useState<string | null>(null);
  const [kindFilter, setKindFilter] = useState<string | null>(null);

  const filteredScreens = useMemo<Screen[]>(() => {
    return data.screens.filter((s) => {
      if (kindFilter && s.kind !== kindFilter) return false;
      if (roleFilter) {
        if (!s.roles?.includes(roleFilter) && !s.roles?.includes("all")) {
          return false;
        }
      }
      return true;
    });
  }, [data.screens, roleFilter, kindFilter]);

  const edges = useMemo(() => collectEdges(data), [data]);

  const filteredIds = useMemo(
    () => new Set(filteredScreens.map((s) => s.id)),
    [filteredScreens]
  );

  return (
    <div className="app">
      <header className="topbar">
        <div className="title">
          <h1>{data.title}</h1>
          {data.subtitle ? <span className="sub">{data.subtitle}</span> : null}
        </div>
        <span className="badge">
          {data.screens.length} screens · {edges.length} nav edges
          {data.roles?.length ? ` · ${data.roles.length} roles` : ""}
        </span>
      </header>

      <SitemapSidebar
        roles={data.roles ?? []}
        groups={data.groups ?? []}
        screens={data.screens}
        filteredScreens={filteredScreens}
        selectedId={selectedId}
        roleFilter={roleFilter}
        kindFilter={kindFilter}
        onSelectScreen={setSelectedId}
        onRoleFilter={(id) => setRoleFilter(id === roleFilter ? null : id)}
        onKindFilter={(k) => setKindFilter(k === kindFilter ? null : k)}
      />

      <main className="canvas">
        <SitemapGraph
          screens={data.screens}
          edges={edges}
          groups={data.groups ?? []}
          roles={data.roles ?? []}
          visibleScreenIds={filteredIds}
          selectedId={selectedId}
          onSelect={setSelectedId}
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
    </div>
  );
}
