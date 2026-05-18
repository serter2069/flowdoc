import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { validateFlowDoc, type FlowDoc, type State, type ScenarioStep, type ScenarioTree } from "../schema.js";
import { expandScenarioTree, type ScenarioRoute } from "./scenario-tree.js";

interface ValidateOpts {
  format: "text" | "json";
  failOnWarning: boolean;
  maxCombinationSize: number;
}

interface Issue {
  level: "error" | "warning";
  treeId: string;
  treeTitle: string;
  routeId?: string;
  stepIndex?: number;
  stepText?: string;
  stateRef?: number;
  reason: string;
  hint?: string;
}

/**
 * Lint scenarioTrees against the state graph. We catch three classes of bug:
 *
 *   1. stateRef points to a state that doesn't exist (or wasn't scanned)
 *   2. step.action ("kind:target") doesn't match any state.actions[] entry
 *   3. step text mentions a UI affordance (pick/select/upload/submit X) that
 *      has no supporting action on the state — most common source of
 *      hallucinated steps when scenarios are written from memory rather than
 *      from the code.
 *
 * Class-3 is heuristic — it can have false positives. Run with --format json
 * to feed the output back into an LLM for second-pass review.
 */
export function validateCommand(flowsArg: string, opts: ValidateOpts): void {
  const flowsPath = resolve(process.cwd(), flowsArg);
  const raw = readFileSync(flowsPath, "utf8");
  const doc: FlowDoc = validateFlowDoc(JSON.parse(raw), { strictScenarios: false });
  const trees = doc.scenarioTrees ?? [];
  const states = doc.states ?? [];
  const byNum = new Map(states.map((s) => [s.num, s]));

  const issues: Issue[] = [];

  for (const tree of trees) {
    let routes: ScenarioRoute[] = [];
    try {
      routes = expandScenarioTree(tree, { maxCombinationSize: opts.maxCombinationSize });
    } catch (e) {
      issues.push({
        level: "error", treeId: tree.id, treeTitle: tree.title,
        reason: `Failed to expand: ${(e as Error).message}`,
      });
      continue;
    }
    for (const route of routes) {
      for (let i = 0; i < route.steps.length; i++) {
        const step = route.steps[i];
        const ctx = { tree, route, step, stepIndex: i };
        checkStateExists(ctx, byNum, issues);
        checkActionMatches(ctx, byNum, issues);
        checkTextMentionsRealAction(ctx, byNum, issues);
      }
    }
  }

  const errors = issues.filter((x) => x.level === "error").length;
  const warnings = issues.filter((x) => x.level === "warning").length;

  if (opts.format === "json") {
    process.stdout.write(JSON.stringify({ summary: { errors, warnings, totalRoutes: routesCount(trees, opts.maxCombinationSize), totalTrees: trees.length }, issues }, null, 2) + "\n");
  } else {
    printText(issues, trees.length, routesCount(trees, opts.maxCombinationSize));
  }

  if (errors > 0 || (opts.failOnWarning && warnings > 0)) {
    process.exit(1);
  }
}

function routesCount(trees: ScenarioTree[], maxCombinationSize: number): number {
  let total = 0;
  for (const t of trees) {
    try { total += expandScenarioTree(t, { maxCombinationSize }).length; } catch { /* skip */ }
  }
  return total;
}

interface StepContext {
  tree: ScenarioTree;
  route: ScenarioRoute;
  step: ScenarioStep;
  stepIndex: number;
}

function checkStateExists(ctx: StepContext, byNum: Map<number, State>, out: Issue[]): void {
  if (ctx.step.stateRef === undefined) return;
  if (!byNum.has(ctx.step.stateRef)) {
    out.push({
      level: "error",
      treeId: ctx.tree.id, treeTitle: ctx.tree.title,
      routeId: ctx.route.routeId, stepIndex: ctx.stepIndex + 1,
      stepText: ctx.step.step, stateRef: ctx.step.stateRef,
      reason: `stateRef ${ctx.step.stateRef} does not exist`,
      hint: "Run a scan to refresh state nums, or fix the stateRef manually.",
    });
  }
}

function checkActionMatches(ctx: StepContext, byNum: Map<number, State>, out: Issue[]): void {
  if (!ctx.step.action) return;
  const state = ctx.step.stateRef !== undefined ? byNum.get(ctx.step.stateRef) : undefined;
  if (!state) return;
  const [kind, ...rest] = ctx.step.action.split(":");
  const target = (rest.join(":") || "").toLowerCase();
  const actions = state.actions ?? [];

  // Fuzzy match strategy, in order of strictness:
  //   1. exact kind+target
  //   2. target substring match either direction
  //   3. target appears in action.comment (e.g. URL slug match — common when
  //      scanner extracts "submit:s" from POST /bookings)
  //   4. kind-only match if target was generic ("booking" → any submit action
  //      whose URL contains "booking")
  const stateId = state.id.toLowerCase();
  const stateIdContainsTarget = target !== "" && (stateId.includes(target) || stateId.includes(target.replace(/s$/, "")));
  const match = actions.find((a) => {
    if (a.kind !== kind) return false;
    if (target === "") return true;
    if (a.target === target) return true;
    if (a.target.toLowerCase().includes(target) || target.includes(a.target.toLowerCase())) return true;
    if ((a.comment ?? "").toLowerCase().includes(target)) return true;
    // Singular/plural shift: "booking" vs "bookings"
    const tNoPlural = target.replace(/s$/, "");
    if (tNoPlural && (a.target.toLowerCase().includes(tNoPlural) || (a.comment ?? "").toLowerCase().includes(tNoPlural))) return true;
    // State-id implies the target: rn-loginscreen has submit:sign-in — a step
    // saying `submit:login` is clearly about THIS screen since the state id
    // contains "login". Accept any same-kind action.
    if (stateIdContainsTarget) return true;
    return false;
  });

  if (!match) {
    const available = actions.map((a) => `${a.kind}:${a.target}`).join(", ") || "(none)";
    out.push({
      level: "warning",
      treeId: ctx.tree.id, treeTitle: ctx.tree.title,
      routeId: ctx.route.routeId, stepIndex: ctx.stepIndex + 1,
      stepText: ctx.step.step, stateRef: ctx.step.stateRef,
      reason: `action '${ctx.step.action}' has no match on state ${state.id}`,
      hint: `Available actions: ${available}`,
    });
  }
}

const VERB_PATTERNS: Array<{ verbs: RegExp; kindWords: string[]; nounRe: RegExp }> = [
  { verbs: /\b(picks?|selects?|chooses?|tap[s]? (?:a |an |the )?|click[s]? (?:a |an |the )?)\b/i,
    kindWords: ["select", "edit", "submit"],
    nounRe: /\b(?:picks?|selects?|chooses?|tap[s]?|click[s]?)\b[^.]*?\b(time slot|date|slot|option|product|customer|worker|company|role|category|item|status|address|location|photo|file|attachment|tab|button)\b/i },
  { verbs: /\b(uploads?|attaches?)\b/i,
    kindWords: ["upload"],
    nounRe: /\b(?:uploads?|attaches?)\b[^.]*?\b(photo|file|attachment|image|document|csv)\b/i },
  { verbs: /\b(submits?|saves?|creates?|posts?)\b/i,
    kindWords: ["submit", "add"],
    nounRe: /\b(?:submits?|saves?|creates?|posts?)\b[^.]*?\b(booking|customer|offer|message|reply|payment|template|user|role|vertical|product|location)\b/i },
  { verbs: /\b(deletes?|cancels?|removes?)\b/i,
    kindWords: ["delete"],
    nounRe: /\b(?:deletes?|cancels?|removes?)\b[^.]*?\b(booking|customer|offer|message|user|product|location|vertical)\b/i },
  { verbs: /\b(approves?|rejects?)\b/i,
    kindWords: ["approve", "reject"],
    nounRe: /\b(?:approves?|rejects?)\b[^.]*?\b(booking|offer|payment|user|application)\b/i },
];

function checkTextMentionsRealAction(ctx: StepContext, byNum: Map<number, State>, out: Issue[]): void {
  const state = ctx.step.stateRef !== undefined ? byNum.get(ctx.step.stateRef) : undefined;
  if (!state) return;
  if (ctx.step.action) return; // explicit action already validated by checkActionMatches
  // Side-effect states (notifications, emails, webhooks, jobs, db) have no
  // user-visible affordances — verb heuristics don't apply.
  if (["push", "email", "webhook", "effect", "db"].includes(state.kind)) return;
  // Step text describing an outcome rather than a user action — skip heuristic.
  if (/\b(notification|email|webhook|callback|fires|dispatched|sent|recorded|persisted|queued|succeeds|completes|renders|returns)\b/i.test(ctx.step.step)) return;
  // Negative / edge-case scenarios — the absence of a UI action IS the test.
  if (/\b(without|skip|leave blank|leave empty|empty|invalid|wrong|bad|missing|no \w+)\b/i.test(ctx.step.step)) return;
  const text = ctx.step.step;
  const actions = state.actions ?? [];

  for (const pat of VERB_PATTERNS) {
    const nounMatch = text.match(pat.nounRe);
    if (!nounMatch) continue;
    const noun = nounMatch[1].toLowerCase();
    const matchingActions = actions.filter((a) => pat.kindWords.includes(a.kind));
    const matchingByNoun = matchingActions.filter((a) => {
      const t = a.target.toLowerCase();
      const c = (a.comment ?? "").toLowerCase();
      return t.includes(noun) || c.includes(noun) || noun.includes(t);
    });
    if (matchingActions.length === 0) {
      // No actions of any matching kind on this state — clear hallucination
      out.push({
        level: "warning",
        treeId: ctx.tree.id, treeTitle: ctx.tree.title,
        routeId: ctx.route.routeId, stepIndex: ctx.stepIndex + 1,
        stepText: text, stateRef: ctx.step.stateRef,
        reason: `step mentions ${verbWordOf(text, pat.verbs)} ${noun} but state ${state.id} has no ${pat.kindWords.join("/")} actions`,
        hint: actions.length === 0
          ? `state has no actions[] at all — either the scanner missed them or this step lives on the wrong state`
          : `state actions: ${actions.map((a) => `${a.kind}:${a.target}`).join(", ")}`,
      });
      return;
    }
    if (matchingByNoun.length === 0 && matchingActions.length > 0) {
      // Has actions of right kind but none targeting the noun
      out.push({
        level: "warning",
        treeId: ctx.tree.id, treeTitle: ctx.tree.title,
        routeId: ctx.route.routeId, stepIndex: ctx.stepIndex + 1,
        stepText: text, stateRef: ctx.step.stateRef,
        reason: `step mentions ${verbWordOf(text, pat.verbs)} ${noun} but no action on state ${state.id} targets that noun`,
        hint: `${pat.kindWords.join("/")} actions present: ${matchingActions.map((a) => `${a.kind}:${a.target}`).join(", ")}`,
      });
      return;
    }
  }
}

function verbWordOf(text: string, verbs: RegExp): string {
  const m = text.match(verbs);
  return m ? m[0].toLowerCase() : "(verb)";
}

function printText(issues: Issue[], treeCount: number, routeCount: number): void {
  const errors = issues.filter((x) => x.level === "error");
  const warnings = issues.filter((x) => x.level === "warning");

  if (issues.length === 0) {
    console.log(`✓ ${treeCount} trees, ${routeCount} routes — no issues found.`);
    return;
  }

  const byTree = new Map<string, Issue[]>();
  for (const i of issues) {
    if (!byTree.has(i.treeId)) byTree.set(i.treeId, []);
    byTree.get(i.treeId)!.push(i);
  }

  for (const [treeId, list] of byTree) {
    const title = list[0].treeTitle;
    console.log(`\n${treeId} — ${title}`);
    for (const i of list) {
      const tag = i.level === "error" ? "✗ error" : "⚠ warning";
      const loc = i.routeId
        ? `${i.routeId} · step ${i.stepIndex}`
        : "(tree-level)";
      console.log(`  ${tag}  ${loc}`);
      if (i.stepText) console.log(`         step: "${i.stepText}"`);
      console.log(`         ${i.reason}`);
      if (i.hint) console.log(`         hint: ${i.hint}`);
    }
  }

  console.log(`\nSummary: ${treeCount} trees · ${routeCount} routes · ${errors.length} errors · ${warnings.length} warnings`);
}
