import type { Edge, Group, Role, Screen } from "../../schema";

interface Props {
  screen: Screen | null;
  allScreens: Screen[];
  roles: Role[];
  groups: Group[];
  edges: Edge[];
  onJumpTo: (id: string) => void;
}

const KIND_LABEL: Record<string, string> = {
  tab: "Tab",
  drawer: "Drawer",
  screen: "Screen",
  modal: "Modal",
  auth: "Auth",
  public: "Public",
  nested: "Nested",
  external: "External",
};

export function SitemapDetail({
  screen,
  allScreens,
  roles,
  groups,
  edges,
  onJumpTo,
}: Props) {
  if (!screen) {
    return (
      <div className="empty">
        Pick any screen on the left or click a node on the canvas.
      </div>
    );
  }

  const rolesById = new Map(roles.map((r) => [r.id, r]));
  const groupsById = new Map(groups.map((g) => [g.id, g]));
  const screensById = new Map(allScreens.map((s) => [s.id, s]));

  const outgoing = edges.filter((e) => e.from === screen.id);
  const incoming = edges.filter((e) => e.to === screen.id);
  const group = screen.group ? groupsById.get(screen.group) : null;

  return (
    <div>
      <h2>{screen.name}</h2>
      <div className="badges">
        <span className="kind-pill">{KIND_LABEL[screen.kind] ?? screen.kind}</span>
        {group ? (
          <span
            className="group-pill"
            style={{ ["--group-color" as string]: group.color ?? "var(--text-muted)" }}
          >
            {group.name}
          </span>
        ) : null}
        {screen.roles?.map((rid) => {
          const role = rolesById.get(rid);
          return (
            <span
              key={rid}
              className="role-pill"
              style={{ ["--role-color" as string]: role?.color ?? "var(--accent)" }}
            >
              {role?.icon ? `${role.icon} ` : ""}
              {role?.name ?? rid}
            </span>
          );
        })}
      </div>
      {screen.path ? <div className="path-line">{screen.path}</div> : null}
      {screen.description ? <p className="desc">{screen.description}</p> : null}

      {screen.components?.length ? (
        <>
          <div className="section-head">Components</div>
          <ul className="component-list">
            {screen.components.map((c) => (
              <li key={c}>{c}</li>
            ))}
          </ul>
        </>
      ) : null}

      {outgoing.length ? (
        <>
          <div className="section-head">
            Navigates to <span className="muted-count">{outgoing.length}</span>
          </div>
          <ul className="nav-list">
            {outgoing.map((e, i) => {
              const target = screensById.get(e.to);
              return (
                <li
                  key={`${e.to}-${i}`}
                  onClick={() => onJumpTo(e.to)}
                  title="Click to focus"
                >
                  <span className="arrow">→</span>
                  <span className="link-name">{target?.name ?? e.to}</span>
                  {target?.kind ? (
                    <span className="kind-mini">{KIND_LABEL[target.kind] ?? target.kind}</span>
                  ) : null}
                  {e.label ? <span className="link-label">{e.label}</span> : null}
                </li>
              );
            })}
          </ul>
        </>
      ) : null}

      {incoming.length ? (
        <>
          <div className="section-head">
            Reached from <span className="muted-count">{incoming.length}</span>
          </div>
          <ul className="nav-list">
            {incoming.map((e, i) => {
              const source = screensById.get(e.from);
              return (
                <li
                  key={`${e.from}-${i}`}
                  onClick={() => onJumpTo(e.from)}
                  title="Click to focus"
                >
                  <span className="arrow">←</span>
                  <span className="link-name">{source?.name ?? e.from}</span>
                  {source?.kind ? (
                    <span className="kind-mini">{KIND_LABEL[source.kind] ?? source.kind}</span>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </>
      ) : null}
    </div>
  );
}
