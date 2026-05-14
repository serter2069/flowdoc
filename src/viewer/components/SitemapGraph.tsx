import { useMemo, useEffect, useCallback } from "react";
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  MarkerType,
  Position,
  useNodesState,
  useEdgesState,
  type Node,
  type Edge as RFEdge,
  type NodeProps,
  Handle,
} from "@xyflow/react";
import dagre from "dagre";
import type { Edge, Group, Role, Screen, ScreenKind } from "../../schema";

const NODE_WIDTH = 200;
const NODE_HEIGHT = 78;

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

const KIND_COLOR: Record<ScreenKind, string> = {
  tab: "#7aa2ff",
  drawer: "#a855f7",
  screen: "#9ca3af",
  modal: "#f59e0b",
  auth: "#ef4444",
  public: "#22c55e",
  nested: "#6b7280",
  external: "#0ea5e9",
};

type ScreenNodeData = {
  screen: Screen;
  group: Group | null;
  selected: boolean;
  dimmed: boolean;
  highlight: "outgoing" | "incoming" | null;
};

function ScreenNode({ data }: NodeProps<Node<ScreenNodeData>>) {
  const { screen, group, selected, dimmed, highlight } = data;
  const groupColor = group?.color ?? KIND_COLOR[screen.kind];
  const isModal = screen.kind === "modal";
  const className = [
    "site-node",
    `kind-${screen.kind}`,
    selected ? "is-selected" : "",
    dimmed ? "is-dimmed" : "",
    highlight === "outgoing" ? "is-outgoing" : "",
    highlight === "incoming" ? "is-incoming" : "",
    isModal ? "is-modal" : "",
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <div
      className={className}
      style={{
        borderColor: groupColor,
        boxShadow: selected
          ? `0 0 0 2px ${groupColor}, 0 6px 24px rgba(0,0,0,.45)`
          : `0 4px 14px rgba(0,0,0,.35)`,
      }}
    >
      <Handle type="target" position={Position.Top} style={{ opacity: 0 }} />
      <Handle type="target" position={Position.Left} style={{ opacity: 0 }} />
      <div className="site-node-head">
        <span className="site-node-icon" style={{ color: groupColor }}>
          {KIND_ICON[screen.kind] ?? "•"}
        </span>
        <span className="site-node-name">{screen.name}</span>
      </div>
      {screen.path ? <div className="site-node-path">{screen.path}</div> : null}
      <Handle type="source" position={Position.Right} style={{ opacity: 0 }} />
      <Handle type="source" position={Position.Bottom} style={{ opacity: 0 }} />
    </div>
  );
}

const nodeTypes = { screen: ScreenNode };

function layoutGraph(
  screens: Screen[],
  edges: Edge[]
): Map<string, { x: number; y: number }> {
  const g = new dagre.graphlib.Graph({ compound: true });
  g.setGraph({
    rankdir: "LR",
    nodesep: 28,
    ranksep: 90,
    marginx: 40,
    marginy: 40,
  });
  g.setDefaultEdgeLabel(() => ({}));

  for (const s of screens) {
    g.setNode(s.id, { width: NODE_WIDTH, height: NODE_HEIGHT });
  }
  for (const e of edges) {
    if (e.from === e.to) continue;
    g.setEdge(e.from, e.to);
  }
  dagre.layout(g);

  const result = new Map<string, { x: number; y: number }>();
  for (const s of screens) {
    const n = g.node(s.id);
    if (!n) continue;
    result.set(s.id, { x: n.x - NODE_WIDTH / 2, y: n.y - NODE_HEIGHT / 2 });
  }
  return result;
}

interface Props {
  screens: Screen[];
  edges: Edge[];
  groups: Group[];
  roles: Role[];
  visibleScreenIds: Set<string>;
  selectedId: string | null;
  onSelect: (id: string) => void;
}

export function SitemapGraph({
  screens,
  edges,
  groups,
  visibleScreenIds,
  selectedId,
  onSelect,
}: Props) {
  const groupsById = useMemo(() => new Map(groups.map((g) => [g.id, g])), [groups]);

  const positions = useMemo(() => layoutGraph(screens, edges), [screens, edges]);

  const outgoingFromSelected = useMemo<Set<string>>(() => {
    if (!selectedId) return new Set();
    return new Set(edges.filter((e) => e.from === selectedId).map((e) => e.to));
  }, [selectedId, edges]);

  const incomingToSelected = useMemo<Set<string>>(() => {
    if (!selectedId) return new Set();
    return new Set(edges.filter((e) => e.to === selectedId).map((e) => e.from));
  }, [selectedId, edges]);

  const initialNodes = useMemo<Node<ScreenNodeData>[]>(() => {
    return screens.map((screen) => {
      const pos = positions.get(screen.id) ?? { x: 0, y: 0 };
      const group = screen.group ? groupsById.get(screen.group) ?? null : null;
      const visible = visibleScreenIds.has(screen.id);
      const isSelected = screen.id === selectedId;
      const highlight: ScreenNodeData["highlight"] = outgoingFromSelected.has(screen.id)
        ? "outgoing"
        : incomingToSelected.has(screen.id)
          ? "incoming"
          : null;
      const dimmed =
        !visible ||
        (selectedId !== null &&
          !isSelected &&
          highlight === null);
      return {
        id: screen.id,
        type: "screen",
        position: pos,
        data: { screen, group, selected: isSelected, dimmed, highlight },
        draggable: true,
      };
    });
  }, [
    screens,
    positions,
    groupsById,
    visibleScreenIds,
    selectedId,
    outgoingFromSelected,
    incomingToSelected,
  ]);

  const initialEdges = useMemo<RFEdge[]>(() => {
    return edges.map((e, i) => {
      const isFromSelected = selectedId !== null && e.from === selectedId;
      const isToSelected = selectedId !== null && e.to === selectedId;
      const isFaded =
        selectedId !== null && !isFromSelected && !isToSelected;
      const source = screens.find((s) => s.id === e.from);
      const color =
        isFromSelected || isToSelected
          ? source?.group
            ? groupsById.get(source.group)?.color ?? "#7aa2ff"
            : "#7aa2ff"
          : "#2a335a";
      return {
        id: `${e.from}->${e.to}-${i}`,
        source: e.from,
        target: e.to,
        type: "default",
        animated: isFromSelected,
        label: e.label,
        labelStyle: { fontSize: 10, fontWeight: 600, fill: "#e5e9f5" },
        labelBgStyle: { fill: "#131a35", fillOpacity: 0.9 },
        labelBgPadding: [4, 3] as [number, number],
        labelBgBorderRadius: 4,
        markerEnd: {
          type: MarkerType.ArrowClosed,
          color,
          width: 14,
          height: 14,
        },
        style: {
          stroke: color,
          strokeWidth: isFromSelected || isToSelected ? 2 : 1,
          opacity: isFaded ? 0.18 : 1,
        },
      };
    });
  }, [edges, selectedId, screens, groupsById]);

  const [nodes, setNodes, onNodesChange] = useNodesState(initialNodes);
  const [rfEdges, setRfEdges, onEdgesChange] = useEdgesState(initialEdges);

  useEffect(() => {
    setNodes(initialNodes);
  }, [initialNodes, setNodes]);
  useEffect(() => {
    setRfEdges(initialEdges);
  }, [initialEdges, setRfEdges]);

  const handleNodeClick = useCallback(
    (_: React.MouseEvent, n: Node) => {
      onSelect(n.id);
    },
    [onSelect]
  );

  return (
    <ReactFlow
      nodes={nodes}
      edges={rfEdges}
      nodeTypes={nodeTypes}
      onNodesChange={onNodesChange}
      onEdgesChange={onEdgesChange}
      onNodeClick={handleNodeClick}
      fitView
      fitViewOptions={{ padding: 0.12 }}
      proOptions={{ hideAttribution: true }}
      minZoom={0.1}
      maxZoom={2}
    >
      <Background gap={24} size={1} color="#2a335a" />
      <Controls
        showInteractive={false}
        style={{
          background: "#131a35",
          border: "1px solid #2a335a",
          borderRadius: 8,
        }}
      />
      <MiniMap
        pannable
        zoomable
        nodeStrokeColor="#2a335a"
        nodeColor={(node) => {
          const data = (node.data as ScreenNodeData) ?? null;
          if (!data) return "#1f2748";
          if (data.group?.color) return data.group.color;
          return KIND_COLOR[data.screen.kind] ?? "#9ca3af";
        }}
        style={{
          background: "#131a35",
          border: "1px solid #2a335a",
          borderRadius: 8,
        }}
      />
    </ReactFlow>
  );
}
