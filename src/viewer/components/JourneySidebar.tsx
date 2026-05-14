import { useMemo, useState } from "react";
import type { Journey, Role } from "../../schema";

interface Props {
  roles: Role[];
  journeys: Journey[];
  totalJourneys: number;
  activeRoleId: string | null;
  activeJourneyId: string | null;
  onRoleSelect: (id: string | null) => void;
  onJourneySelect: (id: string) => void;
}

export function JourneySidebar({
  roles,
  journeys,
  totalJourneys,
  activeRoleId,
  activeJourneyId,
  onRoleSelect,
  onJourneySelect,
}: Props) {
  const [query, setQuery] = useState("");
  const rolesById = useMemo(() => new Map(roles.map((r) => [r.id, r])), [roles]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return journeys;
    return journeys.filter((j) =>
      [j.name, j.description ?? "", ...(j.tags ?? [])]
        .join(" ")
        .toLowerCase()
        .includes(q)
    );
  }, [journeys, query]);

  return (
    <nav className="sidebar">
      <div className="section">Roles</div>
      <div className="role-chips">
        <button
          type="button"
          className={`role-chip ${activeRoleId === null ? "active" : ""}`}
          onClick={() => onRoleSelect(null)}
        >
          <span className="role-icon">●</span>
          All ({totalJourneys})
        </button>
        {roles.map((r) => (
          <button
            key={r.id}
            type="button"
            className={`role-chip ${activeRoleId === r.id ? "active" : ""}`}
            style={{
              ["--role-color" as string]: r.color ?? "var(--accent)",
            }}
            onClick={() => onRoleSelect(activeRoleId === r.id ? null : r.id)}
            title={r.description ?? r.name}
          >
            {r.icon ? <span className="role-icon">{r.icon}</span> : null}
            {r.name}
          </button>
        ))}
      </div>

      <div className="section">Journeys</div>
      <div className="search">
        <input
          type="search"
          placeholder="Search journeys…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>
      <ul className="flow-list">
        {filtered.map((j) => {
          const primary = rolesById.get(j.primaryActor);
          return (
            <li
              key={j.id}
              className={j.id === activeJourneyId ? "active" : ""}
              onClick={() => onJourneySelect(j.id)}
              style={{
                ["--role-color" as string]: primary?.color ?? "var(--accent)",
              }}
            >
              <span className="name">
                {primary?.icon ? (
                  <span className="role-icon-inline">{primary.icon}</span>
                ) : null}
                {j.name}
              </span>
              {j.description ? <span className="desc">{j.description}</span> : null}
              {j.tags?.length ? (
                <div className="tags">
                  {j.tags.map((t) => (
                    <span key={t} className="tag">
                      {t}
                    </span>
                  ))}
                </div>
              ) : null}
            </li>
          );
        })}
        {filtered.length === 0 ? (
          <li style={{ cursor: "default", color: "var(--text-muted)" }}>
            <span className="desc">No journeys match.</span>
          </li>
        ) : null}
      </ul>
    </nav>
  );
}
