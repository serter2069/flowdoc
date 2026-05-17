import { z } from "zod";

const ScreenKindSchema = z.enum([
  "tab",
  "drawer",
  "screen",
  "modal",
  "auth",
  "public",
  "nested",
  "external",
]);

const EdgeKindSchema = z.enum(["nav", "modal", "back", "deeplink", "tab", "external"]);

const RoleSchema = z.object({
  id: z.string().regex(/^[a-z0-9_-]+$/i),
  name: z.string(),
  icon: z.string().optional(),
  color: z.string().optional(),
  description: z.string().optional(),
});

const GroupSchema = z.object({
  id: z.string().regex(/^[a-z0-9_-]+$/i),
  name: z.string(),
  color: z.string().optional(),
  description: z.string().optional(),
});

const ScreenSchema = z.object({
  id: z.string().regex(/^[a-z0-9_:-]+$/i, "id may contain letters, digits, _, -, :"),
  name: z.string(),
  kind: ScreenKindSchema.default("screen"),
  group: z.string().optional(),
  path: z.string().optional(),
  description: z.string().optional(),
  roles: z.array(z.string()).optional(),
  components: z.array(z.string()).optional(),
  navTo: z.array(z.string()).optional(),
});

const EdgeSchema = z.object({
  from: z.string(),
  to: z.string(),
  label: z.string().optional(),
  kind: EdgeKindSchema.optional(),
});

/* ─── State-canvas extension (scenario coverage layer) ─── */

const StateKindSchema = z.enum([
  "page", "state", "modal", "error", "success",
  "effect", "email", "push", "api", "db", "webhook", "condition",
]);

const SelectorSchema = z.object({
  role: z.string().optional(),
  text: z.string().optional(),
  testid: z.string().optional(),
  placeholder: z.string().optional(),
  css: z.string().optional(),
});

const StepHintSchema = z.object({
  action: z.enum(["goto", "click", "tap", "fill", "select", "upload", "wait", "expect_url", "expect_text", "expect_visible", "drag", "press"]).optional(),
  selector: SelectorSchema.optional(),
  value: z.string().optional(),
  url: z.string().optional(),
  files: z.array(z.string()).optional(),
});

const PositionSchema = z.object({
  x: z.number(),
  y: z.number(),
});

const ActionKindSchema = z.enum([
  "edit", "add", "delete", "upload", "toggle", "submit", "approve", "reject",
]);

const StateActionSchema = z.object({
  kind: ActionKindSchema,
  target: z.string(),                           // field/component name: "phone", "photo", "booking item"
  allowedRoles: z.array(z.string()).optional(), // roles permitted to do this; empty = any
  deniedRoles: z.array(z.string()).optional(),  // explicit deny (for negative tests)
  selector: SelectorSchema.optional(),          // how to find the editor/button
  expect: z.string().optional(),                // what success looks like: "field saves, DB updated"
  comment: z.string().optional(),
});

const StateSchema = z.object({
  num: z.number().int().positive(),
  id: z.string(),
  kind: StateKindSchema.default("state"),
  title: z.string(),
  path: z.string().optional(),
  roles: z.array(z.string()).optional(),
  col: z.number().int().optional(),
  row: z.number().int().optional(),
  position: PositionSchema.optional(),
  desc: z.string().optional(),
  selectors: z.array(SelectorSchema).optional(),
  enterHint: StepHintSchema.optional(),         // how a test arrives at this state
  comments: z.array(z.string()).optional(),
  actions: z.array(StateActionSchema).optional(), // mutate-actions on this state (edit field, upload, delete, etc.)
});

const TransitionSchema = z.object({
  from: z.number().int(),
  to: z.number().int(),
  label: z.string().optional(),
  cond: z.string().optional(),
  fail: z.boolean().optional(),
  hint: StepHintSchema.optional(),            // the action that triggers this transition
});

const ScenarioCommentSchema = z.object({
  at_step: z.number().int().nonnegative(),    // index into path[]
  text: z.string(),
  kind: z.enum(["note", "warning", "todo"]).optional(),
});

const ScenarioSchema = z.object({
  id: z.string(),
  title: z.string(),
  role: z.string().optional(),
  narrative: z.string().optional(),
  path: z.array(z.number().int()).min(1),     // sequence of state.num values
  fixtures: z.record(z.string(), z.unknown()).optional(),
  baseline_id: z.string().optional(),         // links to .flowdoc/baseline/<id>/
  comments: z.array(ScenarioCommentSchema).optional(),
  tags: z.array(z.string()).optional(),
});

export const FlowDocSchema = z.object({
  title: z.string().default("Sitemap"),
  subtitle: z.string().optional(),
  roles: z.array(RoleSchema).optional(),
  groups: z.array(GroupSchema).optional(),
  screens: z.array(ScreenSchema).optional(),      // legacy — still supported

  // state-canvas extension (all optional → backwards compatible)
  states: z.array(StateSchema).optional(),
  transitions: z.array(TransitionSchema).optional(),
  scenarios: z.array(ScenarioSchema).optional(),

  edges: z.array(EdgeSchema).optional(),
}).refine((d) => (d.screens && d.screens.length) || (d.states && d.states.length), {
  message: "flows.json must have at least one of: screens[] (legacy) or states[] (state-canvas).",
});

export type FlowDoc = z.infer<typeof FlowDocSchema>;
export type Role = z.infer<typeof RoleSchema>;
export type Screen = z.infer<typeof ScreenSchema>;
export type Edge = z.infer<typeof EdgeSchema>;
export type Group = z.infer<typeof GroupSchema>;
export type ScreenKind = z.infer<typeof ScreenKindSchema>;
export type EdgeKind = z.infer<typeof EdgeKindSchema>;

export type State = z.infer<typeof StateSchema>;
export type Transition = z.infer<typeof TransitionSchema>;
export type Scenario = z.infer<typeof ScenarioSchema>;
export type StateKind = z.infer<typeof StateKindSchema>;
export type StepHint = z.infer<typeof StepHintSchema>;
export type Selector = z.infer<typeof SelectorSchema>;
export type StateAction = z.infer<typeof StateActionSchema>;
export type ActionKind = z.infer<typeof ActionKindSchema>;

export function validateFlowDoc(raw: unknown, opts: { strictScenarios?: boolean } = {}): FlowDoc {
  const strictScenarios = opts.strictScenarios !== false;     // default: strict
  const doc = FlowDocSchema.parse(raw);
  const screens = doc.screens ?? [];
  const screenIds = new Set(screens.map((s) => s.id));
  const groupIds = new Set((doc.groups ?? []).map((g) => g.id));
  const roleIds = new Set((doc.roles ?? []).map((r) => r.id));

  for (const s of screens) {
    if (s.group && groupIds.size && !groupIds.has(s.group)) {
      throw new Error(`Screen "${s.id}": unknown group "${s.group}"`);
    }
    for (const r of s.roles ?? []) {
      if (roleIds.size && !roleIds.has(r)) {
        throw new Error(`Screen "${s.id}": unknown role "${r}"`);
      }
    }
    for (const target of s.navTo ?? []) {
      if (!screenIds.has(target)) {
        throw new Error(`Screen "${s.id}".navTo: unknown screen "${target}"`);
      }
    }
  }
  for (const [i, e] of (doc.edges ?? []).entries()) {
    if (!screenIds.has(e.from)) throw new Error(`edges[${i}]: unknown screen "${e.from}"`);
    if (!screenIds.has(e.to)) throw new Error(`edges[${i}]: unknown screen "${e.to}"`);
  }

  // Validate state-canvas references
  const stateNums = new Set((doc.states ?? []).map((s) => s.num));
  for (const [i, t] of (doc.transitions ?? []).entries()) {
    if (!stateNums.has(t.from)) throw new Error(`transitions[${i}]: unknown state #${t.from}`);
    if (!stateNums.has(t.to)) throw new Error(`transitions[${i}]: unknown state #${t.to}`);
  }
  if (strictScenarios) {
    for (const sc of doc.scenarios ?? []) {
      for (const n of sc.path) {
        if (!stateNums.has(n)) throw new Error(`scenario "${sc.id}".path: unknown state #${n}`);
      }
    }
  }

  return doc;
}

export function collectEdges(doc: FlowDoc): Edge[] {
  const out: Edge[] = [];
  for (const s of doc.screens ?? []) {
    for (const target of s.navTo ?? []) out.push({ from: s.id, to: target, kind: "nav" });
  }
  for (const e of doc.edges ?? []) out.push(e);
  return out;
}
