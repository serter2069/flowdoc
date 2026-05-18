import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import Database from "better-sqlite3";
import { validateFlowDoc, type Scenario, type State, type Transition } from "../schema.js";

interface EnumerateOpts {
  out?: string;
  maxLen: number;
  maxScenarios: number;
  appendInPlace: boolean;
  reconcile: boolean;
  baselineDir?: string;        // .flowdoc — for cleanup of stale baselines
}

const TERMINAL_KINDS = new Set(["success", "email", "push", "db", "webhook", "error"]);

/**
 * Patterns identifying transitions added by `synthesizeAuthGateTransitions`.
 * Strip them all before regenerating, otherwise repeated runs of `enumerate`
 * accumulate duplicates. Keep this list in sync with the labels produced
 * inside that function.
 */
const SYNTHETIC_LABEL_RE = /^(login as |enter as |tab-bar |visit \/login|client lands |submit booking |manager sees )/;
function isSyntheticEdge(t: Transition): boolean {
  return SYNTHETIC_LABEL_RE.test(t.label ?? "");
}

function isTerminal(state: State, outgoing: Transition[]): boolean {
  if (TERMINAL_KINDS.has(state.kind ?? "state")) return true;
  if (outgoing.length === 0) return true;
  return false;
}

function isAnonEntry(state: State, _incoming: Transition[]): boolean {
  // True entry = the canonical Anonymous root (single source of truth).
  // Every scenario MUST originate from here so the user-visible sequence reads:
  //   Anonymous root → Login → (role-home) → app screens.
  // Anon-accessible states like Login, Reset Password, public landings are NOT
  // entries — they are reached from Anonymous root via real or synthetic edges.
  if (/anonymous root/i.test(state.title)) return true;
  return false;
}

/**
 * Find a Login-ish anonymous entry state and the canonical "home" screen for
 * each authenticated role, then return synthetic transitions Login→home
 * so DFS from anon entries reaches every authenticated screen.
 *
 * This is what lets us say "every Worker scenario starts at Login → MyAppointments → …"
 * instead of "BookingEdit → (random walk)".
 */
function synthesizeAuthGateTransitions(states: State[], transitions: Transition[]): Transition[] {
  const login = states.find((s) =>
    (s.roles ?? []).includes("anon") && /login|signin/i.test(s.title)
  );

  const synthetic: Transition[] = [];
  const transitionsByPair = new Set(transitions.map((t) => `${t.from}→${t.to}`));

  // 0. Synthesize an Anonymous root if the scanner didn't create one (e.g. expo-router scans).
  //    Without it, enumerate has no DFS entry and produces zero scenarios.
  let root = states.find((s) => /anonymous root/i.test(s.title));
  if (!root) {
    const maxNum = Math.max(0, ...states.map((s) => s.num));
    root = { num: maxNum + 1000, id: "synthetic-anon-root", kind: "page", title: "Anonymous root", path: "/", roles: ["anon"] } as State;
    states.push(root);
    // Connect synthetic root to every plausible top-level state: anon-role pages
    // OR states with no incoming. That covers RN apps (Login, public landings)
    // and pure expo-router apps (index.tsx → reachable via root).
    const incomingNums = new Set(transitions.map((t) => t.to));
    for (const s of states) {
      if (s.num === root.num) continue;
      const isAnonRole = (s.roles ?? []).includes("anon");
      const hasNoIncoming = !incomingNums.has(s.num);
      const isLikelyRoot = /^(\/|index|home|root)$/i.test(s.title) || s.path === "/" || /^\/$/.test(s.path ?? "");
      if (isAnonRole || hasNoIncoming || isLikelyRoot) {
        transitions.push({ from: root.num, to: s.num, label: `visit ${s.title.slice(0, 30)}` });
      }
    }
  }
  // 1. Anonymous root → Login (single canonical entry point — if Login exists)
  if (login && root && !transitionsByPair.has(`${root.num}→${login.num}`)) {
    synthetic.push({ from: root.num, to: login.num, label: "visit /login", cond: "anon" });
    transitionsByPair.add(`${root.num}→${login.num}`);
  }

  // 1b. Client funnel: connect customer-facing screens into a lifecycle so a
  //     scenario reads as: Anonymous root → /booking → /property-lookup → submit
  //     → BookingCreatedNotification (push to manager) → manager picks it up.
  const clientHome = states.find((s) =>
    (s.roles ?? []).includes("client") && /publicbooking|^\/?booking($|\/)|booking funnel/i.test(s.title + " " + (s.path ?? ""))
  );
  if (clientHome && root && !transitionsByPair.has(`${root.num}→${clientHome.num}`)) {
    synthetic.push({ from: root.num, to: clientHome.num, label: "client lands → start booking", cond: "client" });
    transitionsByPair.add(`${root.num}→${clientHome.num}`);
  }
  // Customer submit → BookingCreatedNotification (push to ops/manager)
  const bookingNotif = states.find((s) =>
    s.kind === "push" && /bookingcreated|bookingsubmit/i.test(s.title)
  );
  if (clientHome && bookingNotif) {
    const pair = `${clientHome.num}→${bookingNotif.num}`;
    if (!transitionsByPair.has(pair)) {
      synthetic.push({ from: clientHome.num, to: bookingNotif.num, label: "submit booking → notify ops", cond: "POST /api/bookings" });
      transitionsByPair.add(pair);
    }
    // Notification → manager Dashboard (the manager picks up the new booking)
    const mgrHome = states.find((s) => (s.roles ?? []).includes("manager") && /dashboard|bookings/i.test(s.title));
    if (mgrHome && !transitionsByPair.has(`${bookingNotif.num}→${mgrHome.num}`)) {
      synthetic.push({ from: bookingNotif.num, to: mgrHome.num, label: "manager sees new booking", cond: "push delivered" });
      transitionsByPair.add(`${bookingNotif.num}→${mgrHome.num}`);
    }
  }

  // 2. Login → role home (one synthetic edge per authenticated role)
  const HOME_HINTS: Record<string, RegExp> = {
    worker: /myappoint|^my schedule|dashboard|earnings/i,
    manager: /dashboard|bookings|companies/i,
    admin: /settings|verticals|companies|dashboard/i,
    client: /publicbooking|landing|home/i,
    dispatcher: /dispatch|dashboard/i,
    any: /profile|settings|notifications|inbox/i,    // shared-role screens reached after login
  };
  for (const [role, hint] of Object.entries(HOME_HINTS)) {
    const candidates = states.filter((s) => (s.roles ?? []).includes(role));
    if (candidates.length === 0) continue;
    const home = candidates.find((s) => hint.test(s.title)) ?? candidates[0];
    // If there's a Login, route through it (Login → home). Otherwise wire
    // root → home directly (e.g. expo-router projects without explicit login).
    const gate = login ?? root;
    if (!gate) continue;
    const pair = `${gate.num}→${home.num}`;
    if (!transitionsByPair.has(pair)) {
      synthetic.push({ from: gate.num, to: home.num, label: login ? `login as ${role}` : `enter as ${role}`, cond: `role=${role}` });
      transitionsByPair.add(pair);
    }
    // 3. Tab-bar synthetic edges: home screen of role → every other screen of
    //    same role. Real apps reach most screens via a bottom tab-bar that our
    //    scanner can't see (only inline navigation.navigate('X') is picked up).
    //    Without these, half the RN tree shows as orphans.
    for (const target of candidates) {
      if (target.num === home.num) continue;
      const tabPair = `${home.num}→${target.num}`;
      if (transitionsByPair.has(tabPair)) continue;
      synthetic.push({ from: home.num, to: target.num, label: `tab-bar (${role})`, cond: `role=${role}` });
      transitionsByPair.add(tabPair);
    }
  }
  return synthetic;
}

function pathKey(path: number[]): string {
  return path.join("→");
}

// Pseudo-roles that aren't real user roles — used as state-kind markers only.
// Scenarios should never be classified as one of these.
const NON_USER_ROLES = new Set(["any", "anon", "api", "system", "backend"]);

function inferRole(path: number[], stateByNum: Map<number, State>): string | undefined {
  const roles = new Set<string>();
  for (const n of path) {
    for (const r of stateByNum.get(n)?.roles ?? []) {
      if (!NON_USER_ROLES.has(r)) roles.add(r);
    }
  }
  if (roles.size === 0) return "anon";
  if (roles.size === 1) return [...roles][0];
  // Multiple — pick most specific (last user-role in path)
  for (let i = path.length - 1; i >= 0; i--) {
    for (const r of stateByNum.get(path[i])?.roles ?? []) {
      if (!NON_USER_ROLES.has(r)) return r;
    }
  }
  return undefined;
}

function inferTitle(path: number[], stateByNum: Map<number, State>): string {
  const entry = stateByNum.get(path[0]);
  const exit = stateByNum.get(path[path.length - 1]);
  const role = inferRole(path, stateByNum);
  const rolePrefix = role && role !== "anon" ? `${role.charAt(0).toUpperCase()}${role.slice(1)}: ` : "";
  const fromTitle = entry?.title.split("(")[0].split("·")[0].trim() ?? `#${path[0]}`;
  const toTitle = exit?.title.split("(")[0].split("·")[0].trim() ?? `#${path[path.length - 1]}`;
  return `${rolePrefix}${fromTitle} → ${toTitle}`;
}

function inferNarrative(path: number[], stateByNum: Map<number, State>, transitions: Transition[]): string {
  const parts: string[] = [];
  for (let i = 0; i < path.length - 1; i++) {
    const a = stateByNum.get(path[i]);
    const b = stateByNum.get(path[i + 1]);
    const t = transitions.find((x) => x.from === path[i] && x.to === path[i + 1]);
    if (!a || !b) continue;
    const verb = t?.label || `→ #${b.num}`;
    parts.push(`${a.title.slice(0, 40)} (${verb})`);
  }
  parts.push(stateByNum.get(path[path.length - 1])?.title ?? "");
  return parts.join(" → ");
}

export function enumerateCommand(flowsArg: string | undefined, opts: EnumerateOpts) {
  const flowsPath = resolve(process.cwd(), flowsArg ?? "flows.json");
  if (!existsSync(flowsPath)) {
    console.error(`flows.json not found: ${flowsPath}`);
    process.exit(1);
  }
  // Use non-strict scenario validation — we WILL find broken refs and clean them up.
  const doc = validateFlowDoc(JSON.parse(readFileSync(flowsPath, "utf8")), { strictScenarios: false });
  const states = doc.states ?? [];
  const baseTransitions = doc.transitions ?? [];
  // Add synthetic auth-gate edges so DFS from Login reaches every authenticated
  // role-home. These edges are persisted to flows.json so the canvas can render
  // them, but every re-run must strip ALL of them (every label pattern listed in
  // SYNTHETIC_LABEL_RE) before re-synthesizing — otherwise duplicates accumulate.
  const realTransitions = baseTransitions.filter((t) => !isSyntheticEdge(t));
  const synthetic = synthesizeAuthGateTransitions(states, realTransitions);
  if (synthetic.length) console.log(`  + ${synthetic.length} synthetic auth-gate edges from Login to role homes`);
  const transitions = [...realTransitions, ...synthetic];
  // Write synthetic edges back into the doc so they render on the canvas
  doc.transitions = transitions;
  if (!states.length) {
    console.error("No states[] in flows.json — nothing to enumerate.");
    process.exit(1);
  }
  const stateByNum = new Map(states.map((s) => [s.num, s]));
  const incomingByNum = new Map<number, Transition[]>();
  const outgoingByNum = new Map<number, Transition[]>();
  for (const s of states) {
    incomingByNum.set(s.num, []);
    outgoingByNum.set(s.num, []);
  }
  for (const t of transitions) {
    outgoingByNum.get(t.from)?.push(t);
    incomingByNum.get(t.to)?.push(t);
  }

  const entries = states.filter((s) => isAnonEntry(s, incomingByNum.get(s.num) ?? []));
  const paths = new Map<string, number[]>();   // dedup by pathKey

  function dfs(num: number, path: number[], visited: Set<number>, depth: number) {
    if (paths.size >= opts.maxScenarios) return;
    const state = stateByNum.get(num);
    if (!state) return;
    const out = outgoingByNum.get(num) ?? [];
    if (isTerminal(state, out) || depth >= opts.maxLen) {
      const key = pathKey(path);
      if (!paths.has(key) && path.length >= 2) paths.set(key, path.slice());
      return;
    }
    for (const t of out) {
      if (visited.has(t.to)) continue;          // no revisiting same state in single path (avoid cycles)
      visited.add(t.to);
      path.push(t.to);
      dfs(t.to, path, visited, depth + 1);
      path.pop();
      visited.delete(t.to);
    }
    // Also emit the path-so-far when no further unique extension is possible
    if (out.every((t) => visited.has(t.to))) {
      const key = pathKey(path);
      if (!paths.has(key) && path.length >= 2) paths.set(key, path.slice());
    }
  }

  for (const e of entries) {
    dfs(e.num, [e.num], new Set([e.num]), 0);
  }

  // Reconcile with existing scenarios — preserve valid ones (so their baseline/comments survive)
  const existingScenarios = doc.scenarios ?? [];
  const transitionsByPair = new Set<string>();
  for (const t of transitions) transitionsByPair.add(`${t.from}→${t.to}`);

  const entryNumsSet = new Set(entries.map((e) => e.num));
  function isScenarioValid(s: Scenario): { valid: true } | { valid: false; reason: string } {
    for (let i = 0; i < s.path.length; i++) {
      if (!stateByNum.has(s.path[i])) return { valid: false, reason: `state #${s.path[i]} removed` };
      if (i > 0 && !transitionsByPair.has(`${s.path[i - 1]}→${s.path[i]}`)) {
        return { valid: false, reason: `transition #${s.path[i - 1]}→#${s.path[i]} removed` };
      }
    }
    // Auto-generated scenarios must now start from a true entry (anon landing or Login).
    // Hand-written scenarios are exempt — author may legitimately want a mid-app scenario.
    if (s.tags?.includes("auto-generated") && !entryNumsSet.has(s.path[0])) {
      return { valid: false, reason: `path no longer starts from an entry (now starts at #${s.path[0]})` };
    }
    return { valid: true };
  }

  const kept: Scenario[] = [];
  const dropped: Array<{ s: Scenario; reason: string }> = [];
  for (const s of existingScenarios) {
    const v = isScenarioValid(s);
    if (!v.valid) { dropped.push({ s, reason: (v as any).reason }); continue; }
    // Auto-generated scenarios get their role/title/narrative refreshed each run so
    // upstream changes to the role-inference heuristic actually propagate. Hand-written
    // scenarios (no "auto-generated" tag) keep whatever the author wrote.
    if (s.tags?.includes("auto-generated")) {
      kept.push({
        ...s,
        title: inferTitle(s.path, stateByNum),
        role: inferRole(s.path, stateByNum),
        narrative: "AUTO-ENUMERATED · " + inferNarrative(s.path, stateByNum, transitions),
      });
    } else {
      kept.push(s);
    }
  }

  // Build candidate auto-scenarios; dedupe by path key against kept ones
  const keptPathKeys = new Set(kept.map((s) => pathKey(s.path)));
  const candidates: Scenario[] = [];
  const usedIds = new Set(kept.map((s) => s.id));
  let idx = 1;
  for (const path of paths.values()) {
    if (keptPathKeys.has(pathKey(path))) continue;
    let id = `auto-${idx++}`;
    while (usedIds.has(id)) id = `auto-${idx++}`;
    usedIds.add(id);
    candidates.push({
      id,
      title: inferTitle(path, stateByNum),
      role: inferRole(path, stateByNum),
      narrative: "AUTO-ENUMERATED · " + inferNarrative(path, stateByNum, transitions),
      path,
      tags: ["auto-generated"],
    });
  }
  candidates.sort((a, b) => b.path.length - a.path.length);

  // Prefix-prune: if a scenario's path is a strict prefix of a longer scenario's
  // path, drop it — the longer one already covers it. e.g. testing 1→2→3→4→5
  // makes separate tests for 1→2, 1→2→3, 1→2→3→4 redundant.
  const candidatesByStart = new Map<number, Scenario[]>();
  for (const c of candidates) {
    const s = c.path[0];
    if (!candidatesByStart.has(s)) candidatesByStart.set(s, []);
    candidatesByStart.get(s)!.push(c);
  }
  const survivors: Scenario[] = [];
  let pruned = 0;
  for (const c of candidates) {
    const peers = candidatesByStart.get(c.path[0]) ?? [];
    const isPrefix = peers.some((p) => {
      if (p === c) return false;
      if (p.path.length <= c.path.length) return false;
      for (let i = 0; i < c.path.length; i++) if (p.path[i] !== c.path[i]) return false;
      return true;
    });
    if (isPrefix) pruned++;
    else survivors.push(c);
  }
  if (pruned > 0) {
    console.log(`  ↳ prefix-pruned ${pruned} scenarios (subsumed by longer paths covering same prefix)`);
    candidates.length = 0;
    candidates.push(...survivors);
  }

  // Greedy set-cover by TRANSITIONS. If "Login → Dashboard" already appears in
  // some long scenario, we don't need a separate short scenario that just hits
  // those two states. Pick the minimum subset of scenarios that together cover
  // every transition reachable by ANY auto-scenario.
  //
  // Hand-written scenarios are pinned (never dropped) and their transitions
  // count as already-covered going in. We only prune *auto-generated* candidates.
  const pinnedTrans = new Set<string>();
  for (const k of kept) {
    for (let i = 0; i < k.path.length - 1; i++) pinnedTrans.add(`${k.path[i]}→${k.path[i + 1]}`);
  }
  const uncovered = new Set<string>();
  for (const c of candidates) {
    for (let i = 0; i < c.path.length - 1; i++) {
      const k = `${c.path[i]}→${c.path[i + 1]}`;
      if (!pinnedTrans.has(k)) uncovered.add(k);
    }
  }
  const minimalCover: Scenario[] = [];
  const minimalCoverSet = new Set<string>();   // ids
  // Pre-sort: longer (more new coverage potential) first, then by role spread
  const sorted = candidates.slice().sort((a, b) => b.path.length - a.path.length);
  while (uncovered.size > 0) {
    let best: Scenario | null = null;
    let bestGain = 0;
    for (const c of sorted) {
      if (minimalCoverSet.has(c.id)) continue;
      let gain = 0;
      for (let i = 0; i < c.path.length - 1; i++) {
        if (uncovered.has(`${c.path[i]}→${c.path[i + 1]}`)) gain++;
      }
      if (gain > bestGain) { bestGain = gain; best = c; }
    }
    if (!best || bestGain === 0) break;
    minimalCover.push(best);
    minimalCoverSet.add(best.id);
    for (let i = 0; i < best.path.length - 1; i++) {
      uncovered.delete(`${best.path[i]}→${best.path[i + 1]}`);
    }
  }
  const coverDropped = candidates.length - minimalCover.length;
  if (coverDropped > 0) {
    console.log(`  ↳ set-cover pruned ${coverDropped} scenarios — kept ${minimalCover.length} that together cover every transition reachable from auto-scenarios`);
    candidates.length = 0;
    candidates.push(...minimalCover);
  }

  const lenStats = candidates.reduce((m, s) => { m.set(s.path.length, (m.get(s.path.length) ?? 0) + 1); return m; }, new Map<number, number>());
  console.log(`✓ enumerated ${paths.size} unique paths from ${entries.length} entry state(s)`);
  console.log(`  path length distribution: ${[...lenStats.entries()].sort((a, b) => a[0] - b[0]).map(([l, n]) => `${l}=${n}`).join(", ")}`);

  // Cleanup baselines for dropped scenarios (so the SQLite + baseline dir don't carry dead refs)
  if (opts.reconcile && opts.baselineDir && dropped.length > 0) {
    const dbPath = join(resolve(process.cwd(), opts.baselineDir), "flowdoc.db");
    if (existsSync(dbPath)) {
      const db = new Database(dbPath);
      try {
        const stmt = db.prepare(`DELETE FROM baseline_runs WHERE scenario_id = ?`);
        for (const d of dropped) stmt.run(d.s.id);
      } catch {/* baseline_runs table may not exist yet */}
      db.close();
    }
    for (const d of dropped) {
      const bdir = join(resolve(process.cwd(), opts.baselineDir), "baseline", d.s.id);
      if (existsSync(bdir)) {
        rmSync(bdir, { recursive: true, force: true });
      }
    }
  }

  if (opts.reconcile) {
    doc.scenarios = [...kept, ...candidates];
    writeFileSync(flowsPath, JSON.stringify(doc, null, 2) + "\n", "utf8");
    console.log(`✓ reconciled: kept ${kept.length} (paths still valid), dropped ${dropped.length}, added ${candidates.length} new`);
    if (dropped.length > 0) {
      console.log(`  dropped scenarios:`);
      for (const d of dropped) console.log(`    - ${d.s.id} "${d.s.title.slice(0, 50)}" — ${d.reason}`);
      if (opts.baselineDir) console.log(`  ↳ baseline dirs + DB rows for dropped scenarios were also cleaned`);
    }
    console.log(`  total scenarios now: ${doc.scenarios.length}`);
  } else if (opts.appendInPlace) {
    // legacy append-only mode (no reconcile)
    doc.scenarios = [...existingScenarios, ...candidates];
    writeFileSync(flowsPath, JSON.stringify(doc, null, 2) + "\n", "utf8");
    console.log(`✓ appended ${candidates.length} (now ${doc.scenarios.length} scenarios total)`);
  } else if (opts.out) {
    const outPath = resolve(process.cwd(), opts.out);
    writeFileSync(outPath, JSON.stringify({ scenarios: candidates }, null, 2) + "\n", "utf8");
    console.log(`✓ wrote ${opts.out}`);
  } else {
    process.stdout.write(JSON.stringify({ scenarios: candidates }, null, 2) + "\n");
  }
}
