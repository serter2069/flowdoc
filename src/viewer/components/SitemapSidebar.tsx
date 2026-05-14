import { useMemo, useState } from "react";
import type { Group, Role, Screen, ScreenKind } from "../../schema";

interface Props {
  roles: Role[];
  groups: Group[];
  screens: Screen[];
  filteredScreens: Screen[];
  selectedId: string | null;
  roleFilter: string | null;
  kindFilter: string | null;
  onSelectScreen: (id: string) => void;
  onRoleFilter: (id: string) => void;
  onKindFilter: (kind: string) => void;
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
  selectedId,
  roleFilter,
  kindFilter,
  onSelectScreen,
  onRoleFilter,
  onKindFilter,
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

  // Group screens by their `group` field, preserving group order; loose screens go in "Other"
  const grouped = useMemo(() => {
    const byGroup = new Map<string, Screen[]>();
    for (const g of groups) byGroup.set(g.id, []);
    for (const s of visible) {
      const key = s.group ?? "_other";
      if (!byGroup.has(key)) byGroup.set(key, []);
      byGroup.get(key)!.push(s);
    }
    // Drop empty groups in display order
    const out: { id: string; name: string; color?: string; items: Screen[] }[] = [];
    for (const g of groups) {
      const items = byGroup.get(g.id) ?? [];
      if (items.length) out.push({ id: g.id, name: g.name, color: g.color, items });
    }
    const other = byGroup.get("_other") ?? [];
    if (other.length) out.push({ id: "_other", name: "Other", items: other });
    return out;
  }, [groups, visible]);

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
          type="search"
          placeholder="Search screens…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>

      <div className="grouped-list">
        {grouped.map((g) => (
          <div key={g.id} className="group-block">
            <div
              className="group-head"
              style={{ ["--group-color" as string]: g.color ?? "var(--text-muted)" }}
            >
              {g.name}
              <span className="muted-count">{g.items.length}</span>
            </div>
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
          </div>
        ))}
        {grouped.length === 0 ? (
          <div className="empty-inline">No screens match.</div>
        ) : null}
      </div>
    </nav>
  );
}
