import type { Journey, Role, Screen } from "../../schema";

interface Props {
  journey: Journey | null;
  roles: Role[];
  screens: Screen[];
}

const KIND_LABEL: Record<string, string> = {
  tap: "tap",
  swipe: "swipe",
  fill: "fill",
  submit: "submit",
  open: "open",
  receive: "receive",
  view: "see",
  manual: "manual",
  wait: "wait",
  decision: "decision",
};

export function JourneyDetail({ journey, roles, screens }: Props) {
  const rolesById = new Map(roles.map((r) => [r.id, r]));
  const screensById = new Map(screens.map((s) => [s.id, s]));

  if (!journey) {
    return <div className="empty">Pick a journey on the left.</div>;
  }

  let previousActor: string | null = null;

  return (
    <div>
      <h2>{journey.name}</h2>
      {journey.description ? <p className="desc">{journey.description}</p> : null}
      <ol className="steps">
        {journey.steps.map((step, idx) => {
          const role = rolesById.get(step.actor);
          const onScreen = screensById.get(step.on);
          const toScreen = step.to ? screensById.get(step.to) : null;
          const handoff = previousActor !== null && previousActor !== step.actor;
          previousActor = step.actor;

          return (
            <li
              key={idx}
              className="step"
              style={{
                ["--role-color" as string]: role?.color ?? "var(--accent)",
              }}
            >
              {handoff ? (
                <div className="handoff">
                  ↓ handoff to {role?.icon ? `${role.icon} ` : ""}
                  {role?.name ?? step.actor}
                </div>
              ) : null}
              <div className="head">
                <span className="num">{idx + 1}</span>
                <span className="actor-badge">
                  {role?.icon ? <span>{role.icon}</span> : null}
                  {role?.name ?? step.actor}
                </span>
                {step.kind ? (
                  <span className="kind-chip">{KIND_LABEL[step.kind] ?? step.kind}</span>
                ) : null}
              </div>
              <div className="screen-row">
                <span className="screen-pill">
                  {onScreen?.name ?? step.on}
                  {onScreen?.path ? (
                    <span className="screen-path"> {onScreen.path}</span>
                  ) : null}
                </span>
                {toScreen ? (
                  <>
                    <span className="arrow">→</span>
                    <span className="screen-pill">
                      {toScreen.name ?? step.to}
                      {toScreen.path ? (
                        <span className="screen-path"> {toScreen.path}</span>
                      ) : null}
                    </span>
                  </>
                ) : null}
              </div>
              <div className="action">{step.action}</div>
              {step.server ? (
                <div className="server-chip">
                  <span className="server-icon">⇄</span>
                  <code>{step.server.label}</code>
                  {step.server.returns ? (
                    <span className="returns"> ⇢ {step.server.returns}</span>
                  ) : null}
                  {step.server.note ? (
                    <div className="server-note">{step.server.note}</div>
                  ) : null}
                </div>
              ) : null}
              {step.note ? <div className="note">{step.note}</div> : null}
            </li>
          );
        })}
      </ol>
    </div>
  );
}
