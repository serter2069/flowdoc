import type { StateAction, Control } from "../schema.js";

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

const CLICKABLE_RE = /<([A-Z][A-Za-z0-9]*(?:Button|Pressable|Touchable|Link|Fab|IconButton|Chip|Tab)|Button|Pressable|TouchableOpacity|TouchableHighlight|TouchableWithoutFeedback|Link)\b([^>]*?)(\/>|>)/g;
const ON_PRESS_RE = /\bon(?:Press|Click)\s*=\s*\{/g;
const API_CALL_INLINE = /\b(?:api|axios|\$fetch|http|client|service)\s*\.\s*(get|post|put|patch|delete)\s*[<(]?\s*['"`]([^'"`]+)['"`]/g;
const FETCH_CALL_INLINE = /\bfetch\s*\(\s*['"`]([^'"`]+)['"`]\s*,\s*\{[^}]*method\s*:\s*['"`](GET|POST|PUT|PATCH|DELETE)['"`]/gi;
const MUTATION_CALL_RE = /\b(?:[a-zA-Z_$][\w$]*Mutation|[a-zA-Z_$][\w$]*\.mutation|mutation)\s*\.\s*(?:mutate|mutateAsync)\s*\(/g;
// router.push("/foo") / router.replace(...) / navigation.navigate("Screen")
const ROUTER_NAV_RE = /\b(?:router|navigation)\s*\.\s*(?:push|replace|navigate)\s*\(\s*['"`]([^'"`]+)['"`]/g;
// router.push({ pathname: "/listing/[id]", ... })
const ROUTER_NAV_OBJ_RE = /\b(?:router|navigation)\s*\.\s*(?:push|replace|navigate)\s*\(\s*\{[^}]*pathname\s*:\s*['"`]([^'"`]+)['"`]/g;
const TITLE_PROP_RE = /\b(?:title|accessibilityLabel|label|name)\s*=\s*[{"']([^"'}]+)['"}]/;
// Match `accessibilityLabel={t("home.search")}` — captures the i18n key.
// The wrapped form: prop = "{" + t("key") + "}"
const TITLE_I18N_RE = /\b(?:title|accessibilityLabel|label|name)\s*=\s*\{\s*t\s*\(\s*['"`]([^'"`]+)['"`]\s*\)\s*\}/;
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

function inferKindFromLabel(label: string): StateAction["kind"] | null {
  // Infer action kind from a visible button label like "Submit booking" / "Delete" / "Sign in".
  const n = label.toLowerCase();
  if (/\b(delete|remove|destroy|cancel|drop|trash)\b/.test(n)) return "delete";
  if (/\b(add|create|new|invite|book|schedule|register)\b/.test(n)) return "add";
  if (/\b(edit|update|save|change|set|rename|modify)\b/.test(n)) return "edit";
  if (/\b(upload|attach|import|pick a file|choose file)\b/.test(n)) return "upload";
  if (/\b(toggle|switch|enable|disable|activate|deactivate)\b/.test(n)) return "toggle";
  if (/\b(submit|send|confirm|complete|finish|post|sign\s?in|log\s?in|continue|next)\b/.test(n)) return "submit";
  if (/\b(approve|accept|allow|grant)\b/.test(n)) return "approve";
  if (/\b(reject|deny|block|decline)\b/.test(n)) return "reject";
  if (/\b(select|pick|choose)\b/.test(n)) return "select";
  if (/\b(download|export)\b/.test(n)) return "download";
  return null;
}

function labelToTarget(label: string): string {
  return label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32) || "action";
}

function inferKindFromHandlerName(name: string): StateAction["kind"] | null {
  const n = name.toLowerCase();
  // Strip common prefixes that just say "this is a handler"
  const core = n.replace(/^(on|handle|do)/, "");
  if (/^(delete|remove|destroy)/.test(core)) return "delete";
  if (/^(add|create|new|post|insert|book|invite)/.test(core)) return "add";
  if (/^(edit|update|save|change|set|rename)/.test(core)) return "edit";
  if (/^(upload|attach|import)/.test(core)) return "upload";
  if (/^(toggle|switch|enable|disable)/.test(core)) return "toggle";
  if (/^(submit|send|sign|login|continue|next|finish|complete)/.test(core)) return "submit";
  if (/^(approve|accept|confirm|allow)/.test(core)) return "approve";
  if (/^(reject|cancel|deny|decline|block)/.test(core)) return "reject";
  if (/^(select|pick|choose)/.test(core)) return "select";
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

/**
 * Pull the human-readable label off a clickable JSX tag.
 *
 * Priority:
 *   1. `accessibilityLabel={t("key")}` — extract the i18n key.
 *   2. `accessibilityLabel="literal"` / `title="..."` — use literal.
 *   3. text content between `>` and `</Tag>`.
 *
 * Returns `{ label, isDynamic }`. `isDynamic` is true when the label came
 * from a variable reference (e.g. `accessibilityLabel={title}`) so callers
 * can decide whether to trust it for kind-inference.
 */
function extractActionLabel(jsxTag: string, sourceWindow: string): { label: string; isDynamic: boolean } {
  // 1. i18n-wrapped accessibilityLabel — most accurate when present.
  const im = TITLE_I18N_RE.exec(jsxTag);
  if (im) return { label: im[1].slice(0, 64), isDynamic: false };
  // 2. literal title/label/accessibilityLabel prop
  const tmatch = TITLE_PROP_RE.exec(jsxTag);
  if (tmatch) {
    const raw = tmatch[1].slice(0, 64);
    // If capture starts with `t(`, the i18n RE failed (likely template-string
    // form); we fall through to other signals rather than emit garbage.
    if (raw === "t(" || raw.startsWith("t(")) {
      // try children text instead
      const cmatch = CHILDREN_TEXT_RE.exec(sourceWindow);
      if (cmatch) return { label: cmatch[1].trim().slice(0, 64), isDynamic: false };
      return { label: "action", isDynamic: false };
    }
    // If the captured value looks like a bare JS identifier (came from
    // `{varName}`), the LITERAL label is unknown at scan time. We still
    // return the identifier so kind-inference can take a guess on names
    // like `title`/`label`/`name`, but flag it so the caller can downgrade.
    const isIdent = /^[a-zA-Z_$][\w$]*$/.test(raw) && !/\s/.test(raw);
    return { label: raw, isDynamic: isIdent };
  }
  // 3. text content between > and </Tag>
  const cmatch = CHILDREN_TEXT_RE.exec(sourceWindow);
  if (cmatch) return { label: cmatch[1].trim().slice(0, 64), isDynamic: false };
  return { label: "action", isDynamic: false };
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

    // Find api.METHOD('/path') / axios.METHOD / fetch('/path', {method:...}) inside the handler body
    const apis: Array<{ method: string; path: string }> = [];
    API_CALL_INLINE.lastIndex = 0;
    let am: RegExpExecArray | null;
    while ((am = API_CALL_INLINE.exec(handlerExpr))) {
      apis.push({ method: am[1], path: am[2] });
    }
    FETCH_CALL_INLINE.lastIndex = 0;
    while ((am = FETCH_CALL_INLINE.exec(handlerExpr))) {
      apis.push({ method: am[2].toLowerCase(), path: am[1] });
    }

    // Detect react-query mutation calls — we don't know the URL but we know
    // the handler is firing a mutation, so emit a generic action.
    const hasMutationCall = MUTATION_CALL_RE.test(handlerExpr);
    MUTATION_CALL_RE.lastIndex = 0;

    // Detect router/navigation pushes — handlers that move the user to
    // another screen but don't mutate server state. Universal across
    // Expo Router, React Navigation, etc.
    const navTargets: string[] = [];
    ROUTER_NAV_RE.lastIndex = 0;
    while ((am = ROUTER_NAV_RE.exec(handlerExpr))) navTargets.push(am[1]);
    ROUTER_NAV_OBJ_RE.lastIndex = 0;
    while ((am = ROUTER_NAV_OBJ_RE.exec(handlerExpr))) navTargets.push(am[1]);

    const { label, isDynamic } = extractActionLabel(fullTag, src.slice(startIdx, startIdx + 200));
    // For dynamic labels (`{title}`/`{name}`), don't trust verb-from-label
    // inference — it would emit kind="add" for any button labeled "name".
    const fallbackKind = inferredKindFromName ?? (isDynamic ? null : inferKindFromLabel(label));

    if (apis.length === 0) {
      // No direct api call. Try in order: mutate-hook, label/handler verb,
      // navigation. Bail if none of those signals exist.
      if (hasMutationCall || fallbackKind) {
        const kind: StateAction["kind"] = fallbackKind ?? "submit";
        const target = labelToTarget(label);
        const key = `${kind}:${target}`;
        if (!seen.has(key)) {
          seen.add(key);
          const comment = hasMutationCall
            ? `mutation: ${label}`
            : isDynamic ? `button: ${label} (dynamic)` : `button: ${label}`;
          actions.push({ kind, target, comment });
        }
        continue;
      }
      if (navTargets.length > 0) {
        // Emit ONE nav action per unique target — list-card with the same
        // shape used many times shouldn't produce 50 chips.
        for (const path of dedupe(navTargets)) {
          const navTarget = isDynamic || !label || label === "action"
            ? routeToTarget(path)
            : labelToTarget(label);
          const key = `nav:${navTarget}:${path}`;
          if (seen.has(key)) continue;
          seen.add(key);
          actions.push({
            kind: "nav",
            target: navTarget,
            expect: `→ ${path}`,
            comment: isDynamic ? `nav: ${label} (dynamic)` : `nav: ${label}`,
          });
        }
        continue;
      }
      // No signal at all — skip silently.
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

function dedupe(arr: string[]): string[] {
  return Array.from(new Set(arr));
}

/** Convert a route path like "/listing/[id]" or "/admin/users" into a stable target slug. */
function routeToTarget(path: string): string {
  return path
    .replace(/[\[\]\(\)]/g, "")           // strip param brackets and group parens
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase()
    .slice(0, 32) || "nav";
}

// ─── Form-field / control extraction ───────────────────────────────────────
// Catches <TextInput>, <Picker>/<Select>, <Switch>, <Checkbox>, file inputs.
// Used to populate state.controls[] so `flowdoc validate` can check whether a
// scenario step mentions a field/picker that actually exists.

const INPUT_RE = /<(TextInput|Input|TextField|Textarea|Picker|Select|Switch|Checkbox)\b([^>]*?)(\/>|>)/g;
const FIELD_NAME_PROP_RE = /\b(?:name|id|testID|accessibilityLabel|placeholder|label)\s*=\s*[{"']([^"'}]+)['"}]/;

function controlKindFromTag(tag: string): Control["kind"] {
  switch (tag.toLowerCase()) {
    case "textinput":
    case "input":
    case "textfield":   return "input";
    case "textarea":    return "textarea";
    case "picker":
    case "select":      return "select";
    case "switch":      return "toggle";
    case "checkbox":    return "toggle";
    default:            return "input";
  }
}

export function extractControlsFromJsx(src: string): Control[] {
  const out: Control[] = [];
  const seen = new Set<string>();
  for (const m of src.matchAll(INPUT_RE)) {
    const tag = m[1];
    const attrs = m[2];
    const kind = controlKindFromTag(tag);
    const nameMatch = FIELD_NAME_PROP_RE.exec(attrs);
    const label = nameMatch ? nameMatch[1].slice(0, 40) : tag.toLowerCase();
    const key = `${kind}:${label}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ kind, label });
  }
  return out;
}
