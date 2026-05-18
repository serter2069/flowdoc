import type { Control, StateParam } from "../schema.js";

/**
 * Full-coverage interactive-element scanner.
 *
 * Walks a JSX/TSX file and surfaces every control a user can touch — inputs,
 * selects (with their full option domain), file pickers (single + multi, with
 * accept-types), scroll containers, toggles, sliders, OTP fields, image
 * pickers, links.  These become State.controls[] on the canvas; downstream the
 * enumerator fans scenarios over each control's domain so a 3-option select
 * yields 3 scenario variants, a single-file picker yields N (one per fixture),
 * etc.
 *
 * Separate from extractActionsFromJsx() which only catches Pressable→API
 * mutations. This pass is wider — it captures the surface area of every page,
 * not just the destructive endpoints.
 *
 * Also extracts route/query params from `useLocalSearchParams<{...}>()` so
 * the canvas knows what dynamic inputs each page actually consumes.
 */

const TEXT_INPUT_RE   = /<TextInput\b([^>]*?)(\/>|>)/g;
// Match opening tag name only — JSX attribute values often contain `>` inside
// `{() => ...}` arrows or TS generics, so trying to capture the whole attrs
// blob via regex breaks on the first inner `>`. Cheap fix: just detect the
// tag-name presence at an opening `<`. Excludes lowercase HTML tags by
// requiring an uppercase first letter at the start of the tag-name.
const PICKER_OPEN_RE = /<([A-Z]\w*(?:Picker|Select|Dropdown|Combobox|Listbox))\b/g;
// Native <Picker><Picker.Item label="…" value="…"/>…</Picker> — domain extraction
// only works for paired Native-style Pickers. Custom components (CityFnsServicePicker
// etc.) don't expose their domain via JSX children, so we just record their presence.
const NATIVE_PICKER_RE = /<Picker\b([^>]*?)>([\s\S]*?)<\/Picker>/g;
const PICKER_ITEM_RE  = /<(Picker\.Item|Picker.Item|Item)\b[^>]*?\b(?:label|value)\s*=\s*["'`]([^"'`]+)["'`]/g;
const SWITCH_RE       = /<Switch\b([^>]*?)(\/>|>)/g;
const SLIDER_RE       = /<Slider\b([^>]*?)(\/>|>)/g;
const SCROLL_RE       = /<(ScrollView|FlatList|SectionList|VirtualizedList)\b([^>]*?)(\/>|>)/g;
const SUBMIT_BTN_RE   = /\b(handleSubmit|onSubmit|formik\.submitForm|form\.handleSubmit)\b/g;
// Custom OTP component (project-specific names like OtpCodeInput, OTPInput, VerificationCodeInput, …)
const OTP_COMPONENT_RE = /<(\w*Otp\w*|\w*OTP\w*|\w*VerificationCode\w*|\w*PinCode\w*)\b([^>]*?)(\/>|>)/g;

const DOC_PICKER_IMPORT_RE = /\bfrom\s+["']expo-document-picker["']/g;
const DOC_PICKER_CALL_RE = /\bDocumentPicker\s*\.\s*getDocumentAsync\s*\(\s*(\{[\s\S]*?\})?/g;
const IMG_PICKER_IMPORT_RE = /\bfrom\s+["']expo-image-picker["']/g;
const IMG_PICKER_CALL_RE = /\bImagePicker\s*\.\s*(?:launchImageLibraryAsync|launchCameraAsync)\s*\(\s*(\{[\s\S]*?\})?/g;
const FILE_SYSTEM_DL_RE = /\bFileSystem\s*\.\s*downloadAsync\s*\(/g;
const LINKING_OPEN_RE = /\bLinking\s*\.\s*openURL\s*\(\s*[`'"]([^`'"]+)[`'"]/g;

const OTP_HINT_RE = /\b(otp|verification[_-]?code|verify[_-]?code|6[_-]?digit)\b/i;
const NUMBER_PAD_RE = /\bkeyboardType\s*=\s*["'`]number-pad["'`]/;
const MAXLENGTH_1_RE = /\bmaxLength\s*=\s*\{?\s*1\s*\}?/;

const PLACEHOLDER_RE = /\bplaceholder\s*=\s*["'`]([^"'`]+)["'`]/;
const ARIA_LABEL_RE = /\b(?:accessibilityLabel|aria-label|label|title|name)\s*=\s*["'`]([^"'`]+)["'`]/;
const REQUIRED_RE = /\b(?:required|isRequired)\s*=\s*(?:\{true\}|true)/;
const SECURE_RE = /\bsecureTextEntry\b/;
const MULTILINE_RE = /\bmultiline\b/;

// useLocalSearchParams<{ id: string; status?: 'draft' | 'published' }>()
const LOCAL_PARAMS_RE = /\buseLocalSearchParams\s*<\s*\{([^}]+)\}\s*>\s*\(\s*\)/g;
// useGlobalSearchParams<{ ... }>()
const GLOBAL_PARAMS_RE = /\buseGlobalSearchParams\s*<\s*\{([^}]+)\}\s*>\s*\(\s*\)/g;

function extractLabel(attrs: string, src: string, tagStart: number): string {
  const a = ARIA_LABEL_RE.exec(attrs);
  if (a) return a[1].slice(0, 40);
  const p = PLACEHOLDER_RE.exec(attrs);
  if (p) return p[1].slice(0, 40);
  // Try preceding <Text>label</Text>
  const before = src.slice(Math.max(0, tagStart - 200), tagStart);
  const t = /<Text[^>]*>\s*([A-ZА-Я][\w\s'.,()\-]{1,40})\s*<\/Text>\s*$/.exec(before);
  if (t) return t[1].trim().slice(0, 40);
  return "";
}

/** Parse the inner TS-type-literal of useLocalSearchParams<{...}>() into params. */
function parseSearchParamType(literal: string): StateParam[] {
  // Examples we handle:
  //   id: string
  //   status?: 'draft' | 'published' | 'rejected'
  //   tab: "info" | "history"
  //   page?: number
  const out: StateParam[] = [];
  const FIELD_RE = /(\w+)\s*(\??)\s*:\s*([^;,\n]+)/g;
  let m: RegExpExecArray | null;
  while ((m = FIELD_RE.exec(literal))) {
    const name = m[1];
    const optional = m[2] === "?";
    const rhs = m[3].trim();
    const union = rhs.match(/['"`]([^'"`]+)['"`]/g);
    if (union && union.length > 1) {
      out.push({
        name,
        source: "route",
        type: "enum",
        values: union.map((v) => v.replace(/['"`]/g, "")),
        required: !optional,
      });
    } else {
      const baseType = rhs.split(/[|&\s]/)[0].toLowerCase();
      out.push({
        name,
        source: "route",
        type: baseType,
        required: !optional,
      });
    }
  }
  return out;
}

export function extractParamsFromPage(src: string): StateParam[] {
  const out: StateParam[] = [];
  for (const re of [LOCAL_PARAMS_RE, GLOBAL_PARAMS_RE]) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(src))) {
      out.push(...parseSearchParamType(m[1]));
    }
  }
  // Dedupe by name (last wins)
  const byName = new Map<string, StateParam>();
  for (const p of out) byName.set(p.name, p);
  return [...byName.values()];
}

export function extractControlsFromJsx(src: string): Control[] {
  const controls: Control[] = [];
  const seen = new Set<string>();
  const push = (c: Control) => {
    const key = `${c.kind}:${c.label}:${(c.domain || []).join(",")}`;
    if (seen.has(key)) return;
    seen.add(key);
    controls.push(c);
  };

  // ── TextInput / multiline / secure / OTP ──
  for (const m of src.matchAll(TEXT_INPUT_RE)) {
    const attrs = m[1];
    const label = extractLabel(attrs, src, m.index ?? 0);
    const isOtp = (label && OTP_HINT_RE.test(label)) ||
                  (NUMBER_PAD_RE.test(attrs) && MAXLENGTH_1_RE.test(attrs)) ||
                  OTP_HINT_RE.test(attrs);
    const isPassword = SECURE_RE.test(attrs);
    const isMulti = MULTILINE_RE.test(attrs);
    push({
      kind: isOtp ? "otp" : (isMulti ? "textarea" : "input"),
      label: label || (isPassword ? "password" : (isOtp ? "code" : "input")),
      required: REQUIRED_RE.test(attrs) || undefined,
    });
  }

  // ── Native <Picker> with <Picker.Item> children → finite domain ──
  for (const m of src.matchAll(NATIVE_PICKER_RE)) {
    const attrs = m[1];
    const inner = m[2];
    const label = extractLabel(attrs, src, m.index ?? 0);
    const domain: string[] = [];
    for (const im of inner.matchAll(PICKER_ITEM_RE)) {
      if (im[2] && !domain.includes(im[2])) domain.push(im[2]);
    }
    push({ kind: "select", label: label || "select", domain: domain.length ? domain : undefined });
  }
  // ── Any other select-like tag (custom components: <SelectFns>, <CityFnsServicePicker>, etc.) ──
  //    Domain unknown without runtime info; tag name is the label.
  for (const m of src.matchAll(PICKER_OPEN_RE)) {
    if (m[1] === "Picker") continue;            // already handled with domain
    push({ kind: "select", label: m[1] });
  }
  // ── Custom OTP component (OtpCodeInput / VerificationCodeInput etc.) ──
  for (const m of src.matchAll(OTP_COMPONENT_RE)) {
    push({ kind: "otp", label: extractLabel(m[2], src, m.index ?? 0) || "code" });
  }

  // ── Switch / Toggle ──
  for (const m of src.matchAll(SWITCH_RE)) {
    push({ kind: "toggle", label: extractLabel(m[1], src, m.index ?? 0) || "toggle" });
  }

  // ── Slider ──
  for (const m of src.matchAll(SLIDER_RE)) {
    push({ kind: "slider", label: extractLabel(m[1], src, m.index ?? 0) || "slider" });
  }

  // ── Scroll containers ──
  for (const m of src.matchAll(SCROLL_RE)) {
    const label = extractLabel(m[2], src, m.index ?? 0);
    push({ kind: "scroll", label: label || m[1] });
  }

  // ── expo-document-picker → file / files ──
  if (DOC_PICKER_IMPORT_RE.test(src) || src.includes("expo-document-picker")) {
    DOC_PICKER_CALL_RE.lastIndex = 0;
    let dm: RegExpExecArray | null;
    let foundAny = false;
    while ((dm = DOC_PICKER_CALL_RE.exec(src))) {
      foundAny = true;
      const opts = dm[1] || "";
      const multiple = /\bmultiple\s*:\s*true\b/.test(opts);
      const typeMatch = opts.match(/\btype\s*:\s*['"`]([^'"`]+)['"`]/);
      push({
        kind: multiple ? "files" : "file",
        label: "document",
        accept: typeMatch ? typeMatch[1] : undefined,
        multiple: multiple || undefined,
      });
    }
    if (!foundAny) push({ kind: "file", label: "document" });
  }

  // ── expo-image-picker → image ──
  if (IMG_PICKER_IMPORT_RE.test(src) || src.includes("expo-image-picker")) {
    IMG_PICKER_CALL_RE.lastIndex = 0;
    let im: RegExpExecArray | null;
    let foundAny = false;
    while ((im = IMG_PICKER_CALL_RE.exec(src))) {
      foundAny = true;
      const opts = im[1] || "";
      const multi = /\ballowsMultipleSelection\s*:\s*true\b/.test(opts);
      push({ kind: "image", label: multi ? "images" : "image", multiple: multi || undefined });
    }
    if (!foundAny) push({ kind: "image", label: "image" });
  }

  // ── FileSystem.downloadAsync ──
  if (FILE_SYSTEM_DL_RE.test(src)) {
    push({ kind: "link", label: "download" });
  }

  // ── Linking.openURL with file-like URL ──
  for (const m of src.matchAll(LINKING_OPEN_RE)) {
    const url = m[1];
    if (/\.(pdf|csv|xls|xlsx|doc|docx|zip|tar|gz|mp4|mov|jpg|png|webp)(\?|$)/i.test(url) ||
        /\bdownload\b/i.test(url)) {
      push({ kind: "link", label: "download " + (url.split("/").pop() || "file") });
    }
  }

  // ── Submit-form hint ──
  if (SUBMIT_BTN_RE.test(src)) {
    push({ kind: "submit", label: "submit form" });
  }

  return controls;
}

/* ─── Backend-side scanners — Zod & multer detection ─── */

/**
 * Scan an Express route file for Zod schemas attached to req.body/query/params
 * and extract any z.enum([...]) or z.literal unions as finite domains. Each
 * resolved field becomes a StateParam with values[].
 *
 * Best-effort: doesn't follow imports across files, so the schema must be
 * defined in (or imported by name into) the same file as the route handler.
 */
const Z_OBJECT_RE = /\bz\s*\.\s*object\s*\(\s*\{([\s\S]*?)\}\s*\)/g;
const Z_FIELD_RE = /(\w+)\s*:\s*z\s*\.\s*([\w.()'",\s\[\]|]+)/g;
const Z_ENUM_RE = /\bz\s*\.\s*enum\s*\(\s*\[\s*([\s\S]*?)\s*\]\s*\)/;
const Z_LITERAL_RE = /\bz\s*\.\s*literal\s*\(\s*['"`]([^'"`]+)['"`]/g;
const Z_STRING_TYPE_RE = /\bz\s*\.\s*(string|number|boolean|uuid|email|url|date)\b/;
const Z_OPTIONAL_RE = /\.\s*optional\s*\(/;

export function extractParamsFromZodFile(src: string): StateParam[] {
  const out: StateParam[] = [];
  for (const m of src.matchAll(Z_OBJECT_RE)) {
    const body = m[1];
    Z_FIELD_RE.lastIndex = 0;
    let f: RegExpExecArray | null;
    while ((f = Z_FIELD_RE.exec(body))) {
      const name = f[1];
      const rhs = f[2];
      const enumMatch = Z_ENUM_RE.exec(rhs);
      if (enumMatch) {
        const values = [...enumMatch[1].matchAll(/['"`]([^'"`]+)['"`]/g)].map((m) => m[1]);
        if (values.length) {
          out.push({ name, source: "body", type: "enum", values, required: !Z_OPTIONAL_RE.test(rhs) });
          continue;
        }
      }
      // z.union([z.literal('a'), z.literal('b')])
      const literals = [...rhs.matchAll(Z_LITERAL_RE)].map((m) => m[1]);
      if (literals.length > 1) {
        out.push({ name, source: "body", type: "enum", values: literals, required: !Z_OPTIONAL_RE.test(rhs) });
        continue;
      }
      const ty = Z_STRING_TYPE_RE.exec(rhs);
      if (ty) {
        out.push({ name, source: "body", type: ty[1], required: !Z_OPTIONAL_RE.test(rhs) });
      }
    }
  }
  // dedupe by name (later wins)
  const byName = new Map<string, StateParam>();
  for (const p of out) byName.set(p.name, p);
  return [...byName.values()];
}

/**
 * Detect file-upload (multer/multipart) and file-serving (res.sendFile / res.download)
 * on an Express route file. Returns the file-kind controls that should be
 * attached to API-state cards in the canvas.
 */
const MULTER_SINGLE_RE = /\.\s*single\s*\(\s*['"`]([^'"`]+)['"`]\s*\)/g;
const MULTER_ARRAY_RE = /\.\s*array\s*\(\s*['"`]([^'"`]+)['"`]/g;
const MULTER_FIELDS_RE = /\.\s*fields\s*\(\s*\[/g;
const MULTER_ANY_RE = /\.\s*any\s*\(\s*\)/g;
const RES_SENDFILE_RE = /\bres\s*\.\s*(?:sendFile|download)\s*\(/g;

export function extractControlsFromExpressRouteFile(src: string): Control[] {
  const out: Control[] = [];
  for (const m of src.matchAll(MULTER_SINGLE_RE)) {
    out.push({ kind: "file", label: m[1] });
  }
  for (const m of src.matchAll(MULTER_ARRAY_RE)) {
    out.push({ kind: "files", label: m[1], multiple: true });
  }
  if (MULTER_FIELDS_RE.test(src) || MULTER_ANY_RE.test(src)) {
    out.push({ kind: "files", label: "multipart", multiple: true });
  }
  if (RES_SENDFILE_RE.test(src)) {
    out.push({ kind: "link", label: "download" });
  }
  return out;
}
