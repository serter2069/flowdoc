import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import type { FlowDoc, State, Transition } from "../schema.js";

interface ScanRnOpts {
  out: string;
  merge?: string;       // path to existing flows.json to merge into
}

const API_URL_RE = /\bapi\s*\.\s*(?:get|post|put|patch|delete)\s*<[^>]*>?\s*\(\s*[`'"]([^`'"]+)[`'"]|\bapi\s*\.\s*(?:get|post|put|patch|delete)\s*\(\s*[`'"]([^`'"]+)[`'"]/g;
const FETCH_RE = /\bfetch\s*\(\s*['"`]([^'"`]+)['"`]/g;
const AXIOS_RE = /\baxios\s*\.\s*(?:get|post|put|patch|delete)\s*\(\s*['"`]([^'"`]+)['"`]/g;
const NAV_RE = /\bnavigation\s*\.\s*(?:navigate|push|replace)\s*\(\s*['"`](\w+)['"`]/g;
const LINK_TO_RE = /<Link\s+to\s*=\s*['"`]([^'"`]+)['"`]/g;
// `import { Bookings, Customers } from '../api/client';`  or  `import Foo from './foo';`
const IMPORT_RE = /import\s+(?:(\w+)|(?:\*\s+as\s+(\w+))|(?:\{([^}]+)\}))(?:\s*,\s*(?:(\w+)|\{([^}]+)\}))?\s+from\s+['"]([^'"]+)['"]/g;

function walkFiles(dir: string, exts: string[], out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const f of readdirSync(dir)) {
    if (f === "node_modules" || f === ".next" || f === "dist" || f === ".expo") continue;
    const fp = join(dir, f);
    const s = statSync(fp);
    if (s.isDirectory()) walkFiles(fp, exts, out);
    else if (exts.some((e) => f.endsWith(e))) out.push(fp);
  }
  return out;
}

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

function titleizeScreen(name: string): string {
  return name.replace(/Screen$/, "").replace(/([a-z])([A-Z])/g, "$1 $2").trim();
}

function inferRoleFromName(name: string): string[] {
  const base = name.replace(/Screen$/, "");
  const n = base.toLowerCase();

  // Anonymous (no auth needed) — must precede other checks
  if (/^login|^signin|^signup|^register|^forgot|^reset|^password$|^publicbooking|^publicconsult|^public[a-z]/.test(n)) return ["anon"];

  // Worker-centric screens (own schedule, own earnings, own appointments)
  if (/^worker|^myapp|^myjob|^myschedule|^useravailab|earnings$|payoutslip/.test(n)) return ["worker"];

  // Admin-only (tenant/security/billing/template/audit/zip-routing/vertical/payout-rate config)
  if (/^vertical|^payoutrate|^securit|emailtempl|emailmanag|emailactiv|stripewebhook|^auditfeed|passwordaudit|^ziprouting|^placeholder|^settings|^companies$|^companydetail$|^companyform$/.test(n)) {
    return ["admin"];
  }

  // Dispatcher (rare in pluto but kept for portability)
  if (/^dispatcher|dispatch/.test(n)) return ["dispatcher"];

  // Manager-centric: CRUD on bookings, customers, offers, products, schedule, team, communications, checklists
  if (/^booking|^customer|^offer|^product|^payment|^review|^schedule|^team|^userdetail|^communication|^thread|^inbox|^notification|^checklist|^dashboard|^complete|^pulse|^audit$/.test(n)) {
    return ["manager"];
  }

  // Shared (Profile, Appearance, etc.)
  return ["any"];
}

function extractApiUrls(src: string): Set<string> {
  const urls = new Set<string>();
  for (const m of src.matchAll(API_URL_RE)) {
    const u = m[1] ?? m[2];
    if (!u) continue;
    // strip ${...} template parts → wildcard
    urls.add(u.replace(/\$\{[^}]+\}/g, "{var}"));
  }
  for (const m of src.matchAll(FETCH_RE)) {
    const u = m[1];
    if (u.startsWith("/") || u.startsWith("http")) urls.add(u.replace(/\$\{[^}]+\}/g, "{var}"));
  }
  for (const m of src.matchAll(AXIOS_RE)) urls.add(m[1].replace(/\$\{[^}]+\}/g, "{var}"));
  return urls;
}

function resolveImport(fromFile: string, spec: string, allFiles: Set<string>): string | null {
  if (!spec.startsWith(".") && !spec.startsWith("/")) return null;  // skip node_modules
  const base = resolve(dirname(fromFile), spec);
  const candidates = [
    base, base + ".ts", base + ".tsx", base + ".js", base + ".jsx",
    join(base, "index.ts"), join(base, "index.tsx"), join(base, "index.js"), join(base, "index.jsx"),
  ];
  for (const c of candidates) if (allFiles.has(c)) return c;
  return null;
}

interface RnScreen {
  id: string;
  componentName: string;
  registeredName: string;       // without Screen suffix — matches navigation.navigate('X')
  title: string;
  roles: string[];
  navTo: Set<string>;
  apiCalls: Set<string>;
  file: string;
}

function readScreens(srcRoot: string, screensDir: string): RnScreen[] {
  // 1. Collect ALL files in src tree (for import resolution + non-screen api scan)
  const allSrcFiles = walkFiles(srcRoot, [".ts", ".tsx", ".js", ".jsx"]);
  const allFilesSet = new Set(allSrcFiles);

  // 2. Extract api URLs per file (anything that calls api.METHOD/fetch/axios)
  const urlsByFile = new Map<string, Set<string>>();
  for (const f of allSrcFiles) {
    const src = readFileSync(f, "utf8");
    const urls = extractApiUrls(src);
    if (urls.size > 0) urlsByFile.set(f, urls);
  }

  // 3. Build import graph (file → set of resolved imported files)
  const importsByFile = new Map<string, Set<string>>();
  for (const f of allSrcFiles) {
    const src = readFileSync(f, "utf8");
    const deps = new Set<string>();
    for (const m of src.matchAll(IMPORT_RE)) {
      const spec = m[6];
      const resolved = resolveImport(f, spec, allFilesSet);
      if (resolved) deps.add(resolved);
    }
    if (deps.size > 0) importsByFile.set(f, deps);
  }

  // 4. Transitive closure of imports per screen (bounded depth, no cycles)
  function transitiveDeps(start: string, maxDepth = 4): Set<string> {
    const visited = new Set<string>([start]);
    const queue: Array<[string, number]> = [[start, 0]];
    while (queue.length) {
      const [f, d] = queue.shift()!;
      if (d >= maxDepth) continue;
      for (const dep of importsByFile.get(f) ?? []) {
        if (visited.has(dep)) continue;
        visited.add(dep);
        queue.push([dep, d + 1]);
      }
    }
    return visited;
  }

  const files = walkFiles(screensDir, [".tsx", ".jsx"]);
  const out: RnScreen[] = [];
  for (const file of files) {
    const componentName = basename(file).replace(/\.(tsx|jsx)$/, "");
    if (!/Screen$/i.test(componentName)) continue;
    const src = readFileSync(file, "utf8");
    const navTo = new Set<string>();
    const apiCalls = new Set<string>();
    for (const m of src.matchAll(NAV_RE)) navTo.add(m[1]);
    for (const m of src.matchAll(LINK_TO_RE)) navTo.add(m[1]);

    // Direct api calls in screen file
    for (const u of extractApiUrls(src)) apiCalls.add(u);

    // Transitive: any imported file's api calls also count toward this screen
    for (const dep of transitiveDeps(file)) {
      for (const u of urlsByFile.get(dep) ?? []) apiCalls.add(u);
    }

    out.push({
      id: "rn-" + slugify(componentName),
      componentName,
      registeredName: componentName.replace(/Screen$/, ""),
      title: titleizeScreen(componentName),
      roles: inferRoleFromName(componentName),
      navTo, apiCalls,
      file,
    });
  }
  return out;
}

// Cap noise: if a screen ends up with > N api urls (likely because it imports
// the whole api/client.ts), keep only the most domain-relevant ones (those
// containing the screen's domain keyword in the URL).
function pruneApiCalls(screen: RnScreen, cap = 6): Set<string> {
  if (screen.apiCalls.size <= cap) return screen.apiCalls;
  const keyword = screen.registeredName.toLowerCase().replace(/(detail|edit|new|list|form|editor)$/i, "");
  if (!keyword) return new Set([...screen.apiCalls].slice(0, cap));
  const matching = [...screen.apiCalls].filter((u) => u.toLowerCase().includes(keyword));
  if (matching.length === 0) return new Set([...screen.apiCalls].slice(0, cap));
  return new Set(matching.slice(0, cap));
}

function backendStateForApiPath(apiPath: string, backendStates: State[]): State | undefined {
  // Normalize: RN calls /bookings/{var} via baseURL=/api/v1, so backend route is /api/v1/bookings/{id}
  // But backend scan may store as /bookings/{id} or /api/v1/bookings/{id} or with various wildcards
  const norm = apiPath.replace(/\{var\}/g, "{id}").replace(/\$\{[^}]+\}/g, "{id}");
  const variants = [
    norm,
    "/api/v1" + (norm.startsWith("/") ? "" : "/") + norm,
    "/api" + (norm.startsWith("/") ? "" : "/") + norm,
    norm.replace(/^\/api\/v1/, ""),
    norm.replace(/^\/api/, ""),
  ];

  function pathRegex(p: string): RegExp {
    // Convert {id}, {var}, :id, etc. to wildcards
    const esc = p
      .replace(/[.+^$|()]/g, "\\$&")
      .replace(/\{[^}]+\}/g, "[^/]+")
      .replace(/:[a-zA-Z_]+/g, "[^/]+")
      .replace(/\*/g, ".*");
    return new RegExp("^" + esc + "$");
  }

  for (const v of variants) {
    const re = pathRegex(v);
    for (const b of backendStates) if (b.path && re.test(b.path)) return b;
    for (const b of backendStates) if (b.path && pathRegex(b.path).test(v)) return b;
  }
  return undefined;
}

export function scanRnCommand(rootArg: string | undefined, opts: ScanRnOpts) {
  const root = resolve(process.cwd(), rootArg ?? ".");
  if (!existsSync(root)) { console.error(`Path not found: ${root}`); process.exit(1); }

  const srcCandidates = ["src", "app/src", "."];
  let srcRoot = root;
  for (const c of srcCandidates) {
    const p = join(root, c);
    if (existsSync(p) && statSync(p).isDirectory() && existsSync(join(p, "screens"))) { srcRoot = p; break; }
  }

  const candidates = ["src/screens", "screens", "app/screens", "src/app/screens"];
  let screensDir: string | null = null;
  for (const c of candidates) { const p = join(root, c); if (existsSync(p) && statSync(p).isDirectory()) { screensDir = p; break; } }
  if (!screensDir) { console.error(`No screens/ directory found under ${root}. Looked at: ${candidates.join(", ")}`); process.exit(1); }

  const screens = readScreens(srcRoot, screensDir);
  if (!screens.length) { console.error(`No *Screen.tsx files found in ${screensDir}`); process.exit(1); }

  // Trim each screen's apiCalls to reduce hub-of-the-universe noise
  for (const s of screens) s.apiCalls = pruneApiCalls(s);

  // Index screens by their REGISTERED name (without 'Screen') so navigation.navigate('BookingDetail') resolves
  const registeredToId = new Map<string, string>();
  for (const s of screens) {
    registeredToId.set(s.registeredName, s.id);
    registeredToId.set(s.componentName, s.id);   // also accept full name
  }

  // ─── Build new state-canvas ─────────────────────────────────
  let nextNum = 1;
  const states: State[] = [];
  const transitions: Transition[] = [];
  const idToNum = new Map<string, number>();

  const ROLE_COLS: Record<string, number> = { anon: 0, client: 1, worker: 2, dispatcher: 3, manager: 4, admin: 5, any: 6 };
  const rowPerCol = new Map<number, number>();

  for (const s of screens) {
    const col = ROLE_COLS[s.roles[0]] ?? 6;
    const row = rowPerCol.get(col) ?? 0;
    rowPerCol.set(col, row + 1);
    states.push({ num: nextNum, id: s.id, kind: "page", title: s.title, roles: s.roles, col, row });
    idToNum.set(s.id, nextNum);
    nextNum++;
  }

  for (const s of screens) {
    const fromNum = idToNum.get(s.id)!;
    for (const target of s.navTo) {
      const targetId = registeredToId.get(target);
      if (!targetId) continue;
      const toNum = idToNum.get(targetId);
      if (!toNum || toNum === fromNum) continue;
      transitions.push({ from: fromNum, to: toNum, label: `navigate(${target})` });
    }
  }

  let newDoc: FlowDoc = {
    title: basename(root) + " — RN auto-scanned",
    subtitle: `${states.length} screens · ${transitions.length} in-app navigations · ${screens.reduce((n, s) => n + s.apiCalls.size, 0)} API call sites`,
    roles: [
      { id: "anon", name: "Anonymous", color: "#64748b" },
      { id: "client", name: "Customer", color: "#c026d3" },
      { id: "worker", name: "Worker", color: "#ea580c" },
      { id: "dispatcher", name: "Dispatcher", color: "#16a34a" },
      { id: "manager", name: "Manager", color: "#2563eb" },
      { id: "admin", name: "Administrator", color: "#9333ea" },
      { id: "any", name: "Any role", color: "#64748b" },
    ],
    states, transitions, scenarios: [],
  };

  // ─── Merge into existing flows.json if --merge specified ─────
  if (opts.merge) {
    const mergePath = resolve(process.cwd(), opts.merge);
    if (!existsSync(mergePath)) { console.error(`merge target not found: ${mergePath}`); process.exit(1); }
    const existing: FlowDoc = JSON.parse(readFileSync(mergePath, "utf8"));
    const existingStates = (existing.states ?? []).filter((s) => !s.id.startsWith("rn-"));    // drop old RN states (idempotent re-merge)
    const existingIds = new Set(existingStates.map((s) => s.id));
    const existingTransitions = (existing.transitions ?? []).filter((t) =>
      existingStates.some((s) => s.num === t.from) && existingStates.some((s) => s.num === t.to)
    );
    let maxNum = Math.max(0, ...existingStates.map((s) => s.num));

    const renumMap = new Map<number, number>();
    const mergedRnStates: State[] = [];
    for (const rn of states) {
      if (existingIds.has(rn.id)) continue;
      const newNum = ++maxNum;
      renumMap.set(rn.num, newNum);
      mergedRnStates.push({ ...rn, num: newNum, col: (rn.col ?? 0) + 7 });
    }

    const mergedRnTransitions: Transition[] = transitions
      .filter((t) => renumMap.has(t.from) && renumMap.has(t.to))   // only RN→RN nav edges
      .map((t) => ({ ...t, from: renumMap.get(t.from)!, to: renumMap.get(t.to)! }));

    let crossLinks = 0;
    for (const s of screens) {
      const fromNum = renumMap.get(idToNum.get(s.id)!);
      if (!fromNum) continue;
      for (const apiPath of s.apiCalls) {
        const backend = backendStateForApiPath(apiPath, existingStates);
        if (backend) {
          mergedRnTransitions.push({ from: fromNum, to: backend.num, label: `API: ${apiPath.slice(0, 40)}`, cond: "via api client" });
          crossLinks++;
        }
      }
    }

    existing.states = [...existingStates, ...mergedRnStates];
    existing.transitions = [...existingTransitions, ...mergedRnTransitions];
    existing.roles = newDoc.roles;
    existing.title = (existing.title ?? "").replace(/\s*\+\s*RN frontend\s*$/, "") + " + RN frontend";
    existing.subtitle = `${existing.states.length} states (${existingStates.length} backend + ${mergedRnStates.length} RN screens) · ${existing.transitions.length} transitions (incl. ${crossLinks} cross-stack API edges)`;

    writeFileSync(mergePath, JSON.stringify(existing, null, 2) + "\n", "utf8");
    console.log(`✓ merged into ${opts.merge}`);
    console.log(`  ${mergedRnStates.length} RN screens added (${existingStates.length} backend untouched)`);
    console.log(`  ${mergedRnTransitions.length - crossLinks} intra-RN navigation edges + ${crossLinks} cross-stack API edges`);
    console.log(`  total states now: ${existing.states.length}, transitions: ${existing.transitions.length}`);
    return;
  }

  const outPath = resolve(process.cwd(), opts.out);
  writeFileSync(outPath, JSON.stringify(newDoc, null, 2) + "\n", "utf8");
  console.log(`✓ wrote ${opts.out}: ${states.length} RN screens, ${transitions.length} navigation transitions`);
  console.log(`  next: flowdoc scan-rn ${rootArg ?? "."} --merge backend-flows.json  (to cross-link with backend)`);
}
