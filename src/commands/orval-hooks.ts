import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { StateAction } from "../schema.js";

/**
 * Parses orval-generated react-query hooks (under <repo>/lib/api-client-react/src/generated/)
 * and returns a Map<hookName, { method, path }>.
 *
 * Pattern emitted by orval (v8+):
 *
 *   export const getClaimListingUrl = (id: string) => `/api/listings/${id}/claim`;
 *   export const claimListing = async (...) => customFetch(getClaimListingUrl(id), { method: "POST" });
 *   export const useClaimListing = <...>(options?) => useMutation(...);
 *
 * We extract by parsing the *raw* async function — it has both the URL-builder
 * reference AND the method string. Then we register BOTH the raw name
 * (`claimListing`) and the hook name (`useClaimListing`) under the same target.
 *
 * AresGun (lib/api-client-react/src/generated/api.ts) and DressIT
 * (artifacts/dressdrop/../lib/api-client-react/src/generated/api.ts) both follow
 * this convention.
 */

export interface OrvalEndpoint {
  method: string;          // "POST" | "DELETE" | ...
  path: string;            // "/api/listings/:id/claim"
  rawName: string;         // "claimListing"
  hookName: string;        // "useClaimListing"
}

function walk(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const f of readdirSync(dir)) {
    const fp = join(dir, f);
    const s = statSync(fp);
    if (s.isDirectory()) walk(fp, out);
    else if (f.endsWith(".ts") || f.endsWith(".tsx")) out.push(fp);
  }
  return out;
}

function normalizePath(tpl: string): string {
  // `/api/listings/${id}/claim` → /api/listings/:id/claim
  return tpl.replace(/\$\{([a-zA-Z_$][\w$]*)\}/g, ":$1").replace(/^\/+/, "/");
}

export function scanOrvalHooks(rootDir: string): Map<string, OrvalEndpoint> {
  const out = new Map<string, OrvalEndpoint>();
  if (!existsSync(rootDir)) return out;
  const files = walk(rootDir);

  for (const file of files) {
    const src = readFileSync(file, "utf8");

    // 1. Build URL-builder → path map within this file
    //    pattern: `export const getXxxUrl = (...) => \`/api/...\`;` or `return \`/api/...\``
    const urlByBuilder = new Map<string, string>();
    const builderArrow = /export\s+const\s+(get\w+Url)\s*=\s*\([^)]*\)\s*(?::\s*[^=>]+)?\s*=>\s*`([^`]+)`/g;
    for (const m of src.matchAll(builderArrow)) {
      urlByBuilder.set(m[1], normalizePath(m[2]));
    }
    const builderBlock = /export\s+const\s+(get\w+Url)\s*=[\s\S]*?return\s+`([^`]+)`/g;
    for (const m of src.matchAll(builderBlock)) {
      if (!urlByBuilder.has(m[1])) urlByBuilder.set(m[1], normalizePath(m[2]));
    }

    // 2. Find every raw async function: `export const fooBar = async (...) => { ... customFetch(getFooBarUrl(...), {...method: "POST"}) ... }`
    //    Two-step: find the header (`export const X = async`), then brace-walk
    //    to find the body. Regex-only fails because orval inserts
    //    `: Promise<...>` return-type annotations with `>` chars.
    const headerRe = /export\s+const\s+(\w+)\s*=\s*async\s*\(/g;
    for (const m of src.matchAll(headerRe)) {
      const rawName = m[1];
      // Walk past the parameter list (balanced parens)
      let i = (m.index ?? 0) + m[0].length;
      let depth = 1;
      while (i < src.length && depth > 0) {
        const c = src[i];
        if (c === "(") depth++;
        else if (c === ")") depth--;
        i++;
      }
      // Now skip optional `: Promise<...>` and the `=>` arrow + opening `{`
      const arrowIdx = src.indexOf("=>", i);
      if (arrowIdx < 0) continue;
      const braceIdx = src.indexOf("{", arrowIdx);
      if (braceIdx < 0 || braceIdx - arrowIdx > 200) continue;
      // Brace-walk to find the function body's closing `}`
      let bd = 1;
      let j = braceIdx + 1;
      while (j < src.length && bd > 0) {
        const c = src[j];
        if (c === "{") bd++;
        else if (c === "}") bd--;
        j++;
      }
      const body = src.slice(braceIdx + 1, j - 1);
      const builderMatch = /\b(get\w+Url)\s*\(/.exec(body);
      const methodMatch = /method\s*:\s*["'`](GET|POST|PUT|PATCH|DELETE)["'`]/i.exec(body);
      if (!builderMatch || !methodMatch) continue;
      const path = urlByBuilder.get(builderMatch[1]);
      if (!path) continue;
      const method = methodMatch[1].toUpperCase();
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
 * Walk a screen source file looking for references to orval hook names.
 * For every match emit a StateAction (deduped).
 *
 * Covers:
 *   - `useDeleteFavorite()` standalone
 *   - `const mut = useDeleteFavorite();` + later `mut.mutate(...)`
 *   - `useDeleteFavorite({ onSuccess: ... }).mutateAsync(...)`
 *   - direct `deleteFavorite(id)` raw-function calls
 * We only emit ONCE per (file, hookName), not once per call-site — same
 * action triggered from multiple buttons is still ONE testable action.
 */
export function extractActionsFromOrvalHooks(
  src: string,
  hookMap: Map<string, OrvalEndpoint>
): StateAction[] {
  if (hookMap.size === 0) return [];
  const found = new Map<string, OrvalEndpoint>();  // key: hookName

  // Build a regex of all known hook names + raw names, longest first to
  // prevent prefix shadowing (e.g. useDelete vs useDeleteFavorite).
  const names = [...hookMap.keys()].sort((a, b) => b.length - a.length);
  if (names.length === 0) return [];
  const re = new RegExp("\\b(" + names.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|") + ")\\b", "g");

  for (const m of src.matchAll(re)) {
    const name = m[1];
    const entry = hookMap.get(name);
    if (!entry) continue;
    if (found.has(entry.hookName)) continue;
    found.set(entry.hookName, entry);
  }

  const actions: StateAction[] = [];
  for (const entry of found.values()) {
    const kind = methodToKind(entry.method);
    if (!kind) continue;       // skip GET (reads, not actions)
    actions.push({
      kind,
      target: labelFromHookName(entry.hookName),
      expect: `${entry.method} ${entry.path}`,
    });
  }
  return actions;
}
