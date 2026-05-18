import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { FlowDoc, State } from "../schema.js";

interface LayoutOpts {
  colW: number;
  rowH: number;
}

/**
 * Layered left-to-right "tree" layout.
 *
 * Anchored on the canonical Anonymous root: BFS from there assigns each state a
 * depth (column). Within each column, states are sorted by their parent's row
 * and given evenly-spaced row slots, vertically centered around y=0.
 *
 * Disconnected states (not reachable from the root) get appended in a far-right
 * "orphan" column so they're still visible but don't pollute the main tree.
 */
export function layoutCommand(flowsArg: string, opts: LayoutOpts) {
  const flowsPath = resolve(process.cwd(), flowsArg);
  if (!existsSync(flowsPath)) {
    console.error(`flows.json not found: ${flowsPath}`);
    process.exit(1);
  }
  const doc: FlowDoc = JSON.parse(readFileSync(flowsPath, "utf8"));
  const states = doc.states ?? [];
  const transitions = doc.transitions ?? [];
  if (!states.length) {
    console.error("No states to lay out");
    process.exit(1);
  }

  const outEdges = new Map<number, number[]>();
  for (const s of states) outEdges.set(s.num, []);
  for (const t of transitions) outEdges.get(t.from)?.push(t.to);

  // Find the canonical root
  const root = states.find((s) => /anonymous root/i.test(s.title)) ?? states[0];

  // BFS to assign depth (column)
  const depth = new Map<number, number>();
  depth.set(root.num, 0);
  const queue: number[] = [root.num];
  while (queue.length) {
    const cur = queue.shift()!;
    const d = depth.get(cur)!;
    for (const next of outEdges.get(cur) ?? []) {
      if (depth.has(next)) continue;
      depth.set(next, d + 1);
      queue.push(next);
    }
  }

  // Disconnected states: park them in a far-right column
  const maxDepth = Math.max(0, ...[...depth.values()]);
  const orphanCol = maxDepth + 2;
  let orphanCount = 0;
  for (const s of states) {
    if (!depth.has(s.num)) {
      depth.set(s.num, orphanCol);
      orphanCount++;
    }
  }

  // Group by column, sort within column by inferred parent-row (stable layout)
  const byCol = new Map<number, State[]>();
  for (const s of states) {
    const c = depth.get(s.num)!;
    if (!byCol.has(c)) byCol.set(c, []);
    byCol.get(c)!.push(s);
  }
  for (const arr of byCol.values()) {
    arr.sort((a, b) => {
      // Sort by role then title for visual grouping
      const ra = (a.roles ?? ["any"])[0];
      const rb = (b.roles ?? ["any"])[0];
      if (ra !== rb) return ra.localeCompare(rb);
      return a.title.localeCompare(b.title);
    });
  }

  // Wrap long columns into sub-columns so a fan-out column with 100 states
  // doesn't become 14000px tall. Aim for ~16 rows max per sub-column.
  const MAX_PER_COL = 10;
  // CARD_W = 220 in the viewer; sub-columns need ≥ 380 to leave 160px gap
  const SUB_COL_W = Math.max(380, Math.round(opts.colW * 0.8));
  const positions = new Map<number, { x: number; y: number }>();
  for (const [col, list] of byCol.entries()) {
    const subCols = Math.ceil(list.length / MAX_PER_COL);
    const rowsPerSub = Math.ceil(list.length / subCols);
    const baseX = col * opts.colW;
    const totalH = rowsPerSub * opts.rowH;
    const startY = -totalH / 2 + opts.rowH / 2;
    list.forEach((s, i) => {
      const sub = Math.floor(i / rowsPerSub);
      const rowInSub = i % rowsPerSub;
      positions.set(s.num, {
        x: baseX + sub * SUB_COL_W,
        y: startY + rowInSub * opts.rowH,
      });
    });
  }

  // Normalize so all coordinates are positive (add a big padding so the graph
  // sits well inside an oversized canvas — users can pan freely into the empty
  // surrounding space).
  const PAD = 600;
  const xs = [...positions.values()].map((p) => p.x);
  const ys = [...positions.values()].map((p) => p.y);
  const minX = Math.min(...xs), minY = Math.min(...ys);
  for (const [num, p] of positions) {
    positions.set(num, { x: p.x - minX + PAD, y: p.y - minY + PAD });
  }

  // Write back into the doc: clear col/row (legacy) and set explicit positions
  for (const s of states) {
    const p = positions.get(s.num);
    if (p) {
      s.position = p;
      delete (s as State).col;
      delete (s as State).row;
    }
  }

  writeFileSync(flowsPath, JSON.stringify(doc, null, 2) + "\n", "utf8");
  console.log(`✓ laid out ${states.length} states across ${byCol.size} columns (max depth=${maxDepth}${orphanCount ? `, ${orphanCount} orphans parked at col ${orphanCol}` : ""})`);
  console.log(`  columns: ${[...byCol.entries()].sort((a,b) => a[0]-b[0]).map(([c, l]) => `${c}=${l.length}`).join(", ")}`);
}
