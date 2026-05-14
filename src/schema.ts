import { z } from "zod";

const PackageKindSchema = z.enum([
  "client",
  "server",
  "database",
  "external",
  "build",
  "queue",
  "cache",
  "storage",
  "function",
  "other",
]);

const PackageSchema = z.object({
  id: z.string().regex(/^[a-z0-9_-]+$/i, "id must be alphanumeric / dash / underscore"),
  name: z.string(),
  kind: PackageKindSchema.default("other"),
  icon: z.string().optional(),
  description: z.string().optional(),
  tech: z.array(z.string()).optional(),
  path: z.string().optional(),
  color: z.string().optional(),
});

const StepSchema = z.object({
  from: z.string(),
  to: z.string(),
  label: z.string(),
  note: z.string().optional(),
  payload: z.union([z.string(), z.record(z.string(), z.any())]).optional(),
  kind: z
    .enum(["http", "rpc", "queue", "event", "build", "manual", "db", "other"])
    .optional(),
});

const FlowSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().optional(),
  tags: z.array(z.string()).optional(),
  steps: z.array(StepSchema).min(1),
});

export const FlowDocSchema = z.object({
  title: z.string().default("Workflows"),
  subtitle: z.string().optional(),
  packages: z.array(PackageSchema).min(1),
  flows: z.array(FlowSchema).min(1),
});

export type FlowDoc = z.infer<typeof FlowDocSchema>;
export type Package = z.infer<typeof PackageSchema>;
export type Flow = z.infer<typeof FlowSchema>;
export type Step = z.infer<typeof StepSchema>;

export function validateFlowDoc(raw: unknown): FlowDoc {
  const doc = FlowDocSchema.parse(raw);
  const pkgIds = new Set(doc.packages.map((p) => p.id));
  for (const flow of doc.flows) {
    for (const [i, step] of flow.steps.entries()) {
      if (!pkgIds.has(step.from)) {
        throw new Error(
          `Flow "${flow.id}" step ${i + 1}: unknown package id "${step.from}"`
        );
      }
      if (!pkgIds.has(step.to)) {
        throw new Error(
          `Flow "${flow.id}" step ${i + 1}: unknown package id "${step.to}"`
        );
      }
    }
  }
  return doc;
}
