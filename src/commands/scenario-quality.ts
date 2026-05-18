import type { State, Transition } from "../schema.js";

// Pseudo-roles that aren't real user roles — used as state-kind markers only.
export const NON_USER_ROLES = new Set(["any", "anon", "api", "system", "backend"]);

/**
 * Role of a scenario = role of its TERMINAL node, since that's the actor whose
 * task the scenario tests. "anon" only when the entire path stays in anon-role
 * states (login flow, public landing, terms page).
 *
 * Walks backward from terminal — first user-role found wins. So a scenario
 * ending on a kind:api state inherits the role from the previous user-facing
 * state.
 */
export function inferScenarioRole(path: number[], stateByNum: Map<number, State>): string {
  for (let i = path.length - 1; i >= 0; i--) {
    for (const r of stateByNum.get(path[i])?.roles ?? []) {
      if (!NON_USER_ROLES.has(r)) return r;
    }
  }
  const passesThroughLogin = path.some((n) => {
    const s = stateByNum.get(n);
    return s && (s.roles ?? []).includes("anon") && /login|signin/i.test(s.title);
  });
  return passesThroughLogin ? "any" : "anon";
}

/**
 * A scenario's role implies the actor must be allowed at every step. Drop
 * scenarios whose path crosses a state explicitly tagged with an incompatible
 * user-role. "any"/"anon"/"api"/"system" never block — they're transit nodes.
 */
export function pathHasRoleConflict(
  path: number[],
  scenarioRole: string,
  stateByNum: Map<number, State>,
): boolean {
  if (NON_USER_ROLES.has(scenarioRole)) return false;
  for (const n of path) {
    const roles = stateByNum.get(n)?.roles ?? [];
    if (roles.length === 0) continue;
    const userRoles = roles.filter((r) => !NON_USER_ROLES.has(r));
    if (userRoles.length === 0) continue;
    if (!userRoles.includes(scenarioRole)) return true;
  }
  return false;
}

const TERMINAL_KINDS_QA = new Set(["success", "email", "push", "db", "webhook"]);

/**
 * Length-2 path from an entry to a plain page is a trivial sitemap entry, not
 * a journey:
 *   - terminal is kind:page (not success/email/push/db/webhook),
 *   - terminal has no `actions[]`,
 *   - the single edge is synthetic (visit / tab-bar / login-as / enter-as).
 */
export function isTrivialSitemapPath(
  path: number[],
  stateByNum: Map<number, State>,
  transitions: Transition[],
): boolean {
  if (path.length !== 2) return false;
  const term = stateByNum.get(path[1]);
  if (!term) return false;
  if (TERMINAL_KINDS_QA.has(term.kind ?? "state")) return false;
  if ((term.actions?.length ?? 0) > 0) return false;
  const edge = transitions.find((t) => t.from === path[0] && t.to === path[1]);
  const label = edge?.label ?? "";
  return /^(visit |tab-bar |login as |enter as )/.test(label);
}

/**
 * Find role-home states: targets of synthetic "login as <role>" or
 * "enter as <role>" edges, OR single-user-role states with no real incoming.
 * Returns map of stateNum → role.
 */
export function findRoleHomes(states: State[], transitions: Transition[]): Map<number, string> {
  const homes = new Map<number, string>();
  for (const t of transitions) {
    const label = t.label ?? "";
    const m = /^(?:login as|enter as) (\w+)/.exec(label);
    if (m && !homes.has(t.to)) homes.set(t.to, m[1]);
  }
  const incomingNums = new Set(transitions.map((t) => t.to));
  for (const s of states) {
    if (homes.has(s.num)) continue;
    const userRoles = (s.roles ?? []).filter((r) => !NON_USER_ROLES.has(r));
    if (userRoles.length !== 1) continue;
    if (incomingNums.has(s.num)) continue;
    homes.set(s.num, userRoles[0]);
  }
  return homes;
}
