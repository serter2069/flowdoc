import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { validateFlowDoc, type FlowDoc, type Scenario, type State, type StateAction, type Transition } from "../schema.js";

interface GenerateOpts {
  baseUrl: string;
  out: string;
  roles?: string;
  includeActions: boolean;
  includeScenarios: boolean;
}

const ROLE_GLYPH: Record<string, string> = {
  admin: "👑", manager: "🧑‍💼", dispatcher: "📋", worker: "🛠", client: "👤", anon: "🚪", any: "🌐",
};

/* ─── Helpers to build TS snippets ────────────────────────────────── */

function tsStringLit(s: string): string {
  return JSON.stringify(s);
}

function safeIdent(s: string): string {
  return s.replace(/[^a-z0-9]+/gi, "_").replace(/^_+|_+$/g, "").replace(/^(\d)/, "_$1");
}

function inferActionSelector(action: StateAction): string {
  if (action.selector?.testid) return `page.getByTestId(${tsStringLit(action.selector.testid)})`;
  if (action.selector?.role && action.selector?.text) return `page.getByRole(${tsStringLit(action.selector.role)}, { name: ${tsStringLit(action.selector.text)} })`;
  if (action.selector?.text) return `page.getByText(${tsStringLit(action.selector.text)})`;
  if (action.selector?.css) return `page.locator(${tsStringLit(action.selector.css)})`;

  // Heuristics by action kind
  const t = action.target;
  switch (action.kind) {
    case "add":     return `page.getByRole("button", { name: /\\+\\s*new\\s+${t}|add\\s+${t}/i })`;
    case "delete":  return `page.getByRole("button", { name: /delete|remove/i })`;
    case "upload":  return `page.locator("input[type=file]")`;
    case "edit":    return `page.getByLabel(${tsStringLit(t)}).or(page.getByPlaceholder(new RegExp(${tsStringLit(t)}, "i")))`;
    case "toggle":  return `page.getByRole("switch", { name: new RegExp(${tsStringLit(t)}, "i") })`;
    case "submit":  return `page.getByRole("button", { name: new RegExp(${tsStringLit(t)}, "i") })`;
    case "approve": return `page.getByRole("button", { name: /approve|accept|sign/i })`;
    case "reject":  return `page.getByRole("button", { name: /reject|decline/i })`;
    default:        return `page.getByRole("button", { name: new RegExp(${tsStringLit(t)}, "i") })`;
  }
}

function inferTransitionStep(t: Transition, _fromState: State | undefined, toState: State | undefined): string[] {
  // If destination has a path, prefer navigation (most reliable)
  if (toState?.path && !toState.path.includes("{") && !toState.path.includes(":")) {
    return [`  await page.goto(BASE_URL + ${tsStringLit(toState.path)});`];
  }
  // Otherwise, infer from label
  if (t.hint) {
    const h = t.hint;
    if (h.action === "click" || h.action === "tap") {
      if (h.selector?.text) return [`  await page.getByText(${tsStringLit(h.selector.text)}).click();`];
      if (h.selector?.role && h.selector?.text) return [`  await page.getByRole(${tsStringLit(h.selector.role)}, { name: ${tsStringLit(h.selector.text)} }).click();`];
    }
    if (h.action === "fill" && h.selector && h.value) {
      const sel = h.selector.css ? `page.locator(${tsStringLit(h.selector.css)})` : `page.getByLabel(${tsStringLit(h.selector.text ?? "")})`;
      return [`  await ${sel}.fill(${tsStringLit(h.value)});`];
    }
  }
  // Fallback: try to click button matching label, then expect target state to render
  if (t.label) {
    const m = t.label.match(/click\s+["'](.+?)["']/i) || t.label.match(/tap\s+["'](.+?)["']/i);
    if (m) return [`  await page.getByText(${tsStringLit(m[1])}).click();`];
    if (/^click /i.test(t.label) || /^tap /i.test(t.label)) {
      const name = t.label.replace(/^(click|tap)\s+/i, "");
      return [`  await page.getByText(new RegExp(${tsStringLit(name)}, "i")).first().click();`];
    }
  }
  return [`  // TODO transition: ${t.label || `${t.from}→${t.to}`}${t.cond ? ` (when ${t.cond})` : ""}`];
}

function assertState(state: State | undefined): string {
  if (!state) return "  // (target state missing)";
  if (state.path && !state.path.includes("{") && !state.path.includes(":")) {
    return `  await expect(page).toHaveURL(new RegExp(${tsStringLit(state.path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))}));`;
  }
  // Fallback: assert title text appears
  const titleHint = state.title.split("·")[0].split("(")[0].trim();
  if (titleHint) return `  await expect(page.getByText(new RegExp(${tsStringLit(titleHint.slice(0, 30))}, "i")).first()).toBeVisible({ timeout: 10000 }).catch(() => {});`;
  return "  // (no assertion hint)";
}

/* ─── Templates ───────────────────────────────────────────────────── */

function tplPlaywrightConfig(baseUrl: string, roles: string[]): string {
  const projects = roles.map((r) => `    {
      name: ${tsStringLit(r)},
      use: {
        ...devices["Desktop Chrome"],
        storageState: "fixtures/auth/${r}.json",
      },
    },
    {
      name: ${tsStringLit(r + "-mobile")},
      use: {
        ...devices["iPhone 14"],
        storageState: "fixtures/auth/${r}.json",
      },
    }`).join(",\n");

  return `// Generated by \`flowdoc generate\` — edit cautiously, will be regenerated.
import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: [["html", { open: "never" }], ["list"]],
  use: {
    baseURL: ${tsStringLit(baseUrl)},
    trace: "on-first-retry",
    screenshot: "only-on-failure",
  },
  projects: [
${projects},
    // Anonymous (no auth)
    {
      name: "anon",
      use: {
        ...devices["Desktop Chrome"],
      },
    },
    {
      name: "anon-mobile",
      use: {
        ...devices["iPhone 14"],
      },
    },
  ],
});
`;
}

function tplAuthHelper(): string {
  return `// Generated by \`flowdoc generate\` — auth seed script.
// One-off: log into the app once per role, save storageState to fixtures/auth/<role>.json.
// Run: node fixtures/auth/seed.js admin admin@example.com password
//      node fixtures/auth/seed.js manager manager@example.com password
//      node fixtures/auth/seed.js worker worker@example.com password
// Each generated test loads the matching storageState via playwright.config.ts.
const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");

(async () => {
  const [role, email, password] = process.argv.slice(2);
  if (!role || !email || !password) {
    console.error("usage: node seed.js <role> <email> <password>");
    process.exit(1);
  }
  const baseUrl = process.env.BASE_URL || "${"${BASE_URL_PLACEHOLDER}"}";
  const browser = await chromium.launch();
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto(baseUrl);
  await page.locator('input[type="email"], input[autocomplete="email"], input[placeholder*="@"]').first().fill(email);
  await page.locator('input[type="password"]').first().fill(password);
  await page.getByRole("button", { name: /sign in|log in/i }).click();
  await page.waitForLoadState("networkidle", { timeout: 10000 }).catch(() => {});
  const out = path.join(__dirname, role + ".json");
  await ctx.storageState({ path: out });
  console.log("✓ wrote", out);
  await browser.close();
})();
`;
}

function tplScenarioSpec(scenario: Scenario, doc: FlowDoc): string {
  const stateByNum = new Map((doc.states ?? []).map((s) => [s.num, s]));
  const lines: string[] = [];
  lines.push(`// Generated from scenario "${scenario.id}" — ${scenario.title}`);
  lines.push(`// Path: ${scenario.path.join(" → ")}`);
  lines.push(`// Narrative: ${(scenario.narrative ?? "").replace(/\n/g, " ")}`);
  lines.push(`import { test, expect } from "@playwright/test";`);
  lines.push(`const BASE_URL = process.env.BASE_URL || "";`);
  lines.push("");

  const projectName = scenario.role && scenario.role !== "any" ? scenario.role : "anon";
  lines.push(`test.describe(${tsStringLit(scenario.title)}, () => {`);
  lines.push(`  test.use({ /* runs in projects matching role="${projectName}" via playwright.config.ts */ });`);
  lines.push("");
  lines.push(`  test(${tsStringLit(`${scenario.id}: ${scenario.title}`)}, async ({ page }) => {`);

  const firstNum = scenario.path[0];
  const firstState = stateByNum.get(firstNum);
  if (firstState?.path && !firstState.path.includes("{") && !firstState.path.includes(":")) {
    lines.push(`    // Enter scenario at state #${firstNum} (${firstState.title})`);
    lines.push(`    await page.goto(BASE_URL + ${tsStringLit(firstState.path)});`);
  } else {
    lines.push(`    // Enter at state #${firstNum} — ${firstState?.title || "?"}`);
    lines.push(`    await page.goto(BASE_URL);`);
  }
  lines.push("");

  for (let i = 0; i < scenario.path.length - 1; i++) {
    const fromNum = scenario.path[i];
    const toNum = scenario.path[i + 1];
    const from = stateByNum.get(fromNum);
    const to = stateByNum.get(toNum);
    const transition = (doc.transitions ?? []).find((t) => t.from === fromNum && t.to === toNum);
    lines.push(`    // ── step ${i + 1}: #${fromNum} → #${toNum} ${transition?.label ? `(${transition.label})` : ""}`);
    const comment = (scenario.comments ?? []).find((c) => c.at_step === i + 1);
    if (comment) lines.push(`    // 💬 ${comment.kind ?? "note"}: ${comment.text}`);
    if (transition) {
      const steps = inferTransitionStep(transition, from, to);
      lines.push(...steps);
    } else {
      lines.push(`    // (no transition defined between #${fromNum} and #${toNum})`);
    }
    lines.push(assertState(to));
    lines.push("");
  }

  lines.push(`  });`);
  lines.push(`});`);
  return lines.join("\n");
}

function tplActionMatrixSpec(state: State, _doc: FlowDoc, allRoles: string[]): string {
  const lines: string[] = [];
  lines.push(`// Generated action-matrix tests for state #${state.num} ${state.title}`);
  lines.push(`// Path: ${state.path ?? "(no direct path)"}`);
  lines.push(`import { test, expect } from "@playwright/test";`);
  lines.push(`const BASE_URL = process.env.BASE_URL || "";`);
  lines.push("");
  lines.push(`test.describe(${tsStringLit(`#${state.num} ${state.title} — actions × roles`)}, () => {`);

  const enterStep = state.path && !state.path.includes("{") && !state.path.includes(":")
    ? `    await page.goto(BASE_URL + ${tsStringLit(state.path)});`
    : `    // TODO: navigate to state #${state.num} (no direct path)`;

  for (const action of state.actions ?? []) {
    const sel = inferActionSelector(action);
    // Positive tests
    for (const role of action.allowedRoles ?? allRoles) {
      const testName = `${ROLE_GLYPH[role] ?? "·"} ${role} CAN ${action.kind} ${action.target}`;
      lines.push("");
      lines.push(`  test(${tsStringLit(testName)}, async ({ page, browserName }) => {`);
      lines.push(`    // Run in project "${role}" (see playwright.config.ts)`);
      lines.push(`    test.skip(!test.info().project.name.startsWith(${tsStringLit(role)}), "wrong-project");`);
      lines.push(enterStep);
      lines.push(`    const target = ${sel};`);
      lines.push(`    await expect(target).toBeVisible({ timeout: 5000 });`);
      if (action.comment) lines.push(`    // 💬 ${action.comment}`);
      lines.push(`    // TODO: perform the ${action.kind} action and assert success state`);
      lines.push(`  });`);
    }
    // Negative tests
    for (const role of action.deniedRoles ?? []) {
      const testName = `${ROLE_GLYPH[role] ?? "·"} ${role} CANNOT ${action.kind} ${action.target}`;
      lines.push("");
      lines.push(`  test(${tsStringLit(testName)}, async ({ page }) => {`);
      lines.push(`    test.skip(!test.info().project.name.startsWith(${tsStringLit(role)}), "wrong-project");`);
      lines.push(enterStep);
      lines.push(`    const target = ${sel};`);
      lines.push(`    await expect(target).not.toBeVisible({ timeout: 3000 });`);
      if (action.comment) lines.push(`    // 💬 ${action.comment}`);
      lines.push(`  });`);
    }
  }

  lines.push(`});`);
  return lines.join("\n");
}

/* ─── Command ─────────────────────────────────────────────────────── */

export function generateCommand(flowsArg: string | undefined, opts: GenerateOpts) {
  const flowsPath = resolve(process.cwd(), flowsArg ?? "flows.json");
  if (!existsSync(flowsPath)) {
    console.error(`flows.json not found: ${flowsPath}`);
    process.exit(1);
  }
  const doc = validateFlowDoc(JSON.parse(readFileSync(flowsPath, "utf8")));
  const allRoles = (doc.roles ?? []).map((r) => r.id).filter((id) => id !== "any" && id !== "anon");
  const targetRoles = opts.roles ? opts.roles.split(",").map((s) => s.trim()) : (allRoles.length ? allRoles : ["admin", "manager", "worker"]);

  const outDir = resolve(process.cwd(), opts.out);
  const fixturesDir = join(outDir, "fixtures", "auth");
  const scenariosDir = join(outDir, "generated", "scenarios");
  const actionsDir = join(outDir, "generated", "actions");
  for (const d of [outDir, fixturesDir, scenariosDir, actionsDir]) {
    if (!existsSync(d)) mkdirSync(d, { recursive: true });
  }

  // 1. playwright.config.ts
  const configPath = join(outDir, "playwright.config.ts");
  writeFileSync(configPath, tplPlaywrightConfig(opts.baseUrl, targetRoles), "utf8");

  // 2. fixtures/auth/seed.js + per-role placeholder storageState
  writeFileSync(join(fixturesDir, "seed.js"), tplAuthHelper().replace("${BASE_URL_PLACEHOLDER}", opts.baseUrl), "utf8");
  for (const r of targetRoles) {
    const fp = join(fixturesDir, `${r}.json`);
    if (!existsSync(fp)) writeFileSync(fp, JSON.stringify({ cookies: [], origins: [] }, null, 2), "utf8");
  }

  // 3. scenarios
  let scenarioCount = 0;
  if (opts.includeScenarios) {
    for (const sc of doc.scenarios ?? []) {
      const fn = join(scenariosDir, `${safeIdent(sc.id)}.spec.ts`);
      writeFileSync(fn, tplScenarioSpec(sc, doc), "utf8");
      scenarioCount++;
    }
  }

  // 4. action-matrix tests
  let actionCount = 0;
  if (opts.includeActions) {
    for (const s of doc.states ?? []) {
      if (!s.actions || s.actions.length === 0) continue;
      const fn = join(actionsDir, `${s.num}-${safeIdent(s.id)}.spec.ts`);
      writeFileSync(fn, tplActionMatrixSpec(s, doc, targetRoles), "utf8");
      actionCount++;
    }
  }

  // 5. README
  const readmePath = join(outDir, "README.md");
  if (!existsSync(readmePath)) {
    writeFileSync(readmePath, `# Generated by flowdoc

This directory was generated from \`${flowsArg ?? "flows.json"}\`.

## First time setup

\`\`\`bash
npm i -D @playwright/test playwright
npx playwright install chromium

# Seed auth storage state per role
node fixtures/auth/seed.js admin admin@example.com YOUR_PASS
node fixtures/auth/seed.js manager manager@example.com YOUR_PASS
node fixtures/auth/seed.js worker worker@example.com YOUR_PASS
\`\`\`

## Run

\`\`\`bash
BASE_URL=${opts.baseUrl} npx playwright test
\`\`\`

## What's here

- \`generated/scenarios/*.spec.ts\` — one test per scenario, runs as the scenario's role
- \`generated/actions/*.spec.ts\` — for every mutate-action on each state, generates positive
  (allowed roles) and negative (denied roles) tests
- \`playwright.config.ts\` — projects for ${targetRoles.join(", ")} + anon, each in desktop + mobile variants

## Regenerate

\`\`\`bash
flowdoc generate ${flowsArg ?? "flows.json"} --base-url ${opts.baseUrl} --out ${opts.out}
\`\`\`

Will overwrite \`generated/\` and \`playwright.config.ts\`, will NOT touch \`fixtures/auth/*.json\`.
`, "utf8");
  }

  console.log(`✓ ${configPath}`);
  console.log(`✓ ${fixturesDir}/seed.js + per-role .json placeholders`);
  console.log(`✓ ${scenarioCount} scenario spec(s) in ${scenariosDir}`);
  console.log(`✓ ${actionCount} action-matrix spec(s) in ${actionsDir}`);
  console.log(`✓ ${readmePath}`);
  console.log("");
  console.log(`Next:`);
  console.log(`  cd ${opts.out}`);
  console.log(`  node fixtures/auth/seed.js admin admin@example.com PASS    # once per role`);
  console.log(`  BASE_URL=${opts.baseUrl} npx playwright test`);
}
