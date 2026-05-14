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
import type { Flow, Package, Step } from "../../schema";

const NODE_WIDTH = 200;
const NODE_HEIGHT = 92;

type PkgNodeData = {
  pkg: Package;
  isActive: boolean;
  isDimmed: boolean;
};

function PackageNode({ data }: NodeProps<Node<PkgNodeData>>) {
  const { pkg, isActive, isDimmed } = data;
  const cls = [
    "pkg-node",
    isActive ? "is-active" : "",
    isDimmed ? "is-dimmed" : "",
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <div className={cls}>
      <Handle type="target" position={Position.Top} style={{ opacity: 0 }} />
      <Handle type="target" position={Position.Left} style={{ opacity: 0 }} />
      <div className="pkg-head">
        {pkg.icon ? <span className="pkg-icon">{pkg.icon}</span> : null}
        <span className="pkg-name">{pkg.name}</span>
      </div>
      <div className="pkg-kind">{pkg.kind}</div>
      {pkg.path ? <div className="pkg-path">{pkg.path}</div> : null}
      <Handle type="source" position={Position.Right} style={{ opacity: 0 }} />
      <Handle type="source" position={Position.Bottom} style={{ opacity: 0 }} />
    </div>
  );
}

const nodeTypes = { pkg: PackageNode };

function layoutNodes(packages: Package[], allEdges: Edge[]): Map<string, { x: number; y: number }> {
  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir: "LR", nodesep: 60, ranksep: 110 });
  g.setDefaultEdgeLabel(() => ({}));

  for (const pkg of packages) {
    g.setNode(pkg.id, { width: NODE_WIDTH, height: NODE_HEIGHT });
  }
  // Use a stable set of edges (e.g. union of all flow steps) so layout is consistent.
  const seen = new Set<string>();
  for (const e of allEdges) {
    const k = `${e.source}->${e.target}`;
    if (seen.has(k)) continue;
    seen.add(k);
    g.setEdge(e.source, e.target);
  }

  dagre.layout(g);

  const result = new Map<string, { x: number; y: number }>();
  for (const id of packages.map((p) => p.id)) {
    const n = g.node(id);
    if (!n) continue;
    result.set(id, { x: n.x - NODE_WIDTH / 2, y: n.y - NODE_HEIGHT / 2 });
  }
  return result;
}

interface Props {
  packages: Package[];
  activeFlow: Flow | null;
}

export function FlowGraph({ packages, activeFlow }: Props) {
  // Compute layout from the union of all step edges so the graph stays put as flows change.
  // The Step[] is intentionally synthetic here for layout only.
  const allEdgesForLayout = useMemo<Edge[]>(() => {
    return packages.flatMap((from) =>
      packages
        .filter((to) => to.id !== from.id)
        .slice(0, 2)
        .map((to) => ({
          id: `__layout__${from.id}->${to.id}`,
          source: from.id,
          target: to.id,
        }))
    );
  }, [packages]);

  const positions = useMemo(
    () => layoutNodes(packages, allEdgesForLayout),
    [packages, allEdgesForLayout]
  );

  const activePackageIds = useMemo<Set<string>>(() => {
    if (!activeFlow) return new Set(packages.map((p) => p.id));
    const ids = new Set<string>();
    for (const s of activeFlow.steps) {
      ids.add(s.from);
      ids.add(s.to);
    }
    return ids;
  }, [activeFlow, packages]);

  const initialNodes = useMemo<Node<PkgNodeData>[]>(() => {
    return packages.map((pkg) => {
      const pos = positions.get(pkg.id) ?? { x: 0, y: 0 };
      const isActive = activeFlow ? activePackageIds.has(pkg.id) : false;
      const isDimmed = !!activeFlow && !isActive;
      return {
        id: pkg.id,
        type: "pkg",
        position: pos,
        data: { pkg, isActive, isDimmed },
        draggable: true,
      };
    });
  }, [packages, positions, activeFlow, activePackageIds]);

  const initialEdges = useMemo<Edge[]>(() => {
    if (!activeFlow) return [];
    return activeFlow.steps.map((step: Step, idx: number) => ({
      id: `${activeFlow.id}-${idx}`,
      source: step.from,
      target: step.to,
      label: `${idx + 1}. ${step.label}`,
      labelStyle: { fontSize: 11, fontWeight: 600 },
      labelBgStyle: { fill: "#181f3d", fillOpacity: 0.9 },
      labelBgPadding: [6, 4] as [number, number],
      labelBgBorderRadius: 6,
      animated: true,
      className: "is-active",
      markerEnd: {
        type: MarkerType.ArrowClosed,
        color: "#7aa2ff",
        width: 18,
        height: 18,
      },
      style: { stroke: "#7aa2ff" },
    }));
  }, [activeFlow]);

  const [nodes, setNodes, onNodesChange] = useNodesState(initialNodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(initialEdges);

  // Sync when the active flow or layout changes.
  useEffect(() => {
    setNodes(initialNodes);
  }, [initialNodes, setNodes]);

  useEffect(() => {
    setEdges(initialEdges);
  }, [initialEdges, setEdges]);

  return (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      nodeTypes={nodeTypes}
      onNodesChange={onNodesChange}
      onEdgesChange={onEdgesChange}
      fitView
      fitViewOptions={{ padding: 0.2 }}
      proOptions={{ hideAttribution: true }}
      minZoom={0.3}
      maxZoom={1.8}
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
