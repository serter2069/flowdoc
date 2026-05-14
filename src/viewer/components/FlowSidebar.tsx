import { useMemo, useState } from "react";
import type { Flow } from "../../schema";

interface Props {
  flows: Flow[];
  activeFlowId: string | null;
  onSelect: (id: string) => void;
}

export function FlowSidebar({ flows, activeFlowId, onSelect }: Props) {
  const [query, setQuery] = useState("");

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return flows;
    return flows.filter((f) => {
      const haystack = [f.name, f.description ?? "", ...(f.tags ?? [])]
        .join(" ")
        .toLowerCase();
      return haystack.includes(q);
    });
  }, [flows, query]);

  return (
    <nav className="sidebar">
      <div className="section">Flows</div>
      <div className="search">
        <input
          type="search"
          placeholder="Search flows…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>
      <ul className="flow-list">
        {filtered.map((f) => (
          <li
            key={f.id}
            className={f.id === activeFlowId ? "active" : ""}
            onClick={() => onSelect(f.id)}
          >
            <span className="name">{f.name}</span>
            {f.description ? <span className="desc">{f.description}</span> : null}
            {f.tags?.length ? (
              <div className="tags">
                {f.tags.map((t) => (
                  <span key={t} className="tag">
                    {t}
                  </span>
                ))}
              </div>
            ) : null}
          </li>
        ))}
        {filtered.length === 0 ? (
          <li style={{ cursor: "default", color: "var(--text-muted)" }}>
            <span className="desc">No flows match "{query}".</span>
          </li>
        ) : null}
      </ul>
    </nav>
  );
}
