import { useMemo, useState, type RefObject } from "react";
import type { Group, Role, Screen, ScreenKind } from "../../schema";

interface Props {
  roles: Role[];
  groups: Group[];
  screens: Screen[];
  filteredScreens: Screen[];
  collapsedGroups: Set<string>;
  selectedId: string | null;
  roleFilter: string | null;
  kindFilter: string | null;
  searchInputRef: RefObject<HTMLInputElement | null>;
  onSelectScreen: (id: string) => void;
  onRoleFilter: (id: string) => void;
  onKindFilter: (kind: string) => void;
  onToggleGroup: (id: string) => void;
}

const KIND_LABEL: Record<ScreenKind, string> = {
  tab: "Tab",
  drawer: "Drawer",
  screen: "Screen",
  modal: "Modal",
  auth: "Auth",
  public: "Public",
  nested: "Nested",
  external: "External",
};

const KIND_ICON: Record<ScreenKind, string> = {
  tab: "🗂",
  drawer: "📂",
  screen: "📱",
  modal: "🪟",
  auth: "🔐",
  public: "🌐",
  nested: "↳",
  external: "↗",
};

export function SitemapSidebar({
  roles,
  groups,
  screens,
  filteredScreens,
  collapsedGroups,
  selectedId,
  roleFilter,
  kindFilter,
  searchInputRef,
  onSelectScreen,
  onRoleFilter,
  onKindFilter,
  onToggleGroup,
}: Props) {
  const [query, setQuery] = useState("");

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return filteredScreens;
    return filteredScreens.filter((s) =>
      [s.name, s.id, s.path ?? "", s.description ?? "", ...(s.components ?? [])]
        .join(" ")
        .toLowerCase()
        .includes(q)
    );
  }, [filteredScreens, query]);

  // Build a per-group lookup of total screens (pre-filter) and visible screens (post-filter)
  const grouped = useMemo(() => {
    const totals = new Map<string, number>();
    for (const s of screens) {
      const key = s.group ?? "_other";
      totals.set(key, (totals.get(key) ?? 0) + 1);
    }
    const byGroup = new Map<string, Screen[]>();
    for (const s of visible) {
      const key = s.group ?? "_other";
      if (!byGroup.has(key)) byGroup.set(key, []);
      byGroup.get(key)!.push(s);
    }
    const out: {
      id: string;
      name: string;
      color?: string;
      total: number;
      items: Screen[];
    }[] = [];
    for (const g of groups) {
      const items = byGroup.get(g.id) ?? [];
      const total = totals.get(g.id) ?? 0;
      // show group even if collapsed (so user can re-expand) or has items
      if (total > 0) {
        out.push({ id: g.id, name: g.name, color: g.color, total, items });
      }
    }
    const otherTotal = totals.get("_other") ?? 0;
    const otherItems = byGroup.get("_other") ?? [];
    if (otherTotal > 0) {
      out.push({
        id: "_other",
        name: "Other",
        total: otherTotal,
        items: otherItems,
      });
    }
    return out;
  }, [groups, visible, screens]);

  const presentKinds = useMemo<ScreenKind[]>(() => {
    const set = new Set<ScreenKind>();
    for (const s of screens) set.add(s.kind);
    const order: ScreenKind[] = [
      "tab",
      "drawer",
      "screen",
      "modal",
      "auth",
      "public",
      "nested",
      "external",
    ];
    return order.filter((k) => set.has(k));
  }, [screens]);

  return (
    <nav className="sidebar">
      {roles.length ? (
        <>
          <div className="section">Filter by role</div>
          <div className="chips">
            {roles.map((r) => (
              <button
                key={r.id}
                type="button"
                className={`chip ${roleFilter === r.id ? "active" : ""}`}
                style={{ ["--chip-color" as string]: r.color ?? "var(--accent)" }}
                onClick={() => onRoleFilter(r.id)}
                title={r.description ?? r.name}
              >
                {r.icon ? <span className="chip-icon">{r.icon}</span> : null}
                {r.name}
              </button>
            ))}
          </div>
        </>
      ) : null}

      {presentKinds.length > 1 ? (
        <>
          <div className="section">Filter by kind</div>
          <div className="chips">
            {presentKinds.map((k) => (
              <button
                key={k}
                type="button"
                className={`chip kind-chip-filter ${kindFilter === k ? "active" : ""}`}
                onClick={() => onKindFilter(k)}
              >
                <span className="chip-icon">{KIND_ICON[k]}</span>
                {KIND_LABEL[k]}
              </button>
            ))}
          </div>
        </>
      ) : null}

      <div className="section">
        Screens
        <span className="muted-count">
          {visible.length}/{screens.length}
        </span>
      </div>
      <div className="search">
        <input
          ref={searchInputRef}
          type="search"
          placeholder="Search screens…  (press / to focus)"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>

      <div className="grouped-list">
        {grouped.map((g) => {
          const isCollapsed = collapsedGroups.has(g.id);
          return (
            <div key={g.id} className="group-block">
              <button
                type="button"
                className={`group-head ${isCollapsed ? "is-collapsed" : ""}`}
                style={{
                  ["--group-color" as string]: g.color ?? "var(--text-muted)",
                }}
                onClick={() => onToggleGroup(g.id)}
                title={isCollapsed ? "Expand group" : "Collapse group"}
              >
                <span className="chevron">{isCollapsed ? "▸" : "▾"}</span>
                <span className="group-head-name">{g.name}</span>
                <span className="muted-count">
                  {isCollapsed ? g.total : `${g.items.length}/${g.total}`}
                </span>
              </button>
              {!isCollapsed && g.items.length > 0 ? (
                <ul className="screen-list">
                  {g.items.map((s) => (
                    <li
                      key={s.id}
                      className={s.id === selectedId ? "active" : ""}
                      onClick={() => onSelectScreen(s.id)}
                    >
                      <span className="screen-row">
                        <span className="kind-glyph" title={KIND_LABEL[s.kind]}>
                          {KIND_ICON[s.kind]}
                        </span>
                        <span className="screen-row-name">{s.name}</span>
                      </span>
                      {s.path ? <span className="screen-row-path">{s.path}</span> : null}
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
          );
        })}
        {grouped.length === 0 ? (
          <div className="empty-inline">No screens match.</div>
        ) : null}
      </div>
    </nav>
  );
}
