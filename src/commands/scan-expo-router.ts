import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { extractActionsFromJsx } from "./jsx-actions.js";
import { scanOrvalHooks, extractActionsFromOrvalHooks } from "./orval-hooks.js";
import type { StateAction } from "../schema.js";
import { basename, join, relative, resolve, sep } from "node:path";
import type { FlowDoc, State, Transition } from "../schema.js";

interface ScanExpoOpts {
  out: string;
  merge?: string;
}

const API_URL_RE = /\bapi\s*\.\s*(?:get|post|put|patch|delete)\s*<[^>]*>?\s*\(\s*[`'"]([^`'"]+)[`'"]|\bapi\s*\.\s*(?:get|post|put|patch|delete)\s*\(\s*[`'"]([^`'"]+)[`'"]/g;
const FETCH_RE = /\bfetch\s*\(\s*['"`]([^'"`]+)['"`]/g;
const AXIOS_RE = /\baxios\s*\.\s*(?:get|post|put|patch|delete)\s*\(\s*['"`]([^'"`]+)['"`]/g;
// expo-router navigation: router.push("/foo"), router.replace("/bar"), router.navigate("/baz")
const NAV_RE = /\brouter\s*\.\s*(?:push|replace|navigate)\s*\(\s*['"`]([^'"`]+)['"`]/g;
// expo-router navigation with object: router.push({ pathname: "/listing/[id]", ... })
const NAV_PATHNAME_RE = /\brouter\s*\.\s*(?:push|replace|navigate)\s*\(\s*\{\s*pathname\s*:\s*['"`]([^'"`]+)['"`]/g;
// <Link href="/foo"> or <Link href={`/listing/${id}`}>
const LINK_HREF_RE = /<Link\s+[^>]*href\s*=\s*['"`]([^'"`{}]+)['"`]/g;
const LINK_HREF_TPL_RE = /<Link\s+[^>]*href\s*=\s*\{`([^`$]+)/g;

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

function titleize(name: string): string {
  return name.replace(/-([a-z])/g, (_m, c) => " " + c.toUpperCase())
    .replace(/^./, (c) => c.toUpperCase())
    .replace(/\[([^\]]+)\]/g, ":$1");
}

/** Derive route path from file path inside app/ */
function filePathToRoute(appRoot: string, file: string): string {
  let rel = relative(appRoot, file).split(sep).join("/");
  rel = rel.replace(/\.(tsx|jsx|ts|js)$/, "");
  // Drop expo-router groupings: (tabs)/foo → /foo
  rel = rel.replace(/\(([^)]+)\)\//g, "");
  rel = rel.replace(/^\(([^)]+)\)$/g, "");
  // index → ""
  rel = rel.replace(/\/index$/, "").replace(/^index$/, "");
  return "/" + rel;
}

function inferRoleFromRoute(route: string): string[] {
  const n = route.toLowerCase();
  if (n.startsWith("/auth") || n.startsWith("/onboarding")) return ["anon"];
  if (n.startsWith("/admin")) return ["admin"];
  if (n.startsWith("/seller")) return ["seller"];
  if (n.startsWith("/my-listings") || n.startsWith("/new-listing") || n.startsWith("/listing-edit") || n.startsWith("/promote") || n.startsWith("/notifications") || n.startsWith("/settings") || n.startsWith("/recently-viewed")) return ["user"];
  if (n.startsWith("/listing") || n.startsWith("/users/") || n.startsWith("/conversation") || n === "/" || n.startsWith("/search") || n.startsWith("/favorites") || n.startsWith("/messages") || n.startsWith("/profile") || n.startsWith("/new") || n.startsWith("/credit")) return ["any"];
  return ["any"];
}

function extractApiUrls(src: string): Set<string> {
  const urls = new Set<string>();
  for (const m of src.matchAll(API_URL_RE)) {
    const u = m[1] ?? m[2];
    if (!u) continue;
    urls.add(u.replace(/\$\{[^}]+\}/g, "{var}"));
  }
  for (const m of src.matchAll(FETCH_RE)) {
    const u = m[1];
    if (u.startsWith("/") || u.startsWith("http")) urls.add(u.replace(/\$\{[^}]+\}/g, "{var}"));
  }
  for (const m of src.matchAll(AXIOS_RE)) urls.add(m[1].replace(/\$\{[^}]+\}/g, "{var}"));
  return urls;
}

interface ExpoScreen {
  id: string;
  route: string;            // "/", "/auth", "/listing/[id]"
  routeKey: string;         // normalized to "/listing/:id" for matching nav targets
  title: string;
  roles: string[];
  navTo: Set<string>;       // route strings (normalized)
  apiCalls: Set<string>;
  actions: StateAction[];   // JSX-extracted button actions
  file: string;
}

/** Normalize a navigation target: collapse template literals + dynamic segments. */
function normalizeNavTarget(raw: string): string {
  let s = raw.split("?")[0].split("#")[0];
  // ${id} → :id, [id] stays, but unify to :id form
  s = s.replace(/\$\{[^}]+\}/g, ":id");
  s = s.replace(/\[([^\]]+)\]/g, ":$1");
  // strip trailing slash (but keep "/")
  if (s.length > 1 && s.endsWith("/")) s = s.slice(0, -1);
  return s;
}

function routeKeyFromFileRoute(route: string): string {
  return normalizeNavTarget(route);
}

function readScreens(appRoot: string, orvalHookMap: Map<string, any>): ExpoScreen[] {
  const files = walkFiles(appRoot, [".tsx", ".jsx"]);
  const screens: ExpoScreen[] = [];
  for (const file of files) {
    const fname = basename(file);
    // Skip layouts + expo-router special files
    if (fname === "_layout.tsx" || fname === "_layout.jsx") continue;
    if (fname.startsWith("+")) continue;            // +not-found, +html, etc.

    const route = filePathToRoute(appRoot, file);
    const routeKey = routeKeyFromFileRoute(route);
    const src = readFileSync(file, "utf8");

    const navTo = new Set<string>();
    for (const m of src.matchAll(NAV_RE)) navTo.add(normalizeNavTarget(m[1]));
    for (const m of src.matchAll(NAV_PATHNAME_RE)) navTo.add(normalizeNavTarget(m[1]));
    for (const m of src.matchAll(LINK_HREF_RE)) navTo.add(normalizeNavTarget(m[1]));
    for (const m of src.matchAll(LINK_HREF_TPL_RE)) navTo.add(normalizeNavTarget(m[1]));

    const apiCalls = extractApiUrls(src);
    // Merge JSX-extracted actions with orval react-query hook references.
    // Dedupe by (kind, expect) so the same endpoint reached two ways shows once.
    const jsxActions = extractActionsFromJsx(src);
    const hookActions = extractActionsFromOrvalHooks(src, orvalHookMap);
    const seen = new Set<string>();
    const actions: StateAction[] = [];
    for (const a of [...jsxActions, ...hookActions]) {
      const key = `${a.kind}:${a.expect ?? a.target}`;
      if (seen.has(key)) continue;
      seen.add(key);
      actions.push(a);
    }

    const idBase = route === "/" ? "home" : route.replace(/^\//, "").replace(/[\/\[\]]/g, "-");
    screens.push({
      id: "expo-" + slugify(idBase || "home"),
      route,
      routeKey,
      title: route === "/" ? "Home" : titleize(route.replace(/^\//, "")),
      roles: inferRoleFromRoute(route),
      navTo,
      apiCalls,
      actions,
      file,
    });
  }
  return screens;
}

interface ApiRoute {
  method: string;
  path: string;
  file: string;
}

function scanExpressRoutes(routesDir: string): ApiRoute[] {
  if (!existsSync(routesDir)) return [];
  const out: ApiRoute[] = [];
  const files = walkFiles(routesDir, [".ts", ".js"]);
  // router.get('/path', ...), router.post('/foo/:id', ...)
  // Routes in this codebase already define their full path (e.g. /auth/login,
  // /admin/withdrawals). We don't prepend the filename — the index.ts mounts
  // each sub-router at "/" so the path inside the router IS the public path.
  const ROUTE_RE = /\brouter\s*\.\s*(get|post|put|patch|delete)\s*\(\s*['"`]([^'"`]+)['"`]/g;
  for (const f of files) {
    const src = readFileSync(f, "utf8");
    for (const m of src.matchAll(ROUTE_RE)) {
      let p = m[2];
      if (!p.startsWith("/")) p = "/" + p;
      p = p.replace(/\/+$/, "") || "/";
      out.push({ method: m[1].toUpperCase(), path: p, file: f });
    }
  }
  return out;
}

export function scanExpoCommand(rootArg: string | undefined, opts: ScanExpoOpts) {
  const root = resolve(process.cwd(), rootArg ?? ".");
  if (!existsSync(root)) { console.error(`Path not found: ${root}`); process.exit(1); }

  // Find app/ dir
  const candidates = ["app", "src/app"];
  let appRoot: string | null = null;
  for (const c of candidates) {
    const p = join(root, c);
    if (existsSync(p) && statSync(p).isDirectory()) { appRoot = p; break; }
  }
  if (!appRoot) { console.error(`No app/ directory found under ${root}. Looked at: ${candidates.join(", ")}`); process.exit(1); }

  // Look for sibling orval-generated react-query hooks so we can attribute
  // mutations (useDeleteFavorite, claim.mutateAsync, …) to screens.
  // Typical pnpm-workspace layout: artifacts/dressdrop/  →  ../../lib/api-client-react
  const orvalCandidates = [
    resolve(root, "../../lib/api-client-react/src/generated"),
    resolve(root, "../lib/api-client-react/src/generated"),
    resolve(root, "../api-client-react/src/generated"),
  ];
  let orvalHookMap = new Map<string, any>();
  for (const c of orvalCandidates) {
    if (existsSync(c)) { orvalHookMap = scanOrvalHooks(c); console.log(`  + orval hooks resolved: ${orvalHookMap.size / 2} endpoints from ${c}`); break; }
  }

  const screens = readScreens(appRoot, orvalHookMap);
  if (!screens.length) { console.error(`No route files found in ${appRoot}`); process.exit(1); }

  // Build map from route-key → screen id
  const routeToId = new Map<string, string>();
  for (const s of screens) routeToId.set(s.routeKey, s.id);

  // ─── Build new state-canvas ─────────────────────────────────
  let nextNum = 1;
  const states: State[] = [];
  const transitions: Transition[] = [];
  const idToNum = new Map<string, number>();

  const ROLE_COLS: Record<string, number> = { anon: 0, any: 1, user: 2, seller: 3, admin: 4 };
  const rowPerCol = new Map<number, number>();

  for (const s of screens) {
    const col = ROLE_COLS[s.roles[0]] ?? 1;
    const row = rowPerCol.get(col) ?? 0;
    rowPerCol.set(col, row + 1);
    states.push({
      num: nextNum,
      id: s.id,
      kind: "page",
      title: s.title,
      path: s.route,
      roles: s.roles,
      col, row,
      desc: s.apiCalls.size ? `API calls: ${[...s.apiCalls].slice(0, 5).join(", ")}${s.apiCalls.size > 5 ? "…" : ""}` : undefined,
      ...(s.actions.length ? { actions: s.actions } : {}),
    });
    idToNum.set(s.id, nextNum);
    nextNum++;
  }

  for (const s of screens) {
    const fromNum = idToNum.get(s.id)!;
    for (const target of s.navTo) {
      const targetId = routeToId.get(target);
      if (!targetId) continue;
      const toNum = idToNum.get(targetId);
      if (!toNum || toNum === fromNum) continue;
      // Dedupe: skip if already exists
      if (transitions.some((t) => t.from === fromNum && t.to === toNum)) continue;
      transitions.push({ from: fromNum, to: toNum, label: `router.push(${target})` });
    }
  }

  // ─── Optional: backend API states from sibling api-server/src/routes ───
  let apiCount = 0;
  let crossLinks = 0;
  const apiServerDir = resolve(root, "../api-server/src/routes");
  // Map from a canonical path (e.g. "/posts/:id") → backend state num
  const apiPathToNum = new Map<string, number>();
  if (existsSync(apiServerDir)) {
    const apiRoutes = scanExpressRoutes(apiServerDir);
    // Group by file (resource)
    const byFile = new Map<string, ApiRoute[]>();
    for (const r of apiRoutes) {
      const k = basename(r.file).replace(/\.(ts|js)$/, "");
      if (!byFile.has(k)) byFile.set(k, []);
      byFile.get(k)!.push(r);
    }
    const backendCol = 5;
    let backendRow = 0;
    // Collapse routes sharing the same path: one state per path, methods
    // listed together. e.g. GET/POST/DELETE /listings/:id → one card titled
    // "/listings/:id · GET POST DELETE". Cuts API card count by ~30% for
    // typical REST APIs and matches how a tester thinks about endpoints.
    for (const [resource, routes] of byFile) {
      const byPath = new Map<string, ApiRoute[]>();
      for (const r of routes) {
        if (!byPath.has(r.path)) byPath.set(r.path, []);
        byPath.get(r.path)!.push(r);
      }
      for (const [pth, routesForPath] of byPath) {
        const methods = [...new Set(routesForPath.map((r) => r.method))].sort();
        const id = "api-" + slugify(pth);
        states.push({
          num: nextNum,
          id,
          kind: "api",
          title: `${pth} · ${methods.join(" ")}`,
          path: pth,
          roles: ["api"],
          col: backendCol,
          row: backendRow,
          desc: `Express route in ${resource}.ts · methods: ${methods.join(", ")}`,
        });
        idToNum.set(id, nextNum);
        const canonical = pth.replace(/\{var\}/g, ":id");
        apiPathToNum.set(canonical, nextNum);
        nextNum++;
        backendRow++;
        apiCount++;
      }
    }

    // ─── Cross-stack edges: RN screen → backend API endpoint it calls ───
    // Match each screen's apiCalls (collected from api.METHOD/fetch/axios) to
    // a discovered Express route by canonical path. Wildcards on either side
    // are treated as single-segment matches.
    function matchApiCallToBackend(call: string): number | undefined {
      const c = call.replace(/\{var\}/g, ":id").split("?")[0];
      // Strip baseURL prefix if any (api client uses /api/v1 or just /)
      const stripped = c.replace(/^\/api(\/v\d+)?/, "");
      const candidates = [c, stripped, "/api" + stripped, "/api/v1" + stripped]
        .filter((x) => x && x !== "/");
      for (const v of candidates) {
        if (apiPathToNum.has(v)) return apiPathToNum.get(v);
        // segment-wildcard match
        const vSegs = v.split("/");
        for (const [p, num] of apiPathToNum) {
          const pSegs = p.split("/");
          if (pSegs.length !== vSegs.length) continue;
          let ok = true;
          for (let i = 0; i < pSegs.length; i++) {
            const a = pSegs[i]; const b = vSegs[i];
            if (a === b) continue;
            if (a.startsWith(":") || b.startsWith(":")) continue;
            ok = false; break;
          }
          if (ok) return num;
        }
      }
      return undefined;
    }

    for (const s of screens) {
      const fromNum = idToNum.get(s.id);
      if (!fromNum) continue;
      const seenEdges = new Set<number>();
      for (const call of s.apiCalls) {
        const toNum = matchApiCallToBackend(call);
        if (!toNum || seenEdges.has(toNum)) continue;
        seenEdges.add(toNum);
        transitions.push({
          from: fromNum,
          to: toNum,
          label: `API ${call.slice(0, 40)}`,
          cond: "api",
        });
        crossLinks++;
      }
    }
  }

  const newDoc: FlowDoc = {
    title: basename(root) + " — Expo Router auto-scan",
    subtitle: `${screens.length} screens · ${transitions.length} transitions${apiCount ? ` · ${apiCount} backend API routes` : ""}${crossLinks ? ` (incl. ${crossLinks} cross-stack API edges)` : ""}`,
    roles: [
      { id: "anon", name: "Anonymous", color: "#64748b" },
      { id: "any", name: "Any visitor", color: "#0ea5e9" },
      { id: "user", name: "Logged-in user", color: "#2563eb" },
      { id: "seller", name: "Seller", color: "#ea580c" },
      { id: "admin", name: "Administrator", color: "#9333ea" },
      { id: "api", name: "Backend API", color: "#16a34a" },
    ],
    states,
    transitions,
    scenarios: [],
  };

  if (opts.merge) {
    const mergePath = resolve(process.cwd(), opts.merge);
    if (!existsSync(mergePath)) { console.error(`merge target not found: ${mergePath}`); process.exit(1); }
    const existing: FlowDoc = JSON.parse(readFileSync(mergePath, "utf8"));
    existing.states = [...(existing.states ?? []), ...states];
    existing.transitions = [...(existing.transitions ?? []), ...transitions];
    writeFileSync(mergePath, JSON.stringify(existing, null, 2) + "\n", "utf8");
    console.log(`✓ merged ${states.length} states into ${opts.merge}`);
    return;
  }

  const outPath = resolve(process.cwd(), opts.out);
  writeFileSync(outPath, JSON.stringify(newDoc, null, 2) + "\n", "utf8");
  console.log(`✓ wrote ${opts.out}: ${screens.length} screens, ${transitions.length} transitions${apiCount ? `, ${apiCount} API routes` : ""}${crossLinks ? ` (${crossLinks} cross-stack)` : ""}`);
}
