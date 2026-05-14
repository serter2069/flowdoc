import { useMemo, useEffect } from "react";
import {
  ReactFlow,
  Background,
  Controls,
  MarkerType,
  Position,
  useNodesState,
  useEdgesState,
  type Node,
  type Edge,
  type NodeProps,
  Handle,
} from "@xyflow/react";
import dagre from "dagre";
import type { Journey, Role, Screen, Step } from "../../schema";

const NODE_WIDTH = 200;
const NODE_HEIGHT = 84;

const SCREEN_KIND_ICON: Record<string, string> = {
  screen: "📱",
  modal: "🪟",
  tab: "📑",
  drawer: "📂",
  external: "🌐",
  email: "✉️",
  web: "🌍",
  "out-of-band": "💬",
};

type ScreenNodeData = {
  screen: Screen;
  role: Role | null;
  index: number;
};

function ScreenNode({ data }: NodeProps<Node<ScreenNodeData>>) {
  const { screen, role, index } = data;
  const accent = role?.color ?? "#7aa2ff";
  return (
    <div
      className="screen-node"
      style={{
        borderColor: accent,
        boxShadow: `0 0 0 2px ${accent}33`,
      }}
    >
      <Handle type="target" position={Position.Left} style={{ opacity: 0 }} />
      <div className="screen-head">
        <span className="screen-step-num" style={{ background: accent }}>
          {index}
        </span>
        <span className="screen-kind">
          {SCREEN_KIND_ICON[screen.kind] ?? "•"}
        </span>
        <span className="screen-name">{screen.name}</span>
      </div>
      {screen.path ? <div className="screen-pathline">{screen.path}</div> : null}
      {role ? (
        <div className="screen-actor" style={{ color: accent }}>
          {role.icon ? `${role.icon} ` : ""}
          {role.name}
        </div>
      ) : null}
      <Handle type="source" position={Position.Right} style={{ opacity: 0 }} />
    </div>
  );
}

const nodeTypes = { screen: ScreenNode };

/**
 * Build the ordered list of (screen, role-at-that-step) tuples for an active journey.
 * The order matters — it's also used to lay the graph out left-to-right.
 */
function orderedScreensForJourney(
  steps: Step[]
): Array<{ id: string; role: string; firstStepIdx: number }> {
  const out: Array<{ id: string; role: string; firstStepIdx: number }> = [];
  const seen = new Set<string>();
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    if (!seen.has(s.on)) {
      seen.add(s.on);
      out.push({ id: s.on, role: s.actor, firstStepIdx: i });
    }
    if (s.to && !seen.has(s.to)) {
      seen.add(s.to);
      out.push({ id: s.to, role: s.actor, firstStepIdx: i });
    }
  }
  return out;
}

function layoutNodes(
  ordered: Array<{ id: string }>,
  edges: Edge[]
): Map<string, { x: number; y: number }> {
  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir: "LR", nodesep: 50, ranksep: 90, marginx: 20, marginy: 20 });
  g.setDefaultEdgeLabel(() => ({}));

  for (const s of ordered) {
    g.setNode(s.id, { width: NODE_WIDTH, height: NODE_HEIGHT });
  }
  for (const e of edges) {
    g.setEdge(e.source, e.target);
  }
  dagre.layout(g);

  const result = new Map<string, { x: number; y: number }>();
  for (const s of ordered) {
    const n = g.node(s.id);
    if (!n) continue;
    result.set(s.id, { x: n.x - NODE_WIDTH / 2, y: n.y - NODE_HEIGHT / 2 });
  }
  return result;
}

interface Props {
  screens: Screen[];
  roles: Role[];
  activeJourney: Journey | null;
}

export function JourneyGraph({ screens, roles, activeJourney }: Props) {
  const screensById = useMemo(() => new Map(screens.map((s) => [s.id, s])), [screens]);
  const rolesById = useMemo(() => new Map(roles.map((r) => [r.id, r])), [roles]);

  const ordered = useMemo(
    () => (activeJourney ? orderedScreensForJourney(activeJourney.steps) : []),
    [activeJourney]
  );

  const initialEdges = useMemo<Edge[]>(() => {
    if (!activeJourney) return [];
    return activeJourney.steps
      .map((step: Step, idx: number) => {
        if (!step.to || step.to === step.on) return null;
        const role = rolesById.get(step.actor);
        const accent = role?.color ?? "#7aa2ff";
        const labelParts: string[] = [];
        if (step.kind && step.kind !== "tap") labelParts.push(`[${step.kind}]`);
        else labelParts.push("›");
        labelParts.push(step.action);
        const label = `${idx + 1}. ${labelParts.join(" ")}`;
        return {
          id: `${activeJourney.id}-${idx}`,
          source: step.on,
          target: step.to,
          label,
          labelStyle: { fontSize: 11, fontWeight: 600, fill: "#e5e9f5" },
          labelBgStyle: { fill: "#181f3d", fillOpacity: 0.95 },
          labelBgPadding: [6, 4] as [number, number],
          labelBgBorderRadius: 6,
          animated: true,
          markerEnd: {
            type: MarkerType.ArrowClosed,
            color: accent,
            width: 18,
            height: 18,
          },
          style: { stroke: accent, strokeWidth: 2 },
          data: { hasServer: !!step.server },
        } as Edge;
      })
      .filter((e): e is Edge => e !== null);
  }, [activeJourney, rolesById]);

  const positions = useMemo(() => layoutNodes(ordered, initialEdges), [ordered, initialEdges]);

  const initialNodes = useMemo<Node<ScreenNodeData>[]>(() => {
    return ordered.map((entry, i) => {
      const screen = screensById.get(entry.id);
      if (!screen) {
        return {
          id: entry.id,
          type: "screen",
          position: positions.get(entry.id) ?? { x: i * 240, y: 0 },
          data: {
            screen: { id: entry.id, name: entry.id, kind: "screen" } as Screen,
            role: null,
            index: i + 1,
          },
        };
      }
      const role = rolesById.get(entry.role) ?? null;
      return {
        id: entry.id,
        type: "screen",
        position: positions.get(entry.id) ?? { x: i * 240, y: 0 },
        data: { screen, role, index: i + 1 },
        draggable: true,
      };
    });
  }, [ordered, positions, screensById, rolesById]);

  const [nodes, setNodes, onNodesChange] = useNodesState(initialNodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(initialEdges);

  useEffect(() => {
    setNodes(initialNodes);
  }, [initialNodes, setNodes]);
  useEffect(() => {
    setEdges(initialEdges);
  }, [initialEdges, setEdges]);

  if (!activeJourney) {
    return <div className="empty">Pick a journey on the left.</div>;
  }

  return (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      nodeTypes={nodeTypes}
      onNodesChange={onNodesChange}
      onEdgesChange={onEdgesChange}
      fitView
      fitViewOptions={{ padding: 0.18 }}
      proOptions={{ hideAttribution: true }}
      minZoom={0.3}
      maxZoom={1.6}
    >
      <Background gap={20} size={1} color="#2a335a" />
      <Controls
        showInteractive={false}
        style={{
          background: "#131a35",
          border: "1px solid #2a335a",
          borderRadius: 8,
        }}
      />
    </ReactFlow>
  );
}
