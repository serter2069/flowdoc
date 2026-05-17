import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import Database from "better-sqlite3";
import { chromium, type Page } from "playwright";
import { validateFlowDoc, type FlowDoc, type Screen, type ScreenKind } from "../schema.js";

interface DiscoverOpts {
  baseUrl: string;
  out: string;
  cookies?: string;
  headed: boolean;
  timeout: number;
  apply: boolean;
  params?: string;
}

interface DomElement {
  kind: "link" | "button" | "input" | "textarea" | "select";
  selector: string;
  label: string;
  href?: string;
}

function openDb(dbPath: string): Database.Database {
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE IF NOT EXISTS discovered (
      run_id TEXT NOT NULL,
      screen_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      selector TEXT,
      label TEXT,
      href TEXT
    );
  `);
  return db;
}

function nowId(): string {
  return "disc-" + new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
}

function parseParams(s?: string): Record<string, string> {
  if (!s) return {};
  const out: Record<string, string> = {};
  for (const pair of s.split(",")) {
    const [k, v] = pair.split("=");
    if (k && v) out[k.trim()] = v.trim();
  }
  return out;
}

function resolvePath(p: string, params: Record<string, string>): string | null {
  const parts = p.split("/").map((seg) => {
    if (seg.startsWith(":")) {
      const key = seg.slice(1).replace(/\*$/, "");
      return params[key] ?? null;
    }
    return seg;
  });
  if (parts.some((x) => x === null)) return null;
  return parts.join("/");
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "screen";
}

function pathToId(p: string): string {
  return slugify(p.replace(/\/$/, "")) || "root";
}

function inferKind(href: string): ScreenKind {
  const low = href.toLowerCase();
  if (/login|signin|signup|register|forgot|reset/.test(low)) return "auth";
  if (/modal/.test(low)) return "modal";
  return "screen";
}

function humanName(p: string): string {
  const last = p.split("/").filter(Boolean).pop() ?? "Screen";
  return last.replace(/[-_]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

async function enumerate(page: Page): Promise<DomElement[]> {
  return page.evaluate(() => {
    const out: { kind: string; selector: string; label: string; href?: string }[] = [];
    function cssPath(el: Element): string {
      if (el instanceof HTMLElement && el.dataset.testid) return `[data-testid="${el.dataset.testid}"]`;
      const id = (el as HTMLElement).id;
      if (id) return `#${CSS.escape(id)}`;
      const parts: string[] = [];
      let cur: Element | null = el;
      while (cur && cur.nodeType === 1 && parts.length < 4) {
        let part = cur.nodeName.toLowerCase();
        const cls = (cur as HTMLElement).className?.toString().trim().split(/\s+/).filter(Boolean).slice(0, 2).join(".");
        if (cls) part += "." + cls;
        const parent = cur.parentElement;
        if (parent) {
          const sib = Array.from(parent.children).filter((c) => c.nodeName === cur!.nodeName);
          if (sib.length > 1) part += `:nth-of-type(${sib.indexOf(cur) + 1})`;
        }
        parts.unshift(part);
        cur = cur.parentElement;
      }
      return parts.join(" > ");
    }
    function label(el: Element): string {
      const t = (el.getAttribute("aria-label") || (el as HTMLElement).innerText || el.getAttribute("placeholder") || el.getAttribute("name") || "").trim();
      return t.slice(0, 60);
    }
    document.querySelectorAll("a[href]").forEach((el) => {
      const href = el.getAttribute("href") || "";
      out.push({ kind: "link", selector: cssPath(el), label: label(el), href });
    });
    document.querySelectorAll("button, [role='button']").forEach((el) => {
      out.push({ kind: "button", selector: cssPath(el), label: label(el) });
    });
    document.querySelectorAll("input").forEach((el) => {
      const type = (el as HTMLInputElement).type || "text";
      if (["hidden", "submit"].includes(type)) return;
      out.push({ kind: "input", selector: cssPath(el), label: label(el) });
    });
    document.querySelectorAll("textarea").forEach((el) => {
      out.push({ kind: "textarea", selector: cssPath(el), label: label(el) });
    });
    document.querySelectorAll("select").forEach((el) => {
      out.push({ kind: "select", selector: cssPath(el), label: label(el) });
    });
    return out;
  }) as Promise<DomElement[]>;
}

function knownPaths(doc: FlowDoc): Set<string> {
  return new Set((doc.screens ?? []).map((s) => s.path).filter((p): p is string => Boolean(p)));
}

function normalizeHref(href: string, baseUrl: string): string | null {
  if (!href || href.startsWith("#") || href.startsWith("javascript:") || href.startsWith("mailto:") || href.startsWith("tel:")) return null;
  try {
    const u = new URL(href, baseUrl);
    const baseHost = new URL(baseUrl).host;
    if (u.host !== baseHost) return null;
    return u.pathname + (u.search || "");
  } catch {
    return null;
  }
}

export async function discoverCommand(flowsArg: string, opts: DiscoverOpts) {
  const flowsPath = resolve(process.cwd(), flowsArg ?? "flows.json");
  const doc = validateFlowDoc(JSON.parse(readFileSync(flowsPath, "utf8")));
  const outDir = resolve(process.cwd(), opts.out);
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
  const dbPath = join(outDir, "flowdoc.db");
  const db = openDb(dbPath);
  const runId = nowId();
  const params = parseParams(opts.params);
  const screens = (doc.screens ?? []).filter((s) => s.path && !s.path.includes("("));
  console.log(`▶ discover ${runId}: scanning ${screens.length} screens at ${opts.baseUrl}`);
  const browser = await chromium.launch({ headless: !opts.headed });
  let useStorage = false;
  if (opts.cookies) {
    try {
      const parsed = JSON.parse(readFileSync(opts.cookies, "utf8"));
      useStorage = !Array.isArray(parsed) && parsed && Array.isArray(parsed.cookies);
    } catch {}
  }
  const ctx = await browser.newContext(useStorage ? { storageState: opts.cookies } : {});
  if (opts.cookies && !useStorage) {
    const parsed = JSON.parse(readFileSync(opts.cookies, "utf8"));
    if (Array.isArray(parsed) && parsed.length) await ctx.addCookies(parsed);
  }
  const page = await ctx.newPage();
  const insertEl = db.prepare(`INSERT INTO discovered(run_id,screen_id,kind,selector,label,href) VALUES (?,?,?,?,?,?)`);
  const known = knownPaths(doc);
  const newRoutes = new Map<string, { from: string; label: string }>();
  let totalElements = 0;
  for (const s of screens) {
    const resolved = resolvePath(s.path!, params);
    if (!resolved) continue;
    const url = opts.baseUrl.replace(/\/$/, "") + resolved;
    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: opts.timeout });
      await page.waitForLoadState("networkidle", { timeout: 4000 }).catch(() => {});
      const els = await enumerate(page);
      for (const el of els) {
        insertEl.run(runId, s.id, el.kind, el.selector, el.label, el.href ?? null);
        if (el.kind === "link" && el.href) {
          const norm = normalizeHref(el.href, opts.baseUrl);
          if (norm && !known.has(norm) && !newRoutes.has(norm)) {
            newRoutes.set(norm, { from: s.id, label: el.label || humanName(norm) });
          }
        }
      }
      totalElements += els.length;
      console.log(`  · ${s.id.padEnd(28)} ${els.length} elements`);
    } catch (err) {
      console.log(`  ! ${s.id.padEnd(28)} ${(err as Error).message}`);
    }
  }
  await browser.close();
  db.close();
  const newCount = newRoutes.size;
  console.log(`\n▶ found ${totalElements} interactive elements; ${newCount} untracked routes`);
  if (newCount) {
    console.log(`\n  Untracked routes:`);
    for (const [path, { from, label }] of newRoutes) {
      console.log(`    ${path.padEnd(40)} ← discovered on '${from}' as "${label}"`);
    }
  }
  if (opts.apply && newCount) {
    const addedScreens: Screen[] = [];
    for (const [path, { from, label }] of newRoutes) {
      const baseId = pathToId(path);
      let id = baseId;
      let n = 2;
      const existingIds = new Set((doc.screens ?? []).map((s) => s.id));
      while (existingIds.has(id)) id = `${baseId}-${n++}`;
      addedScreens.push({
        id,
        name: label || humanName(path),
        kind: inferKind(path),
        path,
        description: `auto-discovered from '${from}'`,
      });
      const parent = (doc.screens ?? []).find((s) => s.id === from);
      if (parent) parent.navTo = [...new Set([...(parent.navTo ?? []), id])];
    }
    (doc.screens ?? []).push(...addedScreens);
    doc.subtitle = (doc.subtitle ?? "") + ` (+${newCount} discovered ${new Date().toISOString().slice(0, 10)})`;
    writeFileSync(flowsPath, JSON.stringify(doc, null, 2) + "\n", "utf8");
    console.log(`\n✓ appended ${newCount} screens to ${flowsArg}`);
  } else if (newCount) {
    console.log(`\n  Re-run with --apply to append these to ${flowsArg}.`);
  }
  console.log(`  db: ${dbPath}`);
}
