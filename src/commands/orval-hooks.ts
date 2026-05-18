import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { StateAction } from "../schema.js";

/**
 * Parses orval-generated react-query hooks and returns a Map<hookName, endpoint>.
 *
 * Typical orval v8 output:
 *
 *   export const getClaimListingUrl = (id: string) => `/api/listings/${id}/claim`;
 *   export const claimListing = async (...) => customFetch(getClaimListingUrl(id), { method: "POST" });
 *   export const useClaimListing = <...>(options?) => useMutation(...);
 *
 * Each endpoint is registered under BOTH `claimListing` and `useClaimListing`
 * so consumer code that calls either form is matched.
 *
 * ── Known edge cases / limitations ─────────────────────────────────────────
 *  • orval v8 (current): supported. AresGun + DressIT both emit this shape.
 *  • orval v7 and earlier: fallback path-extractor reads an inline template
 *    literal (`/api/foo/${id}`) directly from the function body when no
 *    separate `getXxxUrl` builder is found.
 *  • Custom-mutator output where the HTTP method is positional (e.g.
 *    `axios.post(url, body)` instead of `customFetch(url, { method: "POST" })`):
 *    NOT supported — we look only for the `method: "VERB"` key. Workaround:
 *    configure orval to use the customFetch output mode.
 *  • Split-file output (URL builders in endpoints.ts, raw funcs in
 *    mutations.ts): supported. urlByBuilder is built globally across every
 *    file in the directory before scanning raw functions.
 *  • Multi-param paths like `/posts/${postId}/comments/${commentId}`:
 *    supported (regex is /g over every ${…} placeholder). Dot-expressions
 *    (`${args.id}`) and call-expressions (`${getId()}`) collapse to `:id`.
 *  • Aliased imports (`import { useFoo as useBar } from '...'`): NOT
 *    supported. Local alias `useBar.mutate(...)` won't match the original
 *    hook-name regex. Low frequency in practice; would need import-graph
 *    awareness to fix.
 *  • Hook-name collisions with local non-orval hooks of the same name: we'd
 *    falsely attribute. Mitigation would require verifying the import source.
 *  • Missing api-spec / generated dir: returns an empty Map (silent no-op).
 *  • Generated file location varies by project layout — `scan-expo-router`
 *    auto-probes `../../lib/`, `../lib/`, `../api-client-react/src/generated`.
 *    Lerna/Turborepo `packages/` layouts may need a manual hint.
 */

export interface OrvalEndpoint {
  method: string;          // "POST" | "DELETE" | …
  path: string;            // "/api/listings/:id/claim"
  rawName: string;         // "claimListing"
  hookName: string;        // "useClaimListing"
}

function walk(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const f of readdirSync(dir)) {
    // Match scan-expo-router's walk: never recurse into noise dirs. Orval's
    // own generated dir might contain a stub node_modules during local
    // development, and re-walking it would balloon the file list 100x.
    if (f === "node_modules" || f === "dist" || f === ".turbo" || f === ".next") continue;
    const fp = join(dir, f);
    const s = statSync(fp);
    if (s.isDirectory()) walk(fp, out);
    else if (f.endsWith(".ts") || f.endsWith(".tsx")) out.push(fp);
  }
  return out;
}

function normalizePath(tpl: string): string {
  // `/api/listings/${id}/claim` → /api/listings/:id/claim
  // Dotted / call expressions inside `${…}` collapse to a generic `:id`.
  return tpl
    .replace(/\$\{([a-zA-Z_$][\w$]*)\}/g, ":$1")
    .replace(/\$\{[^}]+\}/g, ":id")
    .replace(/^\/+/, "/");
}

export function scanOrvalHooks(rootDir: string): Map<string, OrvalEndpoint> {
  const out = new Map<string, OrvalEndpoint>();
  if (!existsSync(rootDir)) return out;
  const files = walk(rootDir);
  if (files.length === 0) return out;

  // ── Pass 1: build the URL-builder map across EVERY file in the dir ───────
  // Orval can split URL builders and raw functions across files; a per-file
  // map would lose those cross-references.
  const urlByBuilder = new Map<string, string>();
  for (const file of files) {
    const src = readFileSync(file, "utf8");
    const builderArrow = /export\s+const\s+(get\w+Url)\s*=\s*\([^)]*\)\s*(?::\s*[^=>]+)?\s*=>\s*`([^`]+)`/g;
    for (const m of src.matchAll(builderArrow)) urlByBuilder.set(m[1], normalizePath(m[2]));
    const builderBlock = /export\s+const\s+(get\w+Url)\s*=[\s\S]*?return\s+`([^`]+)`/g;
    for (const m of src.matchAll(builderBlock)) {
      if (!urlByBuilder.has(m[1])) urlByBuilder.set(m[1], normalizePath(m[2]));
    }
  }

  // ── Pass 2: extract raw async functions and resolve their { method, path } ─
  // Regex-only fails on orval output because the return-type annotation
  // contains `>` chars (e.g. `: Promise<ClaimListingResponse>`), so we
  // brace-walk the parameter list, then walk past any annotation to the
  // arrow + opening brace, then brace-walk the body.
  for (const file of files) {
    const src = readFileSync(file, "utf8");
    const headerRe = /export\s+const\s+(\w+)\s*=\s*async\s*\(/g;
    for (const m of src.matchAll(headerRe)) {
      const rawName = m[1];
      let i = (m.index ?? 0) + m[0].length;
      let depth = 1;
      while (i < src.length && depth > 0) {
        const c = src[i];
        if (c === "(") depth++;
        else if (c === ")") depth--;
        i++;
      }
      const arrowIdx = src.indexOf("=>", i);
      if (arrowIdx < 0) continue;
      const braceIdx = src.indexOf("{", arrowIdx);
      if (braceIdx < 0 || braceIdx - arrowIdx > 200) continue;
      let bd = 1;
      let j = braceIdx + 1;
      while (j < src.length && bd > 0) {
        const c = src[j];
        if (c === "{") bd++;
        else if (c === "}") bd--;
        j++;
      }
      const body = src.slice(braceIdx + 1, j - 1);

      const methodMatch = /method\s*:\s*["'`](GET|POST|PUT|PATCH|DELETE)["'`]/i.exec(body);
      if (!methodMatch) continue;
      const method = methodMatch[1].toUpperCase();

      // Resolve URL: prefer the v8 builder reference (getXxxUrl); fall back
      // to an inline template literal in the body (orval v7 / customMutator).
      let path: string | undefined;
      const builderMatch = /\b(get\w+Url)\s*\(/.exec(body);
      if (builderMatch) path = urlByBuilder.get(builderMatch[1]);
      if (!path) {
        const inlineTpl = /`(\/api\/[^`]+)`|`(\/[^`]+)`/.exec(body);
        if (inlineTpl) path = normalizePath(inlineTpl[1] ?? inlineTpl[2]);
      }
      if (!path) continue;

      const hookName = "use" + rawName.charAt(0).toUpperCase() + rawName.slice(1);
      const entry: OrvalEndpoint = { method, path, rawName, hookName };
      out.set(rawName, entry);
      out.set(hookName, entry);
    }
  }
  return out;
}

function methodToKind(method: string): StateAction["kind"] | null {
  switch (method.toUpperCase()) {
    case "DELETE": return "delete";
    case "POST":   return "add";
    case "PUT":
    case "PATCH":  return "edit";
    case "GET":    return null;
    default:       return "submit";
  }
}

function labelFromHookName(hookName: string): string {
  // useDeleteFavorite → "delete favorite"
  return hookName
    .replace(/^use/, "")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .slice(0, 32);
}

/**
 * Walk a screen source file looking for references to known orval hook names.
 * Emit one StateAction per unique hook hit (one action per endpoint, not per
 * call-site — the same action triggered from multiple buttons is still ONE
 * testable thing).
 *
 * Covers:
 *   • `useDeleteFavorite()` standalone
 *   • `const mut = useDeleteFavorite();` then `mut.mutate(...)`
 *   • `useDeleteFavorite({ onSuccess: ... }).mutateAsync(...)`
 *   • direct raw-function call `deleteFavorite(id)`
 */
export function extractActionsFromOrvalHooks(
  src: string,
  hookMap: Map<string, OrvalEndpoint>
): StateAction[] {
  if (hookMap.size === 0) return [];
  const found = new Map<string, OrvalEndpoint>();  // dedup key: hookName

  // Match longest names first so e.g. `useDelete` doesn't shadow `useDeleteFavorite`.
  const names = [...hookMap.keys()].sort((a, b) => b.length - a.length);
  if (names.length === 0) return [];
  const re = new RegExp(
    "\\b(" + names.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|") + ")\\b",
    "g"
  );

  for (const m of src.matchAll(re)) {
    const entry = hookMap.get(m[1]);
    if (!entry) continue;
    if (found.has(entry.hookName)) continue;
    found.set(entry.hookName, entry);
  }

  const actions: StateAction[] = [];
  for (const entry of found.values()) {
    const kind = methodToKind(entry.method);
    if (!kind) continue;  // skip GET (reads, not user-actions worth listing)
    actions.push({
      kind,
      target: labelFromHookName(entry.hookName),
      expect: `${entry.method} ${entry.path}`,
    });
  }
  return actions;
}
