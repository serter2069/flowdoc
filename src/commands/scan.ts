import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import fg from "fast-glob";
import type { FlowDoc, Screen, ScreenKind } from "../schema.js";

type Framework = "next" | "expo" | "auto";

interface ScanOpts {
  out: string;
  framework: Framework;
  merge: boolean;
}

interface DetectedRoute {
  id: string;
  name: string;
  kind: ScreenKind;
  group: string;
  path: string;
  file: string;
  navTo: string[];
  components: string[];
}

const COMPONENT_IMPORT_RE = /import\s+(?:\{([^}]+)\}|([A-Z][A-Za-z0-9_]*))\s+from\s+["']([^"']+)["']/g;
const HREF_RE = /(?:href|to)=["'](\/[^"'?#]*)/g;
const ROUTER_PUSH_RE = /(?:router|navigation)\.(?:push|replace|navigate)\s*\(\s*["'`]([^"'`)]+)/g;

function detectFramework(root: string): Framework {
  if (existsSync(join(root, "app.json")) || existsSync(join(root, "app.config.ts")) || existsSync(join(root, "app.config.js"))) return "expo";
  if (existsSync(join(root, "next.config.js")) || existsSync(join(root, "next.config.ts")) || existsSync(join(root, "next.config.mjs"))) return "next";
  const pkgPath = join(root, "package.json");
  if (existsSync(pkgPath)) {
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
    const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
    if (deps["expo"] || deps["expo-router"]) return "expo";
    if (deps["next"]) return "next";
  }
  return "next";
}

function findAppDir(root: string): string | null {
  const candidates = ["app", "src/app", "apps/web/app", "apps/admin/app"];
  for (const c of candidates) {
    const p = join(root, c);
    if (existsSync(p) && statSync(p).isDirectory()) return p;
  }
  return null;
}

function dirToRoute(appDir: string, fileAbsPath: string): string {
  const rel = relative(appDir, dirname(fileAbsPath));
  if (!rel) return "/";
  const parts = rel.split(sep).filter((p) => !p.startsWith("(") || !p.endsWith(")"));
  const route = parts
    .map((p) => {
      if (p.startsWith("[...") && p.endsWith("]")) return `:${p.slice(4, -1)}*`;
      if (p.startsWith("[") && p.endsWith("]")) return `:${p.slice(1, -1)}`;
      return p;
    })
    .join("/");
  return "/" + route;
}

function topLevelGroup(appDir: string, fileAbsPath: string): string {
  const rel = relative(appDir, dirname(fileAbsPath));
  if (!rel) return "root";
  const first = rel.split(sep)[0];
  if (first.startsWith("(") && first.endsWith(")")) return first.slice(1, -1);
  return first;
}

function inferKind(route: string, file: string): ScreenKind {
  const lower = (route + " " + file).toLowerCase();
  if (/\b(login|signin|signup|register|forgot|reset-password|auth)\b/.test(lower)) return "auth";
  if (/\bmodal\b/.test(lower)) return "modal";
  if (/\(tabs?\)/.test(file)) return "tab";
  if (/\(public\)|\/public\//.test(lower) || route === "/") return route === "/" ? "public" : "public";
  return "screen";
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "root";
}

function routeToId(route: string): string {
  if (route === "/") return "root";
  return slugify(route.replace(/:/g, ""));
}

function humanName(route: string): string {
  if (route === "/") return "Home";
  const last = route.split("/").filter(Boolean).pop() ?? "screen";
  return last
    .replace(/^:/, "")
    .replace(/[-_]/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function extractFromSource(src: string): { components: string[]; hrefs: string[] } {
  const components = new Set<string>();
  for (const m of src.matchAll(COMPONENT_IMPORT_RE)) {
    const named = m[1];
    const def = m[2];
    if (named) {
      for (const n of named.split(",")) {
        const clean = n.trim().split(/\s+as\s+/)[0].trim();
        if (/^[A-Z]/.test(clean)) components.add(clean);
      }
    }
    if (def && /^[A-Z]/.test(def)) components.add(def);
  }
  const hrefs = new Set<string>();
  for (const m of src.matchAll(HREF_RE)) hrefs.add(m[1]);
  for (const m of src.matchAll(ROUTER_PUSH_RE)) {
    const target = m[1];
    if (target.startsWith("/")) hrefs.add(target);
  }
  return { components: [...components], hrefs: [...hrefs] };
}

function routeMatches(target: string, allRoutes: Map<string, string>): string | null {
  if (allRoutes.has(target)) return allRoutes.get(target)!;
  const targetParts = target.split("/").filter(Boolean);
  for (const [route, id] of allRoutes) {
    const parts = route.split("/").filter(Boolean);
    if (parts.length !== targetParts.length) continue;
    let ok = true;
    for (let i = 0; i < parts.length; i++) {
      if (parts[i].startsWith(":")) continue;
      if (parts[i] !== targetParts[i]) {
        ok = false;
        break;
      }
    }
    if (ok) return id;
  }
  return null;
}

async function scanNext(root: string): Promise<DetectedRoute[]> {
  const appDir = findAppDir(root);
  if (!appDir) throw new Error(`No app/ or src/app/ directory found under ${root}. Pass --dir explicitly.`);
  const files = await fg(["**/page.{tsx,ts,jsx,js}", "**/route.{ts,js}"], { cwd: appDir, absolute: true });
  const routes: DetectedRoute[] = [];
  const seen = new Map<string, DetectedRoute>();
  for (const file of files) {
    const route = dirToRoute(appDir, file);
    const id = routeToId(route);
    if (seen.has(id)) continue;
    const src = readFileSync(file, "utf8");
    const { components, hrefs } = extractFromSource(src);
    const det: DetectedRoute = {
      id,
      name: humanName(route),
      kind: inferKind(route, file),
      group: topLevelGroup(appDir, file),
      path: route,
      file: relative(root, file),
      navTo: hrefs,
      components: components.slice(0, 10),
    };
    seen.set(id, det);
    routes.push(det);
  }
  // Resolve hrefs → screen ids
  const routeMap = new Map(routes.map((r) => [r.path, r.id]));
  for (const r of routes) {
    const ids = new Set<string>();
    for (const href of r.navTo) {
      const hit = routeMatches(href, routeMap);
      if (hit && hit !== r.id) ids.add(hit);
    }
    r.navTo = [...ids];
  }
  return routes;
}

async function scanExpo(root: string): Promise<DetectedRoute[]> {
  // Expo Router uses the same app/ convention as Next, with extra (tabs)/(stack) groups.
  return scanNext(root);
}

function toFlowDoc(detected: DetectedRoute[], title: string): FlowDoc {
  const groups = [...new Set(detected.map((r) => r.group))].map((g) => ({ id: slugify(g), name: g.charAt(0).toUpperCase() + g.slice(1) }));
  const screens: Screen[] = detected.map((r) => ({
    id: r.id,
    name: r.name,
    kind: r.kind,
    group: slugify(r.group),
    path: r.path,
    components: r.components.length ? r.components : undefined,
    navTo: r.navTo.length ? r.navTo : undefined,
  }));
  return {
    title,
    subtitle: `Auto-scanned ${new Date().toISOString().slice(0, 10)} (${screens.length} screens)`,
    groups,
    screens,
  };
}

function mergeFlowDocs(existing: FlowDoc, fresh: FlowDoc): FlowDoc {
  const existingById = new Map((existing.screens ?? []).map((s) => [s.id, s]));
  const merged: Screen[] = (fresh.screens ?? []).map((s) => {
    const old = existingById.get(s.id);
    if (!old) return s;
    return {
      ...s,
      roles: old.roles ?? s.roles,
      description: old.description ?? s.description,
      components: old.components?.length ? old.components : s.components,
      navTo: old.navTo?.length ? old.navTo : s.navTo,
    };
  });
  const freshIds = new Set((fresh.screens ?? []).map((s) => s.id));
  const orphans = (existing.screens ?? []).filter((s) => !freshIds.has(s.id));
  return {
    ...existing,
    ...fresh,
    roles: existing.roles ?? fresh.roles,
    groups: fresh.groups,
    screens: [...merged, ...orphans],
  };
}

export async function scanCommand(dirArg: string | undefined, opts: ScanOpts) {
  const root = resolve(process.cwd(), dirArg ?? ".");
  if (!existsSync(root)) {
    console.error(`Path not found: ${root}`);
    process.exit(1);
  }
  const fw = opts.framework === "auto" ? detectFramework(root) : opts.framework;
  console.log(`✓ framework: ${fw}`);
  const detected = fw === "expo" ? await scanExpo(root) : await scanNext(root);
  if (!detected.length) {
    console.error("No routes found. Check that you ran from the project root and have an app/ directory.");
    process.exit(1);
  }
  const title = basename(root) || "Sitemap";
  let doc = toFlowDoc(detected, title);
  const outPath = resolve(process.cwd(), opts.out);
  if (opts.merge && existsSync(outPath)) {
    const existing = JSON.parse(readFileSync(outPath, "utf8")) as FlowDoc;
    doc = mergeFlowDocs(existing, doc);
    console.log(`✓ merged with existing ${opts.out} (preserved roles, descriptions, manual edits)`);
  }
  writeFileSync(outPath, JSON.stringify(doc, null, 2) + "\n", "utf8");
  const navCount = (doc.screens ?? []).reduce((n, s) => n + (s.navTo?.length ?? 0), 0);
  console.log(`✓ ${opts.out}: ${(doc.screens ?? []).length} screens, ${navCount} nav edges`);
  console.log(`  Next: flowdoc build ${opts.out} && open flowdoc.html`);
}
