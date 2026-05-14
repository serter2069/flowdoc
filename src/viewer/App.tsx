import { useMemo, useState } from "react";
import type { FlowDoc, Journey } from "../schema";
import { JourneyGraph } from "./components/JourneyGraph";
import { JourneySidebar } from "./components/JourneySidebar";
import { JourneyDetail } from "./components/JourneyDetail";

export function App({ data }: { data: FlowDoc }) {
  const [activeRoleId, setActiveRoleId] = useState<string | null>(null);
  const [activeJourneyId, setActiveJourneyId] = useState<string | null>(
    data.journeys[0]?.id ?? null
  );

  const filteredJourneys = useMemo<Journey[]>(() => {
    if (!activeRoleId) return data.journeys;
    return data.journeys.filter((j) => {
      if (j.primaryActor === activeRoleId) return true;
      return j.steps.some((s) => s.actor === activeRoleId);
    });
  }, [data.journeys, activeRoleId]);

  const activeJourney = useMemo<Journey | null>(
    () => data.journeys.find((j) => j.id === activeJourneyId) ?? null,
    [activeJourneyId, data.journeys]
  );

  return (
    <div className="app">
      <header className="topbar">
        <div className="title">
          <h1>{data.title}</h1>
          {data.subtitle ? <span className="sub">{data.subtitle}</span> : null}
        </div>
        <span className="badge">
          {data.roles.length} roles · {data.screens.length} screens ·{" "}
          {data.journeys.length} journeys
        </span>
      </header>

      <JourneySidebar
        roles={data.roles}
        journeys={filteredJourneys}
        totalJourneys={data.journeys.length}
        activeRoleId={activeRoleId}
        activeJourneyId={activeJourneyId}
        onRoleSelect={(id) => {
          setActiveRoleId(id);
          // if the active journey doesn't include this role, pick the first one that does
          if (id && activeJourney && activeJourney.primaryActor !== id) {
            const first = data.journeys.find(
              (j) => j.primaryActor === id || j.steps.some((s) => s.actor === id)
            );
            if (first) setActiveJourneyId(first.id);
          }
        }}
        onJourneySelect={setActiveJourneyId}
      />

      <main className="canvas">
        <JourneyGraph
          screens={data.screens}
          roles={data.roles}
          activeJourney={activeJourney}
        />
        {activeJourney ? (
          <div className="flow-counter">
            {activeJourney.steps.length} step
            {activeJourney.steps.length === 1 ? "" : "s"} ·{" "}
            {new Set(activeJourney.steps.map((s) => s.actor)).size} actor
            {new Set(activeJourney.steps.map((s) => s.actor)).size === 1 ? "" : "s"}
          </div>
        ) : null}
      </main>

      <aside className="detail">
        <JourneyDetail
          journey={activeJourney}
          roles={data.roles}
          screens={data.screens}
        />
      </aside>
    </div>
  );
}
