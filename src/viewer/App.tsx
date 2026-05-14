import { useMemo, useState } from "react";
import type { Flow, FlowDoc } from "../schema";
import { FlowGraph } from "./components/FlowGraph";
import { FlowSidebar } from "./components/FlowSidebar";
import { FlowDetail } from "./components/FlowDetail";

export function App({ data }: { data: FlowDoc }) {
  const [activeFlowId, setActiveFlowId] = useState<string | null>(
    data.flows[0]?.id ?? null
  );

  const activeFlow = useMemo<Flow | null>(
    () => data.flows.find((f) => f.id === activeFlowId) ?? null,
    [activeFlowId, data.flows]
  );

  return (
    <div className="app">
      <header className="topbar">
        <div className="title">
          <h1>{data.title}</h1>
          {data.subtitle ? <span className="sub">{data.subtitle}</span> : null}
        </div>
        <span className="badge">
          {data.packages.length} packages · {data.flows.length} flows
        </span>
      </header>

      <FlowSidebar
        flows={data.flows}
        activeFlowId={activeFlowId}
        onSelect={setActiveFlowId}
      />

      <main className="canvas">
        <FlowGraph packages={data.packages} activeFlow={activeFlow} />
        {activeFlow ? (
          <div className="flow-counter">
            {activeFlow.steps.length} step{activeFlow.steps.length === 1 ? "" : "s"} ·{" "}
            {new Set(activeFlow.steps.flatMap((s) => [s.from, s.to])).size} packages
          </div>
        ) : null}
      </main>

      <aside className="detail">
        <FlowDetail flow={activeFlow} packages={data.packages} />
      </aside>
    </div>
  );
}
