import { useMemo, useEffect, useCallback } from "react";
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  Controls,
  MiniMap,
  MarkerType,
  Position,
  useNodesState,
  useEdgesState,
  useReactFlow,
  type Node,
  type Edge as RFEdge,
  type NodeProps,
  Handle,
} from "@xyflow/react";
import dagre from "dagre";
import type { Edge, Group, Role, Screen, ScreenKind } from "../../schema";

const NODE_WIDTH = 200;
const NODE_HEIGHT = 78;
const GROUP_PAD_X = 24;
const GROUP_PAD_Y = 36; // extra room for the group label at the top
const GROUP_PAD_BOTTOM = 16;

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

type GroupNodeData = {
  group: Group;
  count: number;
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

function GroupNode({ data }: NodeProps<Node<GroupNodeData>>) {
  const { group, count } = data;
  const color = group.color ?? "rgba(255,255,255,0.4)";
  return (
    <div
      className="group-cluster"
      style={{
        borderColor: color,
        background: `linear-gradient(180deg, ${color}18 0%, ${color}08 30%, transparent 100%)`,
      }}
    >
      <div
        className="group-cluster-label"
        style={{
          color: "#0b1020",
          background: color,
          borderColor: color,
        }}
      >
        {group.name}
        <span className="group-cluster-count">{count}</span>
      </div>
    </div>
  );
}

const nodeTypes = { screen: ScreenNode, group: GroupNode };

function layoutGraph(
  screens: Screen[],
  edges: Edge[]
): Map<string, { x: number; y: number }> {
  const g = new dagre.graphlib.Graph();
  g.setGraph({
    rankdir: "LR",
    nodesep: 30,
    ranksep: 120,
    marginx: 60,
    marginy: 60,
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
  collapsedGroups: Set<string>;
  selectedId: string | null;
  onSelect: (id: string) => void;
  onFocusSearch: () => void;
  onClearSelection: () => void;
}

function GraphInner({
  screens,
  edges,
  groups,
  visibleScreenIds,
  collapsedGroups,
  selectedId,
  onSelect,
  onFocusSearch,
  onClearSelection,
}: Props) {
  const groupsById = useMemo(() => new Map(groups.map((g) => [g.id, g])), [groups]);

  // Layout uses ALL screens so the absolute positions stay consistent across
  // role/kind filters or group collapse — only visibility flips.
  const positions = useMemo(() => layoutGraph(screens, edges), [screens, edges]);

  const groupCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const s of screens) {
      if (s.group && groupsById.has(s.group)) {
        counts.set(s.group, (counts.get(s.group) ?? 0) + 1);
      }
    }
    return counts;
  }, [screens, groupsById]);

  // For each group, compute the bounding box of all its screens (in absolute coords).
  const groupBoxes = useMemo(() => {
    const acc = new Map<
      string,
      { minX: number; minY: number; maxX: number; maxY: number }
    >();
    for (const s of screens) {
      if (!s.group || !groupsById.has(s.group)) continue;
      const pos = positions.get(s.id);
      if (!pos) continue;
      const cur = acc.get(s.group);
      const x1 = pos.x;
      const y1 = pos.y;
      const x2 = pos.x + NODE_WIDTH;
      const y2 = pos.y + NODE_HEIGHT;
      if (!cur) {
        acc.set(s.group, { minX: x1, minY: y1, maxX: x2, maxY: y2 });
      } else {
        cur.minX = Math.min(cur.minX, x1);
        cur.minY = Math.min(cur.minY, y1);
        cur.maxX = Math.max(cur.maxX, x2);
        cur.maxY = Math.max(cur.maxY, y2);
      }
    }
    return acc;
  }, [screens, positions, groupsById]);

  const outgoingFromSelected = useMemo<Set<string>>(() => {
    if (!selectedId) return new Set();
    return new Set(edges.filter((e) => e.from === selectedId).map((e) => e.to));
  }, [selectedId, edges]);

  const incomingToSelected = useMemo<Set<string>>(() => {
    if (!selectedId) return new Set();
    return new Set(edges.filter((e) => e.to === selectedId).map((e) => e.from));
  }, [selectedId, edges]);

  const initialNodes = useMemo<Node[]>(() => {
    const out: Node[] = [];

    // 1. Group cluster nodes (drawn first so they're behind screens)
    for (const g of groups) {
      const box = groupBoxes.get(g.id);
      if (!box) continue;
      const collapsed = collapsedGroups.has(g.id);
      const width = box.maxX - box.minX + GROUP_PAD_X * 2;
      const height = box.maxY - box.minY + GROUP_PAD_Y + GROUP_PAD_BOTTOM;
      out.push({
        id: `__group__${g.id}`,
        type: "group",
        position: { x: box.minX - GROUP_PAD_X, y: box.minY - GROUP_PAD_Y },
        data: { group: g, count: groupCounts.get(g.id) ?? 0 },
        draggable: false,
        selectable: false,
        focusable: false,
        zIndex: -10,
        hidden: collapsed,
        style: {
          width,
          height,
          background: "transparent",
          border: "none",
          padding: 0,
        },
      });
    }

    // 2. Screen nodes
    for (const screen of screens) {
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
        (selectedId !== null && !isSelected && highlight === null);
      out.push({
        id: screen.id,
        type: "screen",
        position: pos,
        data: { screen, group, selected: isSelected, dimmed, highlight },
        draggable: true,
        zIndex: 1,
        hidden: !visible,
      });
    }
    return out;
  }, [
    screens,
    groups,
    positions,
    groupsById,
    visibleScreenIds,
    collapsedGroups,
    selectedId,
    outgoingFromSelected,
    incomingToSelected,
    groupBoxes,
    groupCounts,
  ]);

  const initialEdges = useMemo<RFEdge[]>(() => {
    return edges.map((e, i) => {
      const isFromSelected = selectedId !== null && e.from === selectedId;
      const isToSelected = selectedId !== null && e.to === selectedId;
      const isFaded = selectedId !== null && !isFromSelected && !isToSelected;
      const source = screens.find((s) => s.id === e.from);
      const color =
        isFromSelected || isToSelected
          ? source?.group
            ? groupsById.get(source.group)?.color ?? "#7aa2ff"
            : "#7aa2ff"
          : "#2a335a";
      const eitherEndHidden =
        !visibleScreenIds.has(e.from) || !visibleScreenIds.has(e.to);
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
        hidden: eitherEndHidden,
      };
    });
  }, [edges, selectedId, screens, groupsById, visibleScreenIds]);

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
      if (n.type === "group") return;
      onSelect(n.id);
    },
    [onSelect]
  );

  const rf = useReactFlow();

  // Keyboard shortcuts
  useEffect(() => {
    const isTypingTarget = (target: EventTarget | null) => {
      if (!(target instanceof HTMLElement)) return false;
      const tag = target.tagName;
      return tag === "INPUT" || tag === "TEXTAREA" || target.isContentEditable;
    };

    const handler = (e: KeyboardEvent) => {
      // / focuses the search even if you're not in an input — but if you ARE in
      // an input, "/" should type as normal.
      if (e.key === "/" && !isTypingTarget(e.target)) {
        e.preventDefault();
        onFocusSearch();
        return;
      }
      // The remaining shortcuts are inert while typing.
      if (isTypingTarget(e.target)) {
        if (e.key === "Escape") (e.target as HTMLInputElement).blur();
        return;
      }
      switch (e.key) {
        case "f":
        case "F":
          e.preventDefault();
          rf.fitView({ padding: 0.12, duration: 280 });
          break;
        case "c":
        case "C":
        case "Escape":
          onClearSelection();
          break;
        case "+":
        case "=":
          rf.zoomIn({ duration: 200 });
          break;
        case "-":
        case "_":
          rf.zoomOut({ duration: 200 });
          break;
        case "ArrowUp":
          e.preventDefault();
          rf.setViewport(
            (() => {
              const v = rf.getViewport();
              return { ...v, y: v.y + 80 };
            })(),
            { duration: 120 }
          );
          break;
        case "ArrowDown":
          e.preventDefault();
          rf.setViewport(
            (() => {
              const v = rf.getViewport();
              return { ...v, y: v.y - 80 };
            })(),
            { duration: 120 }
          );
          break;
        case "ArrowLeft":
          e.preventDefault();
          rf.setViewport(
            (() => {
              const v = rf.getViewport();
              return { ...v, x: v.x + 80 };
            })(),
            { duration: 120 }
          );
          break;
        case "ArrowRight":
          e.preventDefault();
          rf.setViewport(
            (() => {
              const v = rf.getViewport();
              return { ...v, x: v.x - 80 };
            })(),
            { duration: 120 }
          );
          break;
      }
    };

    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [rf, onFocusSearch, onClearSelection]);

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
      panOnScroll
      panOnScrollMode={"free" as never}
      panOnScrollSpeed={0.6}
      zoomOnScroll={false}
      zoomOnPinch
      zoomOnDoubleClick={false}
      panOnDrag
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
          if (node.type === "group") {
            const data = (node.data as GroupNodeData) ?? null;
            return data?.group.color ?? "#1f2748";
          }
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

export function SitemapGraph(props: Props) {
  return (
    <ReactFlowProvider>
      <GraphInner {...props} />
    </ReactFlowProvider>
  );
}
