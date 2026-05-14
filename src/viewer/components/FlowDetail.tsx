import type { Flow, Package } from "../../schema";

interface Props {
  flow: Flow | null;
  packages: Package[];
}

function payloadString(p: unknown): string | null {
  if (p == null) return null;
  if (typeof p === "string") return p;
  try {
    return JSON.stringify(p, null, 2);
  } catch {
    return String(p);
  }
}

export function FlowDetail({ flow, packages }: Props) {
  const byId = new Map(packages.map((p) => [p.id, p]));

  if (!flow) {
    return <div className="empty">Pick a flow on the left.</div>;
  }

  return (
    <div>
      <h2>{flow.name}</h2>
      {flow.description ? <p className="desc">{flow.description}</p> : null}
      <ol className="steps">
        {flow.steps.map((step, idx) => {
          const from = byId.get(step.from);
          const to = byId.get(step.to);
          const payload = payloadString(step.payload);
          return (
            <li key={idx} className="step">
              <div className="head">
                <span className="num">{idx + 1}</span>
                <span>
                  {from?.icon ?? "•"} {from?.name ?? step.from}
                </span>
                <span className="arrow">→</span>
                <span>
                  {to?.icon ?? "•"} {to?.name ?? step.to}
                </span>
                {step.kind ? <span className="kind-chip">{step.kind}</span> : null}
              </div>
              <code className="label">{step.label}</code>
              {payload ? <pre className="payload">{payload}</pre> : null}
              {step.note ? <div className="note">{step.note}</div> : null}
            </li>
          );
        })}
      </ol>
    </div>
  );
}
