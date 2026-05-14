import { existsSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const TEMPLATE = {
  title: "My App",
  subtitle: "Sitemap — every screen and how it links",
  roles: [
    { id: "admin", name: "Admin", icon: "👑", color: "#7aa2ff" },
    { id: "member", name: "Member", icon: "👤", color: "#22c55e" },
  ],
  groups: [
    { id: "workspace", name: "Workspace", color: "#7aa2ff" },
    { id: "account", name: "Account", color: "#a855f7" },
    { id: "auth", name: "Auth", color: "#ef4444" },
  ],
  screens: [
    {
      id: "home",
      name: "Home",
      kind: "tab",
      group: "workspace",
      path: "/(tabs)/home",
      roles: ["admin", "member"],
      components: ["Header", "FeedList", "FAB"],
      navTo: ["item-detail", "item-new"]
    },
    {
      id: "item-detail",
      name: "Item detail",
      kind: "screen",
      group: "workspace",
      path: "/items/:id",
      roles: ["admin", "member"],
      components: ["Header", "ItemFields", "ActionButtons"],
      navTo: ["item-edit"]
    },
    {
      id: "item-new",
      name: "New item",
      kind: "modal",
      group: "workspace",
      roles: ["admin", "member"],
      components: ["Form", "SubmitButton"]
    },
    {
      id: "item-edit",
      name: "Edit item",
      kind: "screen",
      group: "workspace",
      path: "/items/:id/edit",
      roles: ["admin", "member"],
      components: ["Form", "SubmitButton", "DeleteButton"]
    },
    {
      id: "settings",
      name: "Settings",
      kind: "tab",
      group: "account",
      path: "/(tabs)/settings",
      roles: ["admin", "member"],
      components: ["SettingsMenu"],
      navTo: ["profile", "team"]
    },
    {
      id: "profile",
      name: "Profile",
      kind: "screen",
      group: "account",
      path: "/settings/profile",
      roles: ["admin", "member"]
    },
    {
      id: "team",
      name: "Team",
      kind: "screen",
      group: "account",
      path: "/settings/team",
      roles: ["admin"],
      components: ["UserList", "AddUserFAB"],
      navTo: ["team-form"]
    },
    {
      id: "team-form",
      name: "Add user",
      kind: "modal",
      group: "account",
      roles: ["admin"],
      components: ["Form", "RoleDropdown"]
    },
    {
      id: "login",
      name: "Sign in",
      kind: "auth",
      group: "auth",
      path: "/login",
      navTo: ["home", "forgot-password"]
    },
    {
      id: "forgot-password",
      name: "Forgot password",
      kind: "auth",
      group: "auth",
      path: "/forgot-password",
      navTo: ["login"]
    }
  ]
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
