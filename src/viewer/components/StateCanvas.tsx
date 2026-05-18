import { useEffect, useMemo, useRef, useState } from "react";
import type { FlowDoc, State, StateKind } from "../../schema";
import type { RunsData, RunStatus } from "../runs";
import { ScenariosSidebar } from "./ScenariosList";

const KIND_GLYPH: Record<StateKind, string> = {
  page: "P", state: "·", modal: "M", error: "!", success: "✓",
  effect: "⚡", email: "✉", push: "📱", api: "⇄", db: "▤", webhook: "🌐", condition: "?",
};

const COL_W = 340, ROW_H = 180, PAD_X = 40, PAD_Y = 60, CARD_W = 280, CARD_H = 130;
const ROLE_HEX: Record<string, string> = {
  anon: "#64748b", client: "#c026d3", worker: "#ea580c",
  dispatcher: "#16a34a", manager: "#2563eb", admin: "#9333ea", any: "#94a3b8",
};
const ALL_PLATFORMS = ["web-desktop", "web-mobile", "ios", "android"] as const;
type Platform = typeof ALL_PLATFORMS[number];
const PLAT_SHORT: Record<Platform, string> = { "web-desktop": "Desktop", "web-mobile": "Mobile", ios: "iOS", android: "Android" };
void PLAT_SHORT;

interface StateCanvasProps {
  doc: FlowDoc;
  runs: RunsData;
  onPositionsChange?: (positions: Record<number, { x: number; y: number }>) => void;
}

function statusForState(stateNum: number, doc: FlowDoc, runs: RunsData): Record<Platform, RunStatus> {
  const stateMeta = doc.states?.find((s) => s.num === stateNum);
  const fallback: Record<Platform, RunStatus> = { "web-desktop": "untested", "web-mobile": "untested", ios: "untested", android: "untested" };
  if (!stateMeta) return fallback;
  // Coverage = if any scenario containing this state has a recorded run, take that status.
  const scenariosTouchingState = (doc.scenarios ?? []).filter((sc) => sc.path.includes(stateNum));
  if (!scenariosTouchingState.length) return fallback;
  for (const p of ALL_PLATFORMS) {
    let worst: RunStatus = "untested";
    for (const sc of scenariosTouchingState) {
      const r = runs.byScreen?.[sc.id]?.[p];
      if (!r) continue;
      if (r.status === "fail") { worst = "fail" as RunStatus; break; }
      if (r.status === "pass") worst = "pass";
    }
    fallback[p] = worst;
  }
  return fallback;
}

function cardClass(kind: StateKind): string {
  return `flowdoc-card flowdoc-card-${kind}`;
}

function platDotClass(s: RunStatus): string {
  return `flowdoc-plat flowdoc-plat-${s}`;
}

function defaultPositionFor(s: State): { x: number; y: number } {
  if (s.position) return s.position;
  const col = s.col ?? 0, row = s.row ?? 0;
  return { x: PAD_X + col * COL_W, y: PAD_Y + row * ROW_H };
}

function bezierPath(from: { x: number; y: number; w: number; h: number }, to: { x: number; y: number; w: number; h: number }) {
  let x1, y1, x2, y2;
  if (to.x > from.x + from.w / 2) { x1 = from.x + from.w; y1 = from.y + from.h / 2; x2 = to.x; y2 = to.y + to.h / 2; }
  else if (to.x < from.x - from.w / 2) { x1 = from.x; y1 = from.y + from.h / 2; x2 = to.x + to.w; y2 = to.y + to.h / 2; }
  else if (to.y > from.y) { x1 = from.x + from.w / 2; y1 = from.y + from.h; x2 = to.x + to.w / 2; y2 = to.y; }
  else { x1 = from.x + from.w / 2; y1 = from.y; x2 = to.x + to.w / 2; y2 = to.y + to.h; }
  const dx = x2 - x1;
  const sign = dx >= 0 ? 1 : -1;
  const c1x = x1 + sign * 40, c1y = y1;
  const c2x = x2 - sign * 40, c2y = y2;
  return { d: `M ${x1} ${y1} C ${c1x} ${c1y}, ${c2x} ${c2y}, ${x2} ${y2}`, mx: (x1 + x2) / 2, my: (y1 + y2) / 2 };
}

export function StateCanvas({ doc, runs, onPositionsChange }: StateCanvasProps) {
  const states = doc.states ?? [];
  const transitions = doc.transitions ?? [];
  const scenarios = doc.scenarios ?? [];
  const stateByNum = useMemo(() => Object.fromEntries(states.map((s) => [s.num, s])), [states]);

  const [positions, setPositions] = useState<Record<number, { x: number; y: number }>>(() => {
    const init: Record<number, { x: number; y: number }> = {};
    for (const s of states) init[s.num] = defaultPositionFor(s);
    return init;
  });
  const [selectedNums, setSelectedNums] = useState<Set<number>>(new Set());
  const [marquee, setMarquee] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const marqueeRef = useRef<{ startWX: number; startWY: number; additive: boolean } | null>(null);
  const [detailsNum, setDetailsNum] = useState<number | null>(null);
  const [activeScenarioIds, setActiveScenarioIds] = useState<Set<string>>(new Set());
  const [filterMode, setFilterMode] = useState<"all" | "untested" | "fail" | "pass">("all");
  const [query, setQuery] = useState("");
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [sidebarOpen, setSidebarOpen] = useState(true);
  // Single-active id derived from set (for legacy single-scenario UI like the sequence bar)
  const activeScenarioId = activeScenarioIds.size === 1 ? [...activeScenarioIds][0] : "";

  function toggleScenario(id: string, additive: boolean) {
    let nextIds: Set<string>;
    setActiveScenarioIds((prev) => {
      if (id === "") { nextIds = new Set(); return new Set(); }
      if (!additive) {
        if (prev.size === 1 && prev.has(id)) { nextIds = new Set(); return new Set(); }
        nextIds = new Set([id]);
        return nextIds;
      }
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      nextIds = next;
      return next;
    });
    setOverlayRole(null);
    // "Straighten up" — auto-fit camera to the union of selected scenarios'
    // paths so the user sees the full chain at maximum legibility.
    setTimeout(() => fitToScenarios(nextIds), 80);
  }

  function fitToScenarios(ids: Set<string>) {
    if (ids.size === 0) return;
    const el = scrollRef.current;
    if (!el) return;
    const nums = new Set<number>();
    for (const sc of scenarios) if (ids.has(sc.id)) for (const n of sc.path) nums.add(n);
    if (nums.size === 0) return;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const n of nums) {
      const p = positions[n] ?? defaultPositionFor(states.find((s) => s.num === n)!);
      minX = Math.min(minX, p.x);
      minY = Math.min(minY, p.y);
      maxX = Math.max(maxX, p.x + CARD_W);
      maxY = Math.max(maxY, p.y + CARD_H);
    }
    if (!isFinite(minX)) return;
    const w = maxX - minX, h = maxY - minY;
    const fitW = (el.clientWidth - 120) / w;
    const fitH = (el.clientHeight - 120) / h;
    const z = Math.min(1.2, Math.max(0.15, Math.min(fitW, fitH)));
    const newPan = {
      x: el.clientWidth / 2 - (minX + w / 2) * z,
      y: el.clientHeight / 2 - (minY + h / 2) * z,
    };
    zoomRef.current = z;
    panRef.current = newPan;
    setZoom(z);
    setPan(newPan);
  }

  // Drag state
  // dragRef.origPositions = snapshot of every selected card's start position
  // so we can move the whole group by the same delta.
  const dragRef = useRef<{
    leadNum: number;
    startX: number;
    startY: number;
    origPositions: Map<number, { x: number; y: number }>;
    moved: boolean;
  } | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  // Camera-based pan + zoom — same model as diagrams.love / Figma / reactflow.
  // Container is overflow:hidden, we apply a single CSS transform
  // `translate(pan.x, pan.y) scale(zoom)` to canvas-inner. ONE source of truth,
  // no scrollbar race condition, no jitter.
  //
  //   Plain wheel        → zoom around cursor
  //   Shift+wheel        → pan (horiz/vert via deltaX/deltaY)
  //   Trackpad pinch     → zoom (browser fires wheel with ctrlKey for pinch)
  //   Two-finger scroll  → pan (deltaX dominates OR shift held)
  //   Space + drag       → pan
  // Always-current refs so consecutive fast wheel events compound correctly
  // without waiting for React to commit between them.
  const zoomRef = useRef(zoom); zoomRef.current = zoom;
  const panRef = useRef(pan); panRef.current = pan;
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    function onWheel(e: WheelEvent) {
      e.preventDefault();
      // diagrams.love / Figma / Miro convention:
      //   Trackpad two-finger scroll (plain wheel) → PAN viewport
      //   Trackpad pinch (browsers fire wheel + ctrlKey for pinch) → ZOOM
      //   Cmd/Ctrl + wheel (mouse) → ZOOM (manual modifier path)
      //   Shift + wheel → also ZOOM (Windows-trackpad fallback)
      // Sergey's complaint: plain vertical scroll was zooming; on a trackpad
      // that's wrong — it should move the viewport like every other web canvas.
      const isZoom = e.ctrlKey || e.metaKey || e.shiftKey;
      if (!isZoom) {
        // PAN: translate camera by negative wheel delta. Works for both
        // vertical mouse wheel and trackpad two-finger swipe.
        const next = { x: panRef.current.x - e.deltaX, y: panRef.current.y - e.deltaY };
        panRef.current = next;
        setPan(next);
        return;
      }
      // ZOOM around cursor
      const rect = el!.getBoundingClientRect();
      const cx = e.clientX - rect.left;
      const cy = e.clientY - rect.top;
      // Pinch sends ctrlKey + tiny deltaY (a few units per event). Mouse wheel
      // sends bigger deltaY (100+ per notch). Normalize so pinch feels
      // responsive without making mouse wheel rocket past the zoom bounds.
      const deltaUnits = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
      const clamped = Math.max(-100, Math.min(100, deltaUnits));
      const factor = Math.exp(-clamped * 0.01);  // 4x faster than before
      const z0 = zoomRef.current;
      const newZoom = Math.min(3, Math.max(0.05, z0 * factor));
      // Pan adjustment so cursor stays anchored to same world point
      const scale = newZoom / z0;
      const p0 = panRef.current;
      const newPan = { x: cx - (cx - p0.x) * scale, y: cy - (cy - p0.y) * scale };
      zoomRef.current = newZoom;
      panRef.current = newPan;
      setZoom(newZoom);
      setPan(newPan);
    }
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  // Keyboard zoom: +/-, 0 = reset. Space-held = pan mode.
  const spaceDown = useRef(false);
  const spaceDragRef = useRef<{ startX: number; startY: number; origPanX: number; origPanY: number } | null>(null);
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      const target = e.target as HTMLElement;
      const inField = target && (target.tagName === "INPUT" || target.tagName === "SELECT" || target.tagName === "TEXTAREA");
      if (!inField && e.code === "Space") {
        e.preventDefault();
        spaceDown.current = true;
        if (scrollRef.current) scrollRef.current.style.cursor = "grab";
      }
      if (inField) return;
      if (e.key === "+" || e.key === "=") { e.preventDefault(); setZoom((z) => Math.min(3, z * 1.25)); }
      else if (e.key === "-" || e.key === "_") { e.preventDefault(); setZoom((z) => Math.max(0.1, z / 1.25)); }
      else if (e.key === "0") { e.preventDefault(); setZoom(1); }
      else if (e.key === "f") { e.preventDefault(); fitToView(); }
    }
    function onKeyUp(e: KeyboardEvent) {
      if (e.code === "Space") {
        spaceDown.current = false;
        if (scrollRef.current) scrollRef.current.style.cursor = "";
      }
    }
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Mouse drag-to-pan when space is held OR middle mouse button
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    function onMouseDown(e: MouseEvent) {
      if (!el) return;
      const isMiddle = e.button === 1;
      if (!spaceDown.current && !isMiddle) return;
      e.preventDefault();
      spaceDragRef.current = {
        startX: e.clientX, startY: e.clientY,
        origPanX: panRef.current.x, origPanY: panRef.current.y,
      };
      el.style.cursor = "grabbing";
    }
    function onMouseMove(e: MouseEvent) {
      if (!el || !spaceDragRef.current) return;
      const dx = e.clientX - spaceDragRef.current.startX;
      const dy = e.clientY - spaceDragRef.current.startY;
      const next = { x: spaceDragRef.current.origPanX + dx, y: spaceDragRef.current.origPanY + dy };
      panRef.current = next;
      setPan(next);
    }
    function onMouseUp() {
      if (!el) return;
      spaceDragRef.current = null;
      el.style.cursor = spaceDown.current ? "grab" : "";
    }
    el.addEventListener("mousedown", onMouseDown);
    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
    return () => {
      el.removeEventListener("mousedown", onMouseDown);
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
    };
  }, []);

  // Auto-fit on first mount so 100+ states render visible instead of just the top-left card
  const didInitialFit = useRef(false);
  useEffect(() => {
    if (didInitialFit.current) return;
    if (states.length === 0) return;
    const t = setTimeout(() => {
      fitToView();
      didInitialFit.current = true;
    }, 100);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [states.length]);

  function fitToView() {
    const el = scrollRef.current;
    if (!el || states.length === 0) return;
    let maxX = 0, maxY = 0, minX = Infinity, minY = Infinity;
    for (const s of states) {
      const p = positions[s.num] ?? defaultPositionFor(s);
      maxX = Math.max(maxX, p.x + CARD_W);
      maxY = Math.max(maxY, p.y + CARD_H);
      minX = Math.min(minX, p.x);
      minY = Math.min(minY, p.y);
    }
    if (!isFinite(minX)) return;
    const graphW = maxX - minX, graphH = maxY - minY;
    const fitW = (el.clientWidth - 80) / graphW;
    const fitH = (el.clientHeight - 80) / graphH;
    const z = Math.min(1.0, Math.max(0.1, Math.min(fitW, fitH)));
    // Center the graph in the viewport via the camera (no scroll, no race).
    //   We want world point (minX + graphW/2, minY + graphH/2) to land at the
    //   viewport center. With transform translate(pan) scale(z), a world point
    //   wx maps to screen x = wx * z + pan.x. Solve for pan:
    //     pan.x = viewportCenterX - (minX + graphW/2) * z
    const newPan = {
      x: el.clientWidth / 2 - (minX + graphW / 2) * z,
      y: el.clientHeight / 2 - (minY + graphH / 2) * z,
    };
    zoomRef.current = z;
    panRef.current = newPan;
    setZoom(z);
    setPan(newPan);
  }

  useEffect(() => {
    function move(e: MouseEvent) {
      // 1. Card-group drag
      if (dragRef.current) {
        const d = dragRef.current;
        const dx = (e.clientX - d.startX) / zoom;
        const dy = (e.clientY - d.startY) / zoom;
        if (Math.abs(dx) > 3 || Math.abs(dy) > 3) d.moved = true;
        if (d.moved) {
          setPositions((p) => {
            const next = { ...p };
            for (const [num, orig] of d.origPositions) {
              next[num] = { x: orig.x + dx, y: orig.y + dy };
            }
            return next;
          });
        }
        return;
      }
      // 2. Rubber-band marquee
      if (marqueeRef.current) {
        const el = scrollRef.current;
        if (!el) return;
        const rect = el.getBoundingClientRect();
        // Screen→world: world = (screen - pan) / zoom
        const wx = (e.clientX - rect.left - panRef.current.x) / zoomRef.current;
        const wy = (e.clientY - rect.top - panRef.current.y) / zoomRef.current;
        const { startWX, startWY } = marqueeRef.current;
        setMarquee({
          x: Math.min(startWX, wx),
          y: Math.min(startWY, wy),
          w: Math.abs(wx - startWX),
          h: Math.abs(wy - startWY),
        });
      }
    }
    function up(e: MouseEvent) {
      if (dragRef.current) {
        const d = dragRef.current;
        if (!d.moved) {
          // Click without drag = select
          const additive = e.shiftKey || e.metaKey || e.ctrlKey;
          setSelectedNums((prev) => {
            if (additive) {
              const next = new Set(prev);
              if (next.has(d.leadNum)) next.delete(d.leadNum);
              else next.add(d.leadNum);
              return next;
            }
            return new Set([d.leadNum]);
          });
          const hit = scenarios.find((sc) => sc.path.includes(d.leadNum));
          if (hit && !additive) setActiveScenarioIds(new Set([hit.id]));
        } else {
          onPositionsChange?.(positions);
        }
        dragRef.current = null;
        return;
      }
      // End marquee → compute selection
      if (marqueeRef.current && marquee) {
        const additive = marqueeRef.current.additive;
        const hits = new Set<number>();
        for (const s of states) {
          const p = positions[s.num] ?? defaultPositionFor(s);
          if (p.x + CARD_W >= marquee.x && p.x <= marquee.x + marquee.w &&
              p.y + CARD_H >= marquee.y && p.y <= marquee.y + marquee.h) {
            hits.add(s.num);
          }
        }
        setSelectedNums((prev) => {
          if (!additive) return hits;
          const next = new Set(prev);
          for (const n of hits) next.add(n);
          return next;
        });
        marqueeRef.current = null;
        setMarquee(null);
      }
    }
    document.addEventListener("mousemove", move);
    document.addEventListener("mouseup", up);
    return () => {
      document.removeEventListener("mousemove", move);
      document.removeEventListener("mouseup", up);
    };
  }, [scenarios, positions, onPositionsChange, zoom, marquee, states]);

  function startDrag(num: number, e: React.MouseEvent) {
    if (e.button !== 0) return;
    if (spaceDown.current) return;        // space-pan takes precedence
    // Lock: when a scenario is active, only cards on that path are draggable.
    // Stops accidental drags on neighbours while user is studying a path.
    if (activeScenariosList.length > 0 && !cardsInScenario.has(num)) {
      e.preventDefault();
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    // If the clicked card is already in the selection, drag the WHOLE selection.
    // Otherwise, select just this card (additive if shift/meta held) and drag it.
    const additive = e.shiftKey || e.metaKey || e.ctrlKey;
    let groupNums: Set<number>;
    if (selectedNums.has(num)) {
      groupNums = selectedNums;
    } else if (additive) {
      groupNums = new Set([...selectedNums, num]);
      setSelectedNums(groupNums);
    } else {
      groupNums = new Set([num]);
      setSelectedNums(groupNums);
    }
    const origPositions = new Map<number, { x: number; y: number }>();
    for (const n of groupNums) {
      const p = positions[n] ?? defaultPositionFor(states.find((s) => s.num === n)!);
      origPositions.set(n, { x: p.x, y: p.y });
    }
    dragRef.current = { leadNum: num, startX: e.clientX, startY: e.clientY, origPositions, moved: false };
  }

  function startMarquee(e: React.MouseEvent) {
    // Only trigger on canvas background (not on a card) with plain click (not space-pan, not middle-click)
    if (e.button !== 0) return;
    if (spaceDown.current) return;
    if ((e.target as HTMLElement).closest(".flowdoc-card")) return;
    const el = scrollRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const wx = (e.clientX - rect.left - panRef.current.x) / zoomRef.current;
    const wy = (e.clientY - rect.top - panRef.current.y) / zoomRef.current;
    marqueeRef.current = { startWX: wx, startWY: wy, additive: e.shiftKey || e.metaKey || e.ctrlKey };
    setMarquee({ x: wx, y: wy, w: 0, h: 0 });
    if (!(e.shiftKey || e.metaKey || e.ctrlKey)) setSelectedNums(new Set());
  }

  // Union of states/edges across ALL active scenarios. Each scenario also gets a
  // distinct palette color so multi-selecting "BookingDetail" and "WorkerPayouts"
  // shows two coloured paths on the canvas at once.
  const MULTI_PALETTE = ["#2563eb", "#ea580c", "#16a34a", "#dc2626", "#9333ea", "#0891b2", "#ca8a04", "#db2777"];
  const activeScenariosList = useMemo(() => scenarios.filter((s) => activeScenarioIds.has(s.id)), [scenarios, activeScenarioIds]);
  const scenarioColor = useMemo(() => {
    const m = new Map<string, string>();
    activeScenariosList.forEach((s, i) => m.set(s.id, MULTI_PALETTE[i % MULTI_PALETTE.length]));
    return m;
  }, [activeScenariosList]);
  const cardsInScenario = useMemo(() => {
    const s = new Set<number>();
    for (const sc of activeScenariosList) for (const n of sc.path) s.add(n);
    return s;
  }, [activeScenariosList]);
  const edgesInScenario = useMemo(() => {
    const s = new Set<string>();
    for (const sc of activeScenariosList) for (let i = 0; i < sc.path.length - 1; i++) s.add(`${sc.path[i]}→${sc.path[i + 1]}`);
    return s;
  }, [activeScenariosList]);
  // Per-edge color when multiple scenarios are active: edge picks the color of
  // the FIRST scenario in the active list that contains it (good enough for
  // visual distinction; conflicting edges still render).
  const edgeColor = useMemo(() => {
    const m = new Map<string, string>();
    for (const sc of activeScenariosList) {
      const col = scenarioColor.get(sc.id) ?? "#2563eb";
      for (let i = 0; i < sc.path.length - 1; i++) {
        const k = `${sc.path[i]}→${sc.path[i + 1]}`;
        if (!m.has(k)) m.set(k, col);
      }
    }
    return m;
  }, [activeScenariosList, scenarioColor]);

  function visible(s: State): boolean {
    if (query) {
      const hay = `${s.title} ${s.path ?? ""} ${(s.roles ?? []).join(" ")} ${s.kind} #${s.num}`.toLowerCase();
      if (!hay.includes(query.toLowerCase())) return false;
    }
    if (filterMode === "all") return true;
    const plats = statusForState(s.num, doc, runs);
    const vals = Object.values(plats);
    if (filterMode === "untested") return vals.every((v) => v === "untested");
    if (filterMode === "fail") return vals.some((v) => v === "fail");
    if (filterMode === "pass") return vals.some((v) => v === "pass");
    return true;
  }

  // Canvas is intentionally 3× the graph's bounding box on every side so users
  // can pan into empty space freely (Miro/Figma feel). With a minimum of 6000×4000
  // the inner surface holds the entire graph centered plus huge breathing room.
  const canvasSize = useMemo(() => {
    let maxX = 1200, maxY = 700, minX = Infinity, minY = Infinity;
    for (const s of states) {
      const p = positions[s.num] ?? defaultPositionFor(s);
      maxX = Math.max(maxX, p.x + CARD_W);
      maxY = Math.max(maxY, p.y + CARD_H);
      minX = Math.min(minX, p.x);
      minY = Math.min(minY, p.y);
    }
    if (!isFinite(minX)) { minX = 0; minY = 0; }
    const graphW = maxX - minX, graphH = maxY - minY;
    const width = Math.max(6000, maxX + graphW * 2);
    const height = Math.max(4000, maxY + graphH * 2);
    return { width, height };
  }, [states, positions]);

  const activeScenario = scenarios.find((s) => s.id === activeScenarioId);

  // Role-overlay: when a role is picked from the role-pill row, every scenario
  // with that role contributes its path edges to a coloured overlay so the user
  // sees ALL paths that role can take through the app at once.
  const [overlayRole, setOverlayRole] = useState<string | null>(null);
  const roleScenarios = useMemo(() => {
    if (!overlayRole) return [];
    return scenarios.filter((s) => (s.role ?? "any") === overlayRole);
  }, [overlayRole, scenarios]);
  const roleScenarioEdges = useMemo(() => {
    const set = new Set<string>();
    for (const sc of roleScenarios) {
      for (let i = 0; i < sc.path.length - 1; i++) {
        set.add(`${sc.path[i]}→${sc.path[i + 1]}`);
      }
    }
    return set;
  }, [roleScenarios]);
  const roleScenarioStates = useMemo(() => {
    const set = new Set<number>();
    for (const sc of roleScenarios) for (const n of sc.path) set.add(n);
    return set;
  }, [roleScenarios]);

  return (
    <div className={`flowdoc-canvas-root ${sidebarOpen ? "with-sidebar" : ""}`}>
      <div className="flowdoc-canvas-toolbar">
        <button
          type="button"
          className="flowdoc-sidebar-toggle"
          onClick={() => setSidebarOpen((v) => !v)}
          title={sidebarOpen ? "Hide scenarios sidebar" : "Show scenarios sidebar"}
        >
          {sidebarOpen ? "⟨" : "⟩"} {scenarios.length}
        </button>
        <input
          className="flowdoc-search"
          placeholder="Filter (state, path, role, #num)…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        {(["all", "untested", "fail", "pass"] as const).map((f) => (
          <button key={f} type="button" className={`flowdoc-chip ${filterMode === f ? "on" : ""}`} onClick={() => setFilterMode(f)}>{f}</button>
        ))}
        <div className="flowdoc-spacer" />
        {selectedNums.size > 0 && (
          <span className="flowdoc-multi-info">
            {selectedNums.size} card{selectedNums.size > 1 ? "s" : ""} selected ·{" "}
            <button type="button" className="flowdoc-chip" onClick={() => setSelectedNums(new Set())}>deselect</button>
          </span>
        )}
        {activeScenarioIds.size > 0 && (
          <span className="flowdoc-multi-info" title={[...activeScenarioIds].join(", ")}>
            {activeScenarioIds.size} scenario{activeScenarioIds.size > 1 ? "s" : ""} ·{" "}
            <button type="button" className="flowdoc-chip" onClick={() => setActiveScenarioIds(new Set())}>clear</button>
          </span>
        )}
        {overlayRole && (
          <span className="flowdoc-multi-info">
            role overlay: <b style={{ color: ROLE_HEX[overlayRole] ?? "#475569" }}>{overlayRole}</b> ·{" "}
            <button type="button" className="flowdoc-chip" onClick={() => setOverlayRole(null)}>clear</button>
          </span>
        )}
        <div className="flowdoc-zoom-controls">
          <button type="button" onClick={() => setZoom((z) => Math.max(0.15, z / 1.25))} title="Zoom out (Cmd/Ctrl/Shift + scroll · pinch · keyboard −)">−</button>
          <span className="flowdoc-zoom-pct" title="Current zoom">{Math.round(zoom * 100)}%</span>
          <button type="button" onClick={() => setZoom((z) => Math.min(3, z * 1.25))} title="Zoom in (Cmd/Ctrl/Shift + scroll · pinch · keyboard +)">+</button>
          <button type="button" onClick={() => setZoom(1)} title="Reset zoom to 100%">1:1</button>
          <button type="button" onClick={fitToView} title="Fit all cards to viewport">Fit</button>
        </div>
        <button
          type="button"
          className="flowdoc-reset"
          title="Snap all cards back to the BFS tree layout from flows.json"
          onClick={() => {
            const init: Record<number, { x: number; y: number }> = {};
            for (const s of states) {
              if (s.position) init[s.num] = { ...s.position };
              else init[s.num] = defaultPositionFor(s);
            }
            setPositions(init);
            onPositionsChange?.(init);
            setSelectedNums(new Set());
            setTimeout(() => fitToView(), 50);
          }}
        >↺ Reset layout</button>
      </div>

      <div className="flowdoc-canvas-body">
        {sidebarOpen && (
          <ScenariosSidebar
            doc={doc}
            runs={runs}
            activeScenarioIds={activeScenarioIds}
            overlayRole={overlayRole}
            onSelect={toggleScenario}
            onSelectRole={(role) => { setOverlayRole(overlayRole === role ? null : role); setActiveScenarioIds(new Set()); }}
            scenarioColor={scenarioColor}
          />
        )}
        <div className="flowdoc-canvas-scroll" ref={scrollRef} style={{ overflow: "hidden", position: "relative" } as React.CSSProperties}>
        <div className="flowdoc-canvas" style={{
          width: "100%",
          height: "100%",
          position: "absolute",
          inset: 0,
        }}>
        <div className="flowdoc-canvas-inner" style={{
          width: canvasSize.width,
          height: canvasSize.height,
          transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
          transformOrigin: "0 0",
          position: "absolute",
          left: 0, top: 0,
          willChange: "transform",
        }} onMouseDown={startMarquee}>
          <svg className="flowdoc-edges" width={canvasSize.width} height={canvasSize.height}>
            <defs>
              <marker id="arr" viewBox="0 0 10 10" refX={9} refY={5} markerWidth={6} markerHeight={6} orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="#94a3b8" /></marker>
              <marker id="arr-blue" viewBox="0 0 10 10" refX={9} refY={5} markerWidth={6} markerHeight={6} orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="#2563eb" /></marker>
              <marker id="arr-orange" viewBox="0 0 10 10" refX={9} refY={5} markerWidth={6} markerHeight={6} orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="#d97706" /></marker>
              <marker id="arr-red" viewBox="0 0 10 10" refX={9} refY={5} markerWidth={6} markerHeight={6} orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="#dc2626" /></marker>
              <marker id="arr-overlay-anon" viewBox="0 0 10 10" refX={9} refY={5} markerWidth={6} markerHeight={6} orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="#64748b" /></marker>
              <marker id="arr-overlay-client" viewBox="0 0 10 10" refX={9} refY={5} markerWidth={6} markerHeight={6} orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="#c026d3" /></marker>
              <marker id="arr-overlay-worker" viewBox="0 0 10 10" refX={9} refY={5} markerWidth={6} markerHeight={6} orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="#ea580c" /></marker>
              <marker id="arr-overlay-manager" viewBox="0 0 10 10" refX={9} refY={5} markerWidth={6} markerHeight={6} orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="#2563eb" /></marker>
              <marker id="arr-overlay-admin" viewBox="0 0 10 10" refX={9} refY={5} markerWidth={6} markerHeight={6} orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="#9333ea" /></marker>
            </defs>
            {transitions.map((t, i) => {
              const a = stateByNum[t.from], b = stateByNum[t.to];
              if (!a || !b || !visible(a as State) || !visible(b as State)) return null;
              const ap = { ...(positions[a.num] ?? defaultPositionFor(a as State)), w: CARD_W, h: CARD_H };
              const bp = { ...(positions[b.num] ?? defaultPositionFor(b as State)), w: CARD_W, h: CARD_H };
              const { d, mx, my } = bezierPath(ap, bp);
              const edgeKey = `${t.from}→${t.to}`;
              const inScen = edgesInScenario.has(edgeKey);
              const multiColor = edgeColor.get(edgeKey);
              const inOverlay = roleScenarioEdges.has(edgeKey);
              // Synthetic edges (tab-bar / login-as / submit-booking) are scaffold,
              // not real navigation — render faintly so the real graph reads clearly.
              const isSynthetic = /^(tab-bar|login as|visit \/login|client lands|submit booking|manager sees)/.test(t.label ?? "");
              const dimmed = (overlayRole && !inOverlay) || (activeScenariosList.length > 0 && !inScen);
              const cls = `${inScen ? "in-scenario" : t.fail ? "fail" : t.cond ? "cond" : ""} ${inOverlay ? `overlay-${overlayRole}` : ""} ${dimmed ? "dimmed" : ""} ${isSynthetic && !inScen && !inOverlay ? "synthetic" : ""}`.trim();
              const marker = inOverlay ? `url(#arr-overlay-${overlayRole})` : inScen ? "url(#arr-blue)" : t.fail ? "url(#arr-red)" : t.cond ? "url(#arr-orange)" : "url(#arr)";
              const label = (t.label || "") + (t.cond ? ` (${t.cond})` : "");
              const shown = label.length > 40 ? label.slice(0, 38) + "…" : label;
              const inlineStyle = multiColor ? { stroke: multiColor, strokeWidth: 2.5, opacity: 0.95 } : undefined;
              return (
                <g key={i} className={dimmed ? "edge-dimmed" : ""}>
                  <path d={d} className={cls} markerEnd={marker} style={inlineStyle} />
                  {label && !dimmed && <text x={mx} y={my - 4} textAnchor="middle" className={t.cond ? "cond" : ""}>{shown}</text>}
                </g>
              );
            })}
          </svg>

          {states.filter(visible).map((s) => {
            const p = positions[s.num] ?? defaultPositionFor(s);
            const status = statusForState(s.num, doc, runs);
            const sel = selectedNums.has(s.num);
            const inScen = cardsInScenario.has(s.num);
            const inOverlay = roleScenarioStates.has(s.num);
            const cardDimmed = (overlayRole && !inOverlay) || (activeScenariosList.length > 0 && !inScen);
            return (
              <div
                key={s.num}
                className={`${cardClass(s.kind)} ${sel ? "selected" : ""} ${inScen ? "in-scenario" : ""} ${inOverlay ? `overlay-on overlay-${overlayRole}` : ""} ${cardDimmed ? "card-dimmed" : ""}`}
                style={{ left: p.x, top: p.y }}
                onMouseDown={(e) => startDrag(s.num, e)}
                onDoubleClick={(e) => { e.stopPropagation(); setDetailsNum(s.num); }}
                title={s.desc || `${s.title} — double-click for details`}
              >
                <div className="flowdoc-card-rolebar" title={`Roles: ${(s.roles ?? ["any"]).join(", ")}`}>
                  {(s.roles ?? ["any"]).map((r) => (
                    <div key={r} className={`flowdoc-role-stripe flowdoc-role-stripe-${r}`}>
                      <span className="flowdoc-role-stripe-text">{r}</span>
                    </div>
                  ))}
                </div>
                <div className="flowdoc-card-body">
                <div className="flowdoc-card-num">#{s.num}</div>
                <div className="flowdoc-card-kind">{s.kind.toUpperCase()} <span className="flowdoc-card-glyph">{KIND_GLYPH[s.kind]}</span></div>
                <div className="flowdoc-card-title">{s.title}</div>
                {s.path && <div className="flowdoc-card-path">{s.path}</div>}
                {Object.values(status).some((v) => v !== "untested") && (
                  <div className="flowdoc-card-plats">
                    {ALL_PLATFORMS.map((p2) => (<div key={p2} className={platDotClass(status[p2])} title={`${p2}: ${status[p2]}`} />))}
                  </div>
                )}
                {(() => {
                  const bs = runs.baselineByState?.[s.num];
                  if (!bs) return null;
                  const driftPlatforms = Object.entries(bs).filter(([, v]) => v.status === "drift").map(([k]) => k);
                  const matchPlatforms = Object.entries(bs).filter(([, v]) => v.status === "match" || v.status === "new").map(([k]) => k);
                  if (!driftPlatforms.length && !matchPlatforms.length) return null;
                  return (
                    <div className="flowdoc-card-baseline" title={`baseline: ${matchPlatforms.length} match, ${driftPlatforms.length} drift`}>
                      {driftPlatforms.length > 0 ? (
                        <span className="flowdoc-bl-drift">△ visual drift ({driftPlatforms.length}p)</span>
                      ) : (
                        <span className="flowdoc-bl-match">✓ baselined ({matchPlatforms.length}p)</span>
                      )}
                    </div>
                  );
                })()}
                {s.actions && s.actions.length > 0 && (
                  <div className="flowdoc-card-actions">
                    {s.actions.map((a, i) => {
                      const glyph = a.kind === "edit" ? "✎" : a.kind === "add" ? "+" : a.kind === "delete" ? "🗑" : a.kind === "upload" ? "↑" : a.kind === "toggle" ? "◐" : a.kind === "submit" ? "▶" : a.kind === "approve" ? "✓" : "✗";
                      const roleList = (a.allowedRoles?.length ? "Allowed: " + a.allowedRoles.join(", ") : "Any role") + (a.deniedRoles?.length ? " · Denied: " + a.deniedRoles.join(", ") : "");
                      return (
                        <span key={i} className={`flowdoc-action flowdoc-action-${a.kind}`} title={`${a.kind} ${a.target} · ${roleList}${a.comment ? " · " + a.comment : ""}`}>
                          <span className="flowdoc-action-glyph">{glyph}</span>
                          <span className="flowdoc-action-target">{a.target}</span>
                        </span>
                      );
                    })}
                  </div>
                )}
                </div>
              </div>
            );
          })}
          {marquee && (
            <div
              className="flowdoc-marquee"
              style={{
                position: "absolute",
                left: marquee.x,
                top: marquee.y,
                width: marquee.w,
                height: marquee.h,
                pointerEvents: "none",
              }}
            />
          )}
        </div>
        </div>
      </div>
      </div>

      <div className="flowdoc-scen-bar">
        <b>Sequence:</b>
        {activeScenario ? (
          <>
            <span className="flowdoc-seq">
              {activeScenario.path.map((n, i) => (
                <span key={i}>
                  <span
                    className="flowdoc-seq-num"
                    title={stateByNum[n]?.title || ""}
                    onClick={() => {
                      setSelectedNums(new Set([n]));
                      const el = document.querySelectorAll(".flowdoc-canvas .flowdoc-card");
                      el.forEach((node) => {
                        const numEl = node.querySelector(".flowdoc-card-num");
                        if (numEl?.textContent === String(n)) (node as HTMLElement).scrollIntoView({ behavior: "smooth", block: "center", inline: "center" });
                      });
                    }}
                  >{n}</span>
                  {i < activeScenario.path.length - 1 && <span className="flowdoc-seq-arr">→</span>}
                </span>
              ))}
            </span>
            <span className="flowdoc-seq-meta"><b>{activeScenario.title}</b> · {activeScenario.role ?? "any"}</span>
            {activeScenario.comments?.length ? (
              <div className="flowdoc-scen-comments">
                {activeScenario.comments.map((c, i) => (
                  <div key={i} className={`flowdoc-comment flowdoc-comment-${c.kind || "note"}`} title={`At step ${c.at_step + 1}`}>
                    <b>@{c.at_step + 1}</b> {c.text}
                  </div>
                ))}
              </div>
            ) : null}
          </>
        ) : (
          <span className="flowdoc-seq-empty">— pick a scenario above or click a card —</span>
        )}
      </div>

      {detailsNum != null && (() => {
        const s = stateByNum[detailsNum];
        if (!s) return null;
        const incoming = transitions.filter((t) => t.to === detailsNum);
        const outgoing = transitions.filter((t) => t.from === detailsNum);
        const scenariosTouching = scenarios.filter((sc) => sc.path.includes(detailsNum));
        return (
          <div className="flowdoc-modal-backdrop" onClick={() => setDetailsNum(null)}>
            <div className="flowdoc-modal-card" onClick={(e) => e.stopPropagation()}>
              <div className="flowdoc-modal-head">
                <span className="flowdoc-modal-num">#{s.num}</span>
                <span className="flowdoc-modal-kind">{s.kind.toUpperCase()}</span>
                <span className="flowdoc-modal-title">{s.title}</span>
                <button type="button" className="flowdoc-modal-close" onClick={() => setDetailsNum(null)}>✕</button>
              </div>
              <div className="flowdoc-modal-body">
                {s.path && <div className="flowdoc-modal-row"><b>Path:</b> <code>{s.path}</code></div>}
                {s.id && <div className="flowdoc-modal-row"><b>ID:</b> <code>{s.id}</code></div>}
                {s.roles && s.roles.length > 0 && (
                  <div className="flowdoc-modal-row"><b>Roles:</b> {s.roles.map((r) => (
                    <span key={r} className={`flowdoc-role-stripe-${r}`} style={{ padding: "2px 8px", borderRadius: 4, marginRight: 4, fontSize: 11, fontWeight: 700 }}>{r}</span>
                  ))}</div>
                )}
                {s.desc && <div className="flowdoc-modal-row"><b>Description:</b> {s.desc}</div>}
                {(s as any).fields && (s as any).fields.length > 0 && (
                  <div className="flowdoc-modal-row"><b>Fields:</b>
                    <ul className="flowdoc-modal-list">{(s as any).fields.map((f: any, i: number) => <li key={i}>{f.name} <code>{f.type || ""}</code> {f.required ? "*" : ""}</li>)}</ul>
                  </div>
                )}
                {s.actions && s.actions.length > 0 && (
                  <div className="flowdoc-modal-row"><b>Actions:</b>
                    <ul className="flowdoc-modal-list">{s.actions.map((a, i) => <li key={i}>{a.kind} → {a.target ?? ""} {a.allowedRoles ? `(roles: ${a.allowedRoles.join(",")})` : ""}</li>)}</ul>
                  </div>
                )}
                <div className="flowdoc-modal-row">
                  <b>Incoming ({incoming.length}):</b>
                  {incoming.length === 0 ? <span style={{ color: "#94a3b8" }}> — none —</span> : (
                    <ul className="flowdoc-modal-list">
                      {incoming.slice(0, 20).map((t, i) => {
                        const from = stateByNum[t.from];
                        return <li key={i}><button className="flowdoc-modal-jump" onClick={() => setDetailsNum(t.from)}>#{t.from} {from?.title}</button> <span style={{ color: "#64748b" }}>— {t.label || "(unlabeled)"}</span></li>;
                      })}
                    </ul>
                  )}
                </div>
                <div className="flowdoc-modal-row">
                  <b>Outgoing ({outgoing.length}):</b>
                  {outgoing.length === 0 ? <span style={{ color: "#94a3b8" }}> — none —</span> : (
                    <ul className="flowdoc-modal-list">
                      {outgoing.slice(0, 20).map((t, i) => {
                        const to = stateByNum[t.to];
                        return <li key={i}><button className="flowdoc-modal-jump" onClick={() => setDetailsNum(t.to)}>#{t.to} {to?.title}</button> <span style={{ color: "#64748b" }}>— {t.label || "(unlabeled)"}</span></li>;
                      })}
                    </ul>
                  )}
                </div>
                <div className="flowdoc-modal-row">
                  <b>Scenarios touching this state ({scenariosTouching.length}):</b>
                  {scenariosTouching.length === 0 ? <span style={{ color: "#94a3b8" }}> — none —</span> : (
                    <ul className="flowdoc-modal-list">
                      {scenariosTouching.slice(0, 10).map((sc) => (
                        <li key={sc.id}><code style={{ color: "#475569" }}>{sc.id.toUpperCase()}</code> ({sc.role}) — {sc.title}</li>
                      ))}
                      {scenariosTouching.length > 10 && <li style={{ color: "#94a3b8" }}>… +{scenariosTouching.length - 10} more</li>}
                    </ul>
                  )}
                </div>
              </div>
            </div>
          </div>
        );
      })()}
    </div>
  );
}
