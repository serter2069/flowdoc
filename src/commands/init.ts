import { existsSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const TEMPLATE = {
  title: "My App",
  subtitle: "Workflows between packages and components",
  packages: [
    {
      id: "app",
      name: "Mobile App",
      kind: "client",
      icon: "📱",
      tech: ["Expo", "React Native", "TypeScript"],
      path: "app/",
      description: "Expo SDK app shipping to iOS, Android, and web.",
    },
    {
      id: "api",
      name: "API",
      kind: "server",
      icon: "🌐",
      tech: ["Node", "Express"],
      path: "api/",
    },
    {
      id: "db",
      name: "Database",
      kind: "database",
      icon: "🗄️",
      tech: ["PostgreSQL"],
    },
    {
      id: "mail",
      name: "Mail",
      kind: "external",
      icon: "✉️",
    },
  ],
  flows: [
    {
      id: "invite-user",
      name: "Invite new user",
      description: "Admin invites a teammate; magic-link email bootstraps the account.",
      tags: ["onboarding", "auth"],
      steps: [
        {
          from: "app",
          to: "api",
          kind: "http",
          label: "POST /invites",
          payload: { email: "string", role: "worker | admin" },
          note: "Triggered from Settings → Team → Invite.",
        },
        {
          from: "api",
          to: "db",
          kind: "db",
          label: "INSERT INTO invites",
          payload: "Invite{ token, email, role, expires_at }",
        },
        {
          from: "api",
          to: "mail",
          kind: "event",
          label: "send invitation email",
          note: "Signed link → /accept-invite?t=...",
        },
        {
          from: "api",
          to: "app",
          kind: "http",
          label: "201 Created",
          payload: { inviteId: "uuid" },
          note: "Mobile shows a success toast.",
        },
      ],
    },
  ],
};

export function initCommand(opts: { out: string; force: boolean }) {
  const out = resolve(process.cwd(), opts.out);
  if (existsSync(out) && !opts.force) {
    console.error(
      `Refusing to overwrite ${opts.out}. Pass --force to overwrite, or pick a different path with -o.`
    );
    process.exit(1);
  }
  writeFileSync(out, JSON.stringify(TEMPLATE, null, 2) + "\n", "utf8");
  console.log(`✓ wrote ${opts.out}`);
  console.log(`  Next: edit ${opts.out}, then run "flowdoc build ${opts.out}".`);
}
