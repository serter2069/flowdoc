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
  "select", "scroll", "otp", "download",       // full-coverage extension
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

/* ─── Controls + params (full-coverage scanner output) ─── */

const ControlKindSchema = z.enum([
  "press",       // button / pressable
  "input",       // <TextInput> single-line
  "textarea",    // multiline input
  "select",      // <Picker>/<Select> with finite domain
  "toggle",      // <Switch>
  "slider",      // numeric range
  "scroll",      // <ScrollView>/<FlatList>
  "file",        // single-file picker (expo-document-picker, multer single)
  "files",       // multi-file picker
  "image",       // expo-image-picker
  "otp",         // OTP code field
  "submit",      // form submit button
  "link",        // navigation / openURL
]);

const ControlSchema = z.object({
  kind: ControlKindSchema,
  label: z.string(),                            // visible label / accessibility name
  domain: z.array(z.string()).optional(),       // for select: ["draft","published","rejected"]
  accept: z.string().optional(),                // for file: "application/pdf,image/*"
  multiple: z.boolean().optional(),             // multi-file picker
  required: z.boolean().optional(),
  source: z.string().optional(),                // file:line where it was found (debug)
});

const StateParamSchema = z.object({
  name: z.string(),                             // "id", "status", "slug"
  source: z.enum(["route", "query", "body", "header"]),
  type: z.string().optional(),                  // "uuid", "string", "number", "enum"
  values: z.array(z.string()).optional(),       // enumerated values if known (Zod enum, TS union)
  required: z.boolean().optional(),
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
  controls: z.array(ControlSchema).optional(),    // full-coverage: every interactive element + its finite domain
  params: z.array(StateParamSchema).optional(),   // route / query / body params (with values[] if enum'd)
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

const OptionAssignmentSchema = z.object({
  stateNum: z.number().int().positive(),
  target: z.union([
    z.object({ kind: z.literal("control"), idx: z.number().int().nonnegative() }),
    z.object({ kind: z.literal("param"), name: z.string() }),
  ]),
  option: z.string(),
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
  // Per-scenario option picks. Each entry says: "when this scenario passes through
  // state #N, set control[idx] (or param 'name') to this option". One option per
  // (state, target) per scenario — the set-cover distributes options across scenarios
  // rather than cloning a scenario per option.
  optionAssignments: z.array(OptionAssignmentSchema).optional(),
});

// ─── Handwritten scenario trees ───
// Tree describes a user-intent flow with branching. DFS expansion → unique
// runnable routes that a test agent can execute or a tester can walk through.
//
//   next      — sequential: after this step, run the contained sub-tree(s).
//               Array → all sub-trees expanded as parallel forks.
//   branches  — independent actions at this point (cartesian product). e.g.
//               at BookingDetail manager can view-location, change-customer,
//               edit-booking — and any combination of these in one session.
//   variants  — variants of ONE action (pick-one, mutually exclusive). e.g.
//               "add 1 product" / "add 3 products" / "add many".
//   leaf      — end of branch; routes terminate here.
//   expect    — what assertion the test runner should verify.
//   stateRef  — state.num this step lives on (canvas highlights it).
//   action    — "kind:target" form, refers to State.actions[] entry.
//   as        — actor's role for THIS step (overrides scenario.role). Use for
//               security trees that pretend to be a different actor.
const ScenarioStepBaseSchema = z.object({
  step: z.string(),                                // human-readable description
  stateRef: z.number().int().positive().optional(),// state.num
  stateId: z.string().optional(),                  // alternative: ref by state.id
  action: z.string().optional(),                   // "kind:target" e.g. "submit:post"
  expect: z.string().optional(),
  as: z.string().optional(),                       // role override for this step
  leaf: z.boolean().optional(),
});
export type ScenarioStep = {
  step: string;
  stateRef?: number;
  stateId?: string;
  action?: string;
  expect?: string;
  as?: string;
  leaf?: boolean;
  next?: ScenarioStep | ScenarioStep[];
  branches?: Record<string, ScenarioStep>;
  variants?: ScenarioStep[];
};
const ScenarioStepSchema: z.ZodType<ScenarioStep> = z.lazy(() =>
  ScenarioStepBaseSchema.extend({
    next: z.union([ScenarioStepSchema, z.array(ScenarioStepSchema)]).optional(),
    branches: z.record(z.string(), ScenarioStepSchema).optional(),
    variants: z.array(ScenarioStepSchema).optional(),
  })
) as z.ZodType<ScenarioStep>;

const ScenarioTreeSchema = z.object({
  id: z.string(),
  title: z.string(),
  role: z.string().optional(),
  kind: z.enum(["happy", "edge", "security", "regression"]).default("happy"),
  description: z.string().optional(),
  tags: z.array(z.string()).optional(),
  tree: ScenarioStepSchema,
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
  scenarioTrees: z.array(ScenarioTreeSchema).optional(),    // handwritten intent trees
  // Per-route × per-platform test results, embedded at build time from
  // .flowdoc/flowdoc.db. Viewer renders badges + tooltip.
  routeStatus: z.array(z.object({
    routeId: z.string(),
    summary: z.enum(["pass", "fail", "blocked", "partial", "pending"]),
    perPlatform: z.array(z.object({
      platform: z.string(),
      status: z.enum(["pass", "fail", "blocked"]).nullable(),
      notes: z.string().optional(),
      completedAt: z.string().optional(),
    })),
  })).optional(),

  edges: z.array(EdgeSchema).optional(),
}).refine((d) => (d.screens && d.screens.length) || (d.states && d.states.length), {
  message: "flows.json must have at least one of: screens[] (legacy) or states[] (state-canvas).",
});

export type ScenarioTree = z.infer<typeof ScenarioTreeSchema>;

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
export type Control = z.infer<typeof ControlSchema>;
export type ControlKind = z.infer<typeof ControlKindSchema>;
export type StateParam = z.infer<typeof StateParamSchema>;
export type OptionAssignment = z.infer<typeof OptionAssignmentSchema>;

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
