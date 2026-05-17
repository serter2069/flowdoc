import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import type { FlowDoc, State, Transition, StateKind, StateAction } from "../schema.js";

interface ScanLaravelOpts {
  out: string;
  merge: boolean;
}

const PUBLIC_HINT = /(home|landing|login|register|forgot|reset|booking|thank|cancel|success|public|out-of-service|signup|signin|property-lookup|zip)/i;
const AUTH_HINT = /(login|signin|signup|register|forgot|reset|auth)/i;
// Customer-facing routes: this is the FIRST page a real client lands on to
// create a new booking. Tagged "client" so the scenario tree shows their flow
// distinctly from anon-auth flows (login/reset).
const CLIENT_HINT = /(\/booking|\/property-lookup|\/public\/zip|\/public\/property|\/thanks|\/thank-you|\/confirm-booking|\/payment\/(success|cancel)|out-of-service|public-booking|public-consultation|available-time-slots)/i;
const ERROR_HINT = /(out-of-service|cancel|404|error)/i;
const SUCCESS_HINT = /(thank|success|complete)/i;

function walkPhp(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const f of readdirSync(dir)) {
    const fp = join(dir, f);
    const s = statSync(fp);
    if (s.isDirectory()) walkPhp(fp, out);
    else if (f.endsWith(".php")) out.push(fp);
  }
  return out;
}

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

function titleize(s: string): string {
  return s.replace(/[-_]/g, " ").replace(/([a-z])([A-Z])/g, "$1 $2").replace(/\b\w/g, c => c.toUpperCase()).trim();
}

function pathKind(path: string): StateKind {
  if (ERROR_HINT.test(path)) return "error";
  if (SUCCESS_HINT.test(path)) return "success";
  if (AUTH_HINT.test(path)) return "page";
  return "page";
}

interface RouteEntry { method: string; path: string; controller?: string; name?: string; }

function parseRoutesFile(src: string): RouteEntry[] {
  const results: RouteEntry[] = [];
  // Match: Route::get('/path', [Controller::class, 'method'])
  //        Route::get('/path', 'Controller@method')
  //        Route::post('/path', fn() => ...)
  //        Route::resource('users', UserController::class)
  const re = /Route::(get|post|put|patch|delete|any|resource)\s*\(\s*['"]([^'"]+)['"]\s*,\s*([^)]+)\)(\s*->name\(\s*['"]([^'"]+)['"]\s*\))?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    const method = m[1];
    const path = m[2].startsWith("/") ? m[2] : "/" + m[2];
    const action = m[3].trim();
    const name = m[5];
    if (method === "resource") {
      // Expand to typical 7 routes — but for now just emit the index
      results.push({ method: "get", path, controller: action, name });
    } else {
      results.push({ method, path, controller: action, name });
    }
  }
  return results;
}

// @ts-expect-error reserved for future controller-action graph
function parseControllerFromCallable(s: string): string | undefined {
  // Common forms: [BookingController::class, 'index'] · 'BookingController@index' · BookingController::class
  const m1 = s.match(/\[?\s*([A-Z][A-Za-z0-9_]*)\s*::class\s*,\s*['"]([a-zA-Z0-9_]+)['"]/);
  if (m1) return `${m1[1]}@${m1[2]}`;
  const m2 = s.match(/['"]([A-Z][A-Za-z0-9_]*)@([a-zA-Z0-9_]+)['"]/);
  if (m2) return `${m2[1]}@${m2[2]}`;
  return undefined;
}

function readNotifications(appDir: string): Array<{ id: string; title: string; kind: StateKind }> {
  const out: Array<{ id: string; title: string; kind: StateKind }> = [];
  const ndir = join(appDir, "Notifications");
  if (!existsSync(ndir)) return out;
  for (const f of walkPhp(ndir)) {
    const name = basename(f, ".php");
    const src = readFileSync(f, "utf8");
    // Heuristic: push channel if "via" returns array containing 'broadcast'/'database', email if 'mail'/'MailMessage'
    const hasMail = /MailMessage|->mail|'mail'/i.test(src);
    const hasPush = /WebPushMessage|FcmChannel|'fcm'|'apns'|'broadcast'|'database'/i.test(src);
    let kind: StateKind = "email";
    if (hasPush && !hasMail) kind = "push";
    if (hasMail && hasPush) kind = "email";       // multi-channel — pick the more user-visible
    out.push({ id: "nf-" + slugify(name), title: name, kind });
  }
  return out;
}

function readJobs(appDir: string): Array<{ id: string; title: string }> {
  const out: Array<{ id: string; title: string }> = [];
  const jdir = join(appDir, "Jobs");
  if (!existsSync(jdir)) return out;
  for (const f of walkPhp(jdir)) {
    const name = basename(f, ".php");
    out.push({ id: "job-" + slugify(name), title: name });
  }
  return out;
}

function readWebhookControllers(appDir: string): Array<{ id: string; title: string; path: string }> {
  const out: Array<{ id: string; title: string; path: string }> = [];
  const cdir = join(appDir, "Http", "Controllers");
  if (!existsSync(cdir)) return out;
  for (const f of walkPhp(cdir)) {
    const name = basename(f, ".php");
    if (/Webhook/i.test(name)) {
      out.push({ id: "wh-" + slugify(name), title: name, path: "/webhook/" + slugify(name.replace(/Controller$/i, "").replace(/Webhook/i, "")) });
    }
  }
  return out;
}

function readModelFields(appDir: string): Map<string, string[]> {
  // Returns model-name → field-names (parsed from fillable/casts arrays)
  const out = new Map<string, string[]>();
  const mdir = join(appDir, "Models");
  if (!existsSync(mdir)) return out;
  for (const f of walkPhp(mdir)) {
    const name = basename(f, ".php");
    const src = readFileSync(f, "utf8");
    const fillableM = src.match(/protected\s+\$fillable\s*=\s*\[([^\]]+)\]/);
    if (!fillableM) continue;
    const fields = [...fillableM[1].matchAll(/['"]([a-z_][a-z0-9_]*)['"]/gi)].map(m => m[1]).filter(f => !["id","created_at","updated_at"].includes(f));
    if (fields.length) out.set(name, fields);
  }
  return out;
}

export function scanLaravelCommand(rootArg: string | undefined, opts: ScanLaravelOpts) {
  const root = resolve(process.cwd(), rootArg ?? ".");
  if (!existsSync(root)) {
    console.error(`Path not found: ${root}`); process.exit(1);
  }
  const composer = join(root, "composer.json");
  const isLaravel = existsSync(composer) && /laravel\/framework/.test(readFileSync(composer, "utf8"));
  if (!isLaravel) {
    console.error(`Not a Laravel project (no composer.json with laravel/framework): ${root}`);
    process.exit(1);
  }

  const states: State[] = [];
  const transitions: Transition[] = [];
  let nextNum = 1;
  const idToNum = new Map<string, number>();
  function addState(s: Omit<State, "num">): number {
    if (idToNum.has(s.id)) return idToNum.get(s.id)!;
    const num = nextNum++;
    states.push({ num, ...s } as State);
    idToNum.set(s.id, num);
    return num;
  }

  // 1. Anonymous root
  const anonNum = addState({ id: "anon", kind: "page", title: "Anonymous root", path: "/", roles: ["anon"], col: 0, row: 0 });

  // 2. Routes (web + api)
  let allRoutes: RouteEntry[] = [];
  const webRoutes = join(root, "routes", "web.php");
  const apiRoutes = join(root, "routes", "api.php");
  if (existsSync(webRoutes)) allRoutes = allRoutes.concat(parseRoutesFile(readFileSync(webRoutes, "utf8")));
  if (existsSync(apiRoutes)) allRoutes = allRoutes.concat(parseRoutesFile(readFileSync(apiRoutes, "utf8")));

  // Group GET routes (pages) and POST/PUT/DELETE (mutate actions on parent page)
  const pageRoutes = allRoutes.filter(r => r.method === "get");
  const mutateRoutes = allRoutes.filter(r => r.method !== "get");

  let col = 1, row = 0;
  for (const r of pageRoutes) {
    if (r.path.includes("{") || r.path === "/csrf-token") continue;       // skip param + utility
    if (r.path === "/") continue;                                          // already added as anon
    const id = "p-" + (slugify(r.path) || "root");
    if (idToNum.has(id)) continue;
    const kind = pathKind(r.path);
    addState({
      id, kind,
      title: r.path,
      path: r.path,
      roles: CLIENT_HINT.test(r.path)
        ? ["client"]
        : AUTH_HINT.test(r.path) || PUBLIC_HINT.test(r.path)
          ? ["anon"]
          : ["any"],
      col, row: row++,
    });
    if (row >= 12) { row = 0; col++; }
  }

  // 3. Notifications → email/push nodes
  col = Math.max(col + 1, 5); row = 0;
  const notifications = readNotifications(join(root, "app"));
  for (const n of notifications) {
    addState({ id: n.id, kind: n.kind, title: n.title, roles: ["any"], col, row: row++ });
    if (row >= 10) { row = 0; col++; }
  }

  // 4. Jobs → effect nodes
  col++; row = 0;
  for (const j of readJobs(join(root, "app"))) {
    addState({ id: j.id, kind: "effect", title: j.title, roles: ["any"], col, row: row++ });
  }

  // 5. Webhook controllers → webhook nodes
  col++; row = 0;
  for (const w of readWebhookControllers(join(root, "app"))) {
    addState({ id: w.id, kind: "webhook", title: w.title, path: w.path, roles: ["any"], col, row: row++ });
  }

  // 6. Model actions: each fillable field on a Model → an `edit` action on the most-likely-corresponding page
  const modelFields = readModelFields(join(root, "app"));
  for (const [model, fields] of modelFields) {
    // Try to find a page state whose path mentions the model (e.g. /customers for Customer)
    const guess = model.toLowerCase() + "s";
    const targetState = states.find(s => s.path && s.path.toLowerCase().includes(guess));
    if (!targetState) continue;
    const actions: StateAction[] = targetState.actions ? [...targetState.actions] : [];
    actions.push({ kind: "add", target: model.toLowerCase(), comment: `Model: ${model}` });
    for (const f of fields.slice(0, 6)) {
      actions.push({ kind: "edit", target: f });
    }
    actions.push({ kind: "delete", target: model.toLowerCase() });
    (targetState as any).actions = actions;
  }

  // 7. Mutate routes → state.actions on parent page where possible
  for (const r of mutateRoutes) {
    if (r.path.includes("{")) continue;
    const parent = states.find(s => s.path && r.path.startsWith(s.path) && s.path !== "/");
    if (!parent) continue;
    const segments = r.path.replace(parent.path ?? "", "").split("/").filter(Boolean);
    const verb = segments.pop() || r.method;
    const kind: StateAction["kind"] = r.method === "delete" ? "delete" : verb.includes("upload") ? "upload" : r.method === "post" ? "submit" : "edit";
    parent.actions = parent.actions ?? [];
    parent.actions.push({ kind, target: verb, comment: `${r.method.toUpperCase()} ${r.path}` });
  }

  // 8. Transition from anon to every public-looking page (heuristic — flows that are reachable from /)
  for (const s of states) {
    if (s.num === anonNum) continue;
    if (!s.path) continue;
    if (s.roles?.includes("anon") || s.roles?.includes("client") || PUBLIC_HINT.test(s.path)) {
      transitions.push({ from: anonNum, to: s.num, label: `navigate to ${s.path}` });
    }
  }

  // Build FlowDoc
  const newDoc: FlowDoc = {
    title: titleize(basename(root)) + " — auto-scanned (Laravel)",
    subtitle: `${states.length} states · ${transitions.length} transitions · auto-extracted ${new Date().toISOString().slice(0,10)}`,
    roles: [
      { id: "anon", name: "Anonymous", color: "#64748b" },
      { id: "client", name: "Customer", color: "#c026d3" },
      { id: "any", name: "Any role", color: "#64748b" },
    ],
    states, transitions, scenarios: [],
  };

  const outPath = resolve(process.cwd(), opts.out);
  if (opts.merge && existsSync(outPath)) {
    const existing = JSON.parse(readFileSync(outPath, "utf8")) as FlowDoc;
    const existingIds = new Set((existing.states ?? []).map(s => s.id));
    const newOnes = (newDoc.states ?? []).filter(s => !existingIds.has(s.id));
    // Renumber new states to avoid num collisions
    let maxNum = Math.max(0, ...(existing.states ?? []).map(s => s.num));
    const idRemap = new Map<string, number>();
    for (const s of newOnes) {
      maxNum++;
      idRemap.set(s.id, maxNum);
      s.num = maxNum;
    }
    // Remap any transitions referring to those
    const newTransitions = (newDoc.transitions ?? []).map(t => ({
      ...t,
      from: idRemap.get((newDoc.states ?? []).find(s => s.num === t.from)?.id ?? "") ?? t.from,
      to: idRemap.get((newDoc.states ?? []).find(s => s.num === t.to)?.id ?? "") ?? t.to,
    })).filter(t => existingIds.has((newDoc.states ?? []).find(s => s.num === t.from)?.id ?? "") || idRemap.has((newDoc.states ?? []).find(s => s.num === t.from)?.id ?? ""));

    existing.states = [...(existing.states ?? []), ...newOnes];
    existing.transitions = [...(existing.transitions ?? []), ...newTransitions];
    existing.subtitle = (existing.subtitle ?? "") + ` + ${newOnes.length} new from Laravel scan`;
    writeFileSync(outPath, JSON.stringify(existing, null, 2) + "\n", "utf8");
    console.log(`✓ merged into ${opts.out}: ${newOnes.length} new states (${(existing.states ?? []).length} total)`);
  } else {
    writeFileSync(outPath, JSON.stringify(newDoc, null, 2) + "\n", "utf8");
    console.log(`✓ wrote ${opts.out}: ${states.length} states, ${transitions.length} transitions, ${notifications.length} notifications, ${modelFields.size} models with fields`);
    console.log(`  routes scanned: ${pageRoutes.length} GET pages + ${mutateRoutes.length} mutate routes`);
    console.log(`  Next: flowdoc rebuild ${opts.out} -o sitemap.html -p /var/www/flowchart/<project>/index.html`);
  }
}
