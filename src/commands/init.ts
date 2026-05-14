import { existsSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const TEMPLATE = {
  title: "My App",
  subtitle: "User journeys",
  roles: [
    { id: "manager", name: "Manager", icon: "🧑‍💼", color: "#7aa2ff" },
    { id: "worker", name: "Worker", icon: "🛠️", color: "#22c55e" },
    { id: "customer", name: "Customer", icon: "👤", color: "#f59e0b" },
  ],
  screens: [
    { id: "home", name: "Home", kind: "tab", path: "/(tabs)/home" },
    { id: "settings", name: "Settings", kind: "screen", path: "/settings" },
    { id: "team", name: "Team", kind: "screen", path: "/settings/team" },
    { id: "team-form", name: "Add user", kind: "modal" },
    { id: "login", name: "Login", kind: "screen", path: "/login" },
    { id: "out-of-band", name: "Out-of-band", kind: "out-of-band" },
  ],
  journeys: [
    {
      id: "manager-invite",
      name: "Manager: invite + onboard a teammate",
      primaryActor: "manager",
      description:
        "Manager creates the account. API returns a temp password — manager shares it out-of-band. New user signs in and lands on Home.",
      tags: ["onboarding"],
      steps: [
        {
          actor: "manager",
          on: "home",
          to: "settings",
          action: "Tap the Settings tab",
          kind: "tap",
        },
        {
          actor: "manager",
          on: "settings",
          to: "team",
          action: "Tap 'Team'",
          kind: "tap",
        },
        {
          actor: "manager",
          on: "team",
          to: "team-form",
          action: "Tap the + button",
          kind: "tap",
        },
        {
          actor: "manager",
          on: "team-form",
          to: "team",
          action: "Fill name + email + role, tap Save",
          kind: "submit",
          server: {
            label: "POST /api/v1/users",
            returns: "{ data: User, meta: { temp_password: string } }",
          },
          note: "Toast appears: 'Temp password: ABCD-1234'. Manager copies it.",
        },
        {
          actor: "manager",
          on: "team",
          to: "out-of-band",
          action: "Share the temp password with the new user (SMS / Slack / etc.)",
          kind: "manual",
          note: "No automated invitation email exists — this hand-off is the bottleneck.",
        },
        {
          actor: "worker",
          on: "login",
          to: "home",
          action: "Open the app, enter email + temp password, tap Sign in",
          kind: "submit",
          server: { label: "POST /api/v1/auth/login", returns: "{ token, user }" },
          note: "Landing screen depends on role — Worker → My Jobs, Manager → Pulse.",
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
