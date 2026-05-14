import { z } from "zod";

const ScreenKindSchema = z.enum([
  "screen",
  "modal",
  "tab",
  "drawer",
  "external",
  "email",
  "web",
  "out-of-band",
]);

const StepKindSchema = z.enum([
  "tap",
  "swipe",
  "fill",
  "submit",
  "open",
  "receive",
  "view",
  "manual",
  "wait",
  "decision",
]);

const RoleSchema = z.object({
  id: z.string().regex(/^[a-z0-9_-]+$/i),
  name: z.string(),
  icon: z.string().optional(),
  color: z.string().optional(),
  description: z.string().optional(),
});

const ScreenSchema = z.object({
  id: z.string().regex(/^[a-z0-9_:-]+$/i, "id may contain letters, digits, _, -, :"),
  name: z.string(),
  kind: ScreenKindSchema.default("screen"),
  path: z.string().optional(),
  description: z.string().optional(),
});

const ServerCallSchema = z.object({
  label: z.string(),
  note: z.string().optional(),
  returns: z.string().optional(),
});

const StepSchema = z.object({
  actor: z.string(),
  on: z.string(),
  action: z.string(),
  to: z.string().optional(),
  kind: StepKindSchema.optional(),
  server: ServerCallSchema.optional(),
  note: z.string().optional(),
});

const JourneySchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().optional(),
  primaryActor: z.string(),
  tags: z.array(z.string()).optional(),
  steps: z.array(StepSchema).min(1),
});

export const FlowDocSchema = z.object({
  title: z.string().default("User journeys"),
  subtitle: z.string().optional(),
  roles: z.array(RoleSchema).min(1),
  screens: z.array(ScreenSchema).min(1),
  journeys: z.array(JourneySchema).min(1),
});

export type FlowDoc = z.infer<typeof FlowDocSchema>;
export type Role = z.infer<typeof RoleSchema>;
export type Screen = z.infer<typeof ScreenSchema>;
export type Step = z.infer<typeof StepSchema>;
export type Journey = z.infer<typeof JourneySchema>;
export type ServerCall = z.infer<typeof ServerCallSchema>;

export function validateFlowDoc(raw: unknown): FlowDoc {
  const doc = FlowDocSchema.parse(raw);
  const roleIds = new Set(doc.roles.map((r) => r.id));
  const screenIds = new Set(doc.screens.map((s) => s.id));

  for (const j of doc.journeys) {
    if (!roleIds.has(j.primaryActor)) {
      throw new Error(`Journey "${j.id}": unknown primaryActor "${j.primaryActor}"`);
    }
    for (const [i, step] of j.steps.entries()) {
      if (!roleIds.has(step.actor)) {
        throw new Error(
          `Journey "${j.id}" step ${i + 1}: unknown actor "${step.actor}"`
        );
      }
      if (!screenIds.has(step.on)) {
        throw new Error(
          `Journey "${j.id}" step ${i + 1}: unknown screen "${step.on}"`
        );
      }
      if (step.to && !screenIds.has(step.to)) {
        throw new Error(
          `Journey "${j.id}" step ${i + 1}: unknown screen "${step.to}"`
        );
      }
    }
  }
  return doc;
}
