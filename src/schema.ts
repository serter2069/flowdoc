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

export const FlowDocSchema = z.object({
  title: z.string().default("Sitemap"),
  subtitle: z.string().optional(),
  roles: z.array(RoleSchema).optional(),
  groups: z.array(GroupSchema).optional(),
  screens: z.array(ScreenSchema).min(1),
  edges: z.array(EdgeSchema).optional(),
});

export type FlowDoc = z.infer<typeof FlowDocSchema>;
export type Role = z.infer<typeof RoleSchema>;
export type Screen = z.infer<typeof ScreenSchema>;
export type Edge = z.infer<typeof EdgeSchema>;
export type Group = z.infer<typeof GroupSchema>;
export type ScreenKind = z.infer<typeof ScreenKindSchema>;
export type EdgeKind = z.infer<typeof EdgeKindSchema>;

export function validateFlowDoc(raw: unknown): FlowDoc {
  const doc = FlowDocSchema.parse(raw);
  const screenIds = new Set(doc.screens.map((s) => s.id));
  const groupIds = new Set((doc.groups ?? []).map((g) => g.id));
  const roleIds = new Set((doc.roles ?? []).map((r) => r.id));

  for (const s of doc.screens) {
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
    if (!screenIds.has(e.from)) {
      throw new Error(`edges[${i}]: unknown screen "${e.from}"`);
    }
    if (!screenIds.has(e.to)) {
      throw new Error(`edges[${i}]: unknown screen "${e.to}"`);
    }
  }
  return doc;
}

/** Get all edges, both from screen.navTo and from explicit edges[]. */
export function collectEdges(doc: FlowDoc): Edge[] {
  const out: Edge[] = [];
  for (const s of doc.screens) {
    for (const target of s.navTo ?? []) {
      out.push({ from: s.id, to: target, kind: "nav" });
    }
  }
  for (const e of doc.edges ?? []) {
    out.push(e);
  }
  return out;
}
