import type { StateAction } from "../schema.js";

/**
 * Walk a JSX/TSX source file looking for clickable elements (Button,
 * Pressable, TouchableOpacity, Link, etc.) whose handler calls an HTTP API.
 *
 * Returns a list of StateAction entries — these become the "actions" on the
 * screen state in flows.json, visible as small chips on the card and in the
 * double-click details modal.
 *
 * Coverage:
 *   - inline arrow: onPress={() => api.delete('/posts/123/comments/4')}
 *   - inline async: onPress={async () => { await api.put(...) }}
 *   - named handler: onPress={handleDelete}  ⟶  follow `const handleDelete = ...`
 *   - domain helpers: Bookings.update(id, payload)   (kind inferred from name)
 *
 * We give up on react-query mutation hooks (useMutation(...).mutateAsync(...))
 * — those need flow-typing and an OpenAPI mapping to resolve back to a URL.
 */

const CLICKABLE_RE = /<(Button|Pressable|TouchableOpacity|TouchableHighlight|TouchableWithoutFeedback|Link)\b([^>]*?)(\/>|>)/g;
const ON_PRESS_RE = /\bon(?:Press|Click)\s*=\s*\{/g;
const API_CALL_INLINE = /\bapi\s*\.\s*(get|post|put|patch|delete)\s*[<(]?\s*['"`]([^'"`]+)['"`]/g;
const TITLE_PROP_RE = /\b(?:title|accessibilityLabel|label|name)\s*=\s*[{"']([^"'}]+)['"}]/;
const CHILDREN_TEXT_RE = />\s*([A-Z][\w\s'.-]{1,40})\s*</;

function methodToKind(method: string): StateAction["kind"] | null {
  switch (method.toUpperCase()) {
    case "DELETE": return "delete";
    case "POST":   return "add";
    case "PUT":
    case "PATCH":  return "edit";
    case "GET":    return null;        // reads aren't user actions worth listing
    default:       return "submit";
  }
}

function inferKindFromHandlerName(name: string): StateAction["kind"] | null {
  const n = name.toLowerCase();
  if (/^(handle)?delete|remove|destroy/.test(n)) return "delete";
  if (/^(handle)?(add|create|new|post|insert)/.test(n)) return "add";
  if (/^(handle)?(edit|update|save|change|set)/.test(n)) return "edit";
  if (/^(handle)?upload/.test(n)) return "upload";
  if (/^(handle)?toggle/.test(n)) return "toggle";
  if (/^(handle)?submit|send/.test(n)) return "submit";
  if (/^(handle)?approve|accept|confirm/.test(n)) return "approve";
  if (/^(handle)?reject|cancel|deny/.test(n)) return "reject";
  return null;
}

function findMatchingBrace(src: string, openPos: number): number {
  // openPos points at "{". Returns index AFTER matching "}".
  let depth = 0;
  let inStr: string | null = null;
  for (let i = openPos; i < src.length; i++) {
    const c = src[i];
    if (inStr) {
      if (c === "\\") { i++; continue; }
      if (c === inStr) inStr = null;
      continue;
    }
    if (c === "'" || c === '"' || c === "`") { inStr = c; continue; }
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return -1;
}

function extractActionLabel(jsxTag: string, sourceWindow: string): string {
  // 1. accessibility / title prop
  const tmatch = TITLE_PROP_RE.exec(jsxTag);
  if (tmatch) return tmatch[1].slice(0, 32);
  // 2. text content between > and </Tag>
  const cmatch = CHILDREN_TEXT_RE.exec(sourceWindow);
  if (cmatch) return cmatch[1].trim().slice(0, 32);
  return "action";
}

function findHandlerBody(src: string, identifierName: string): string | null {
  // Look for `const NAME = (...) => { ... }` or `function NAME(...) { ... }`
  const re = new RegExp(
    `(?:const|let|var)\\s+${identifierName}\\s*=\\s*(?:async\\s*)?\\([^)]*\\)\\s*=>\\s*\\{|function\\s+${identifierName}\\s*\\([^)]*\\)\\s*\\{`,
    "m"
  );
  const m = re.exec(src);
  if (!m) return null;
  const openBrace = src.indexOf("{", m.index + m[0].length - 1);
  if (openBrace < 0) return null;
  const close = findMatchingBrace(src, openBrace);
  if (close < 0) return null;
  return src.slice(openBrace, close);
}

export function extractActionsFromJsx(src: string): StateAction[] {
  const actions: StateAction[] = [];
  const seen = new Set<string>();   // dedupe key

  for (const tagMatch of src.matchAll(CLICKABLE_RE)) {
    const fullTag = tagMatch[0];
    const tagAttrs = tagMatch[2];
    const startIdx = tagMatch.index ?? 0;

    // Find onPress= in the tag attrs
    ON_PRESS_RE.lastIndex = 0;
    const onMatch = ON_PRESS_RE.exec(tagAttrs);
    if (!onMatch) continue;
    const onPosInAttrs = onMatch.index;
    // Absolute position of the `{` that opens the handler expression
    const handlerOpen = startIdx + "<".length + (tagMatch[1].length) + onPosInAttrs + onMatch[0].length - 1;
    const handlerClose = findMatchingBrace(src, handlerOpen);
    if (handlerClose < 0) continue;
    let handlerExpr = src.slice(handlerOpen + 1, handlerClose - 1).trim();

    // If handler is just a bare identifier, follow its declaration
    const bareIdent = /^[a-zA-Z_$][\w$]*$/.exec(handlerExpr);
    let inferredKindFromName: StateAction["kind"] | null = null;
    if (bareIdent) {
      inferredKindFromName = inferKindFromHandlerName(bareIdent[0]);
      const body = findHandlerBody(src, bareIdent[0]);
      if (body) handlerExpr = body;
    }

    // Find api.METHOD('/path') inside the handler body
    const apis: Array<{ method: string; path: string }> = [];
    API_CALL_INLINE.lastIndex = 0;
    let am: RegExpExecArray | null;
    while ((am = API_CALL_INLINE.exec(handlerExpr))) {
      apis.push({ method: am[1], path: am[2] });
    }

    const label = extractActionLabel(fullTag, src.slice(startIdx, startIdx + 200));

    if (apis.length === 0) {
      // No api call, but the handler-name hints at an action (e.g. onPress={handleDelete})
      if (inferredKindFromName) {
        const key = `${inferredKindFromName}:${label}`;
        if (!seen.has(key)) {
          seen.add(key);
          actions.push({ kind: inferredKindFromName, target: label });
        }
      }
      continue;
    }
    for (const a of apis) {
      const kind = methodToKind(a.method) ?? inferredKindFromName;
      if (!kind) continue;   // GET-only press = not a tracked mutation
      const target = label || a.path;
      const key = `${kind}:${target}:${a.method}:${a.path}`;
      if (seen.has(key)) continue;
      seen.add(key);
      actions.push({
        kind,
        target,
        expect: `${a.method.toUpperCase()} ${a.path}`,
      });
    }
  }
  return actions;
}
