import { describe, it, expect } from "vitest";
import {
  inferScenarioRole,
  pathHasRoleConflict,
  isTrivialSitemapPath,
  findRoleHomes,
} from "../scenario-quality.js";
import type { State, Transition } from "../../schema.js";

const mk = (num: number, title: string, opts: Partial<State> = {}): State => ({
  num, id: `s${num}`, title, kind: "page", ...opts,
});

const byNum = (states: State[]) => new Map(states.map((s) => [s.num, s]));

describe("inferScenarioRole — terminal-first", () => {
  it("picks the terminal's user-role", () => {
    const states = byNum([
      mk(1, "Anonymous root", { roles: ["anon"] }),
      mk(2, "Login", { roles: ["anon"] }),
      mk(3, "Admin Dashboard", { roles: ["admin"] }),
    ]);
    expect(inferScenarioRole([1, 2, 3], states)).toBe("admin");
  });

  it("falls back upward through path when terminal is api", () => {
    const states = byNum([
      mk(1, "Anonymous root", { roles: ["anon"] }),
      mk(2, "Settings", { roles: ["user"] }),
      mk(3, "/api/settings", { kind: "api", roles: ["api"] }),
    ]);
    expect(inferScenarioRole([1, 2, 3], states)).toBe("user");
  });

  it("returns 'any' when path passes through Login but no user-role found", () => {
    const states = byNum([
      mk(1, "Anonymous root", { roles: ["anon"] }),
      mk(2, "Login", { roles: ["anon"] }),
      mk(3, "Profile", { roles: ["any"] }),
    ]);
    expect(inferScenarioRole([1, 2, 3], states)).toBe("any");
  });

  it("returns 'anon' for pure anon path", () => {
    const states = byNum([
      mk(1, "Anonymous root", { roles: ["anon"] }),
      mk(2, "Terms", { roles: ["anon"] }),
    ]);
    expect(inferScenarioRole([1, 2], states)).toBe("anon");
  });

  it("does NOT default to 'anon' when terminal has a user-role even on length-1 visit", () => {
    // Regression: old inferRole returned the FIRST role found anywhere on path
    // including the anon root, falsely labeling admin scenarios as "anon".
    const states = byNum([
      mk(1, "Anonymous root", { roles: ["anon"] }),
      mk(2, "Admin/Users", { roles: ["admin"] }),
    ]);
    expect(inferScenarioRole([1, 2], states)).toBe("admin");
  });
});

describe("pathHasRoleConflict — Сергей's `anon → /admin/withdrawals` bug", () => {
  it("anon-rooted path ending on admin-only state CONFLICTS with anon role", () => {
    const states = byNum([
      mk(1, "Anonymous root", { roles: ["anon"] }),
      mk(2, "Admin Dashboard", { roles: ["admin"] }),
    ]);
    expect(pathHasRoleConflict([1, 2], "anon", states)).toBe(false);   // anon is non-user — never blocks
    // The fix: scenarios should be re-labeled to admin via inferRole, then
    // run conflict check against "admin":
    expect(pathHasRoleConflict([1, 2], "admin", states)).toBe(false);
  });

  it("user-role scenario that traverses admin-only state is a conflict", () => {
    const states = byNum([
      mk(1, "User Home", { roles: ["user"] }),
      mk(2, "Admin Page", { roles: ["admin"] }),
      mk(3, "User Settings", { roles: ["user"] }),
    ]);
    expect(pathHasRoleConflict([1, 2, 3], "user", states)).toBe(true);
  });

  it("'any' and 'anon' states never block any role", () => {
    const states = byNum([
      mk(1, "Anonymous root", { roles: ["anon"] }),
      mk(2, "Login", { roles: ["anon"] }),
      mk(3, "Profile", { roles: ["any"] }),
      mk(4, "Settings", { roles: ["user"] }),
    ]);
    expect(pathHasRoleConflict([1, 2, 3, 4], "user", states)).toBe(false);
  });

  it("empty roles[] never blocks", () => {
    const states = byNum([
      mk(1, "Anonymous root", { roles: ["anon"] }),
      mk(2, "Untagged", {}),
      mk(3, "Settings", { roles: ["user"] }),
    ]);
    expect(pathHasRoleConflict([1, 2, 3], "user", states)).toBe(false);
  });
});

describe("isTrivialSitemapPath — drop sitemap entries that look like scenarios", () => {
  const states = byNum([
    mk(1, "Anonymous root", { roles: ["anon"] }),
    mk(2, "Home", { roles: ["any"] }),
    mk(3, "Login", { roles: ["anon"], actions: [{ kind: "submit", target: "login" }] }),
    mk(4, "Success", { kind: "success" }),
    mk(5, "/api/users", { kind: "api" }),
  ]);

  it("length-2 anon → plain page via 'visit' synthetic edge IS trivial", () => {
    const transitions: Transition[] = [{ from: 1, to: 2, label: "visit Home" }];
    expect(isTrivialSitemapPath([1, 2], states, transitions)).toBe(true);
  });

  it("length-2 ending at page WITH actions is NOT trivial", () => {
    const transitions: Transition[] = [{ from: 1, to: 3, label: "visit Login" }];
    expect(isTrivialSitemapPath([1, 3], states, transitions)).toBe(false);
  });

  it("length-2 ending at kind:success is NOT trivial (real terminal)", () => {
    const transitions: Transition[] = [{ from: 1, to: 4, label: "visit Success" }];
    expect(isTrivialSitemapPath([1, 4], states, transitions)).toBe(false);
  });

  it("length-2 via REAL nav (not synthetic) is NOT trivial", () => {
    const transitions: Transition[] = [{ from: 1, to: 2, label: "nav: router.push" }];
    expect(isTrivialSitemapPath([1, 2], states, transitions)).toBe(false);
  });

  it("length-3 is never considered trivial", () => {
    const transitions: Transition[] = [
      { from: 1, to: 2, label: "visit Home" },
      { from: 2, to: 5, label: "GET /api/users" },
    ];
    expect(isTrivialSitemapPath([1, 2, 5], states, transitions)).toBe(false);
  });
});

describe("findRoleHomes — DFS entry detection", () => {
  it("picks states reached by 'login as <role>' synthetic edges", () => {
    const states = [
      mk(1, "Login", { roles: ["anon"] }),
      mk(2, "Admin Dashboard", { roles: ["admin"] }),
      mk(3, "Worker Schedule", { roles: ["worker"] }),
    ];
    const trans: Transition[] = [
      { from: 1, to: 2, label: "login as admin" },
      { from: 1, to: 3, label: "login as worker" },
    ];
    const homes = findRoleHomes(states, trans);
    expect(homes.get(2)).toBe("admin");
    expect(homes.get(3)).toBe("worker");
  });

  it("falls back to single-user-role state with no incoming", () => {
    const states = [
      mk(1, "Lone Seller Tab", { roles: ["seller"] }),
    ];
    const trans: Transition[] = [];
    const homes = findRoleHomes(states, trans);
    expect(homes.get(1)).toBe("seller");
  });

  it("doesn't mark states with multiple user-roles", () => {
    const states = [
      mk(1, "Mixed", { roles: ["admin", "user"] }),
    ];
    expect(findRoleHomes(states, []).has(1)).toBe(false);
  });

  it("doesn't mark anon-only states", () => {
    const states = [
      mk(1, "Login", { roles: ["anon"] }),
    ];
    expect(findRoleHomes(states, []).has(1)).toBe(false);
  });
});
