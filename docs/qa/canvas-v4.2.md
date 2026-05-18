# QA test plan — canvas v4.2

Branch: `development` · Commits under review: `e141dae..a5aa93b` (7 commits, 5 from the original v4.2 series + 2 from this review pass plus the orval-hooks code-review commit from another session).

Scope: the **sitemap graph** (`SitemapGraph`) and the **state canvas**
(`StateCanvas`) viewer surfaces, plus the **scanner stack** (`scan-expo-router`,
`enumerate`, `jsx-actions`, `orval-hooks`) that feeds them. Coverage matrix
(`CoverageMatrix`) is out of scope here — covered separately.

## Test environment

| Knob | Value |
| --- | --- |
| Browser baseline | Chromium 138+ (Mac), Safari 17+, Firefox 130+ |
| Trackpad behavior matters | Yes — every pan/zoom case must be exercised on a real Mac trackpad |
| Sample doc — sitemap mode | `examples/pluto/flows.json` (52 screens, 99 edges, 12 groups) |
| Sample doc — state-canvas mode | a re-scan of `pluto/app/` via `flowdoc scan-expo` (≈50 states, 100+ transitions, 8+ scenarios) |
| URL | `https://serter2069.github.io/flowdoc/examples/pluto/flowdoc.html` and `https://flowchart.smartlaunchhub.com/pluto/` |
| Build | `npm run build` from branch `development` (commit `a5aa93b`) |

## Fix-coverage table

| # | Issue | Fix commit | QA case |
| --: | --- | --- | --- |
| 1 | Synthetic edges accumulate over repeated `enumerate` runs (filter only stripped `login as`) | `00cadbb` | [TC-01](#tc-01-synthetic-edge-de-duplication) |
| 2 | Synthetic / dimmed edges painted ON TOP of real edges in StateCanvas | `b352189` | [TC-02](#tc-02-edge-z-order--synthetic-under-real) |
| 3 | `f` shortcut in StateCanvas captured stale `fitToView` → fit to original positions | `5c94e0e` | [TC-03](#tc-03-f-after-dragging-cards-fits-to-current-layout) |
| 4 | StateCanvas keyboard handler didn't guard `contentEditable`; no Esc out of focused field | `5c94e0e` | [TC-04](#tc-04-keyboard-shortcuts-respect-fields--esc-blurs) |
| 5 | All-groups-collapsed → blank canvas, no explanation | `0a7001a` (SitemapGraph empty-state) | [TC-05](#tc-05-empty-state-when-all-groups-collapsed) |
| 6 | Esc in help modal didn't close it despite the shortcut being documented | `0a7001a` (App capture-phase listener) | [TC-06](#tc-06-esc-closes-the-keyboard-help-modal) |
| 7 | `orval-hooks` walked into `node_modules` / `dist` / `.turbo` / `.next` | `dc80d8d` | [TC-07](#tc-07-orval-hooks-skips-noise-dirs) |
| 8 | Dead code: `extraNavByRoute` (scan-expo) + `PLAT_SHORT` + `(s as any).fields` (StateCanvas) | `dc80d8d`, `a5aa93b` | [TC-08](#tc-08-no-regressions-from-dead-code-removal) |

## TC-01 — synthetic-edge de-duplication

**Why:** `enumerate` persists synthetic auth-gate edges back into `flows.json`
so the canvas can render them. Before the fix, only edges with label starting
`login as ` were stripped on re-run; `tab-bar (worker)`, `visit /login`,
`client lands → start booking`, `submit booking → notify ops`, and
`manager sees new booking` accumulated.

**Steps**

1. Pick any flows.json with synthetic edges (e.g. a fresh `scan-expo` output
   followed by one `enumerate --reconcile` pass).
2. `jq '.transitions | length' flows.json` — record count `N1`.
3. Run `flowdoc enumerate --reconcile` again (no source change).
4. `jq '.transitions | length' flows.json` — record count `N2`.
5. Run it a 3rd time → record `N3`.

**Pass:** `N1 == N2 == N3` (idempotent).
**Fail before this fix:** counts grew by the number of synthetic edges per
run. With 5+ roles and a Login screen, that's typically +40-60 per re-run.

**Bonus check**

```bash
jq '.transitions[].label' flows.json | sort | uniq -c | sort -rn | head
```

Should show **one** of each synthetic label (one `tab-bar (worker)`, etc.),
never two.

## TC-02 — edge z-order: synthetic under real

**Why:** SVG paints in DOM order; synthetic edges used to be last in the
array, ending up on top of real navigation even at low opacity. Active-flow
edges should win over both.

**Steps**

1. Open the StateCanvas tab for a doc with both real transitions and synthetic
   (tab-bar / login-as) edges (any of the `expo` scanned docs).
2. Find a region where a real transition CROSSES a synthetic one (e.g.
   `Login → MyAppointments` real-edge vs `Pulse → MyAppointments` tab-bar
   synthetic).
3. Visual: at the crossing, the real edge's stroke should be unbroken and
   sit ON TOP of the dimmer synthetic edge.
4. Pick any scenario from the sidebar (one click). Inspect a card on its
   path that's connected by both a scenario edge and a non-scenario real
   edge. The scenario edge (blue / colored) should be ON TOP of the gray
   real edge.

**Pass:** layering follows priority `synthetic < real < active-scenario`.
Real edges visually continuous through any crossing with synthetic ones.
**Fail:** dim synthetic strokes appear above real ones at crossings.

## TC-03 — `f` after dragging cards fits to current layout

**Why:** the keyboard handler was `useEffect(()=>{},[])` and the inner
`fitToView` closed over initial `positions`. Dragging cards updated state,
but `f` still snapped to the original layout.

**Steps**

1. Open StateCanvas. Press `f` once — confirm graph fits.
2. Drag any card 400+ px off-screen (left or right, doesn't matter).
3. Press `f` again.

**Pass:** the dragged card is included in the bounding box; the view fits
the NEW layout. Same expected behavior after `enumerate` adds new states.
**Fail before this fix:** view re-fits to the pre-drag bounding box, the
dragged card slides out of view.

## TC-04 — keyboard shortcuts respect fields + Esc blurs

**Why:** the StateCanvas key handler only checked `INPUT`/`SELECT`/`TEXTAREA`,
missing `contentEditable`. Also there was no keyboard escape from a focused
input — you had to click the canvas.

**Steps**

1. Click into the **canvas search box** (the one at the top of the StateCanvas
   toolbar). Type `f`, `+`, `0`, `-` — the input should accept those
   characters; **no zoom** should occur, **no fit-view** should fire.
2. Hit `Escape` — focus returns to the canvas (input no longer focused).
3. Press `f` — fit-view fires.
4. Bonus (when a contentEditable surface is introduced — e.g. inline
   scenario-name editor): same characters typed inside it should NOT
   trigger shortcuts.

**Pass:** shortcuts only fire outside fields. Esc blurs.
**Fail before this fix:** typing `f` inside the search ALSO triggered
fit-view; no Esc behavior.

## TC-05 — empty-state when all groups collapsed

**Why:** SitemapGraph rendered an empty canvas (just dotted background)
when every group's chevron was clicked or filters narrowed the visible
set to zero. Looked broken.

**Steps**

1. Open the sitemap graph tab on `examples/pluto/flows.json`.
2. Click every group's `▾` chevron in the sidebar until all are `▸`
   (collapsed).
3. **Expected:** a small card appears centered on the canvas titled
   "No screens visible", explaining to re-expand or clear filters,
   pointing at the `▾` chevron icon.
4. Re-expand one group. The card disappears; its screens render.

Repeat with the role-chip filter (turn ON all role chips so none stay
visible), then with the kind-chip filter.

**Pass:** the empty-state card appears whenever `visibleScreenIds.size`
is zero AND `screens.length > 0`.
**Fail before this fix:** blank canvas, no message.

## TC-06 — Esc closes the keyboard help modal

**Why:** the help dialog listed `esc — close this dialog` but had no Esc
listener.

**Steps**

1. Open any view that includes the topbar.
2. Click the `⌨ ?` button (top right) — modal opens.
3. Press `Esc` — modal closes.
4. Variation: open the modal while focus is inside an input (e.g. open
   it from the canvas-search-input state). Esc should still close the
   modal — but ONLY when not actively typing in a field.

**Pass:** Esc closes the modal. Capture-phase listener wins over
SitemapGraph's Esc → clearSelection (modal is the top concern).
**Fail before this fix:** Esc did nothing; user had to click backdrop
or ✕.

## TC-07 — orval-hooks skips noise dirs

**Why:** `walk()` recursed into every subdirectory. A repo with a stale
`node_modules` under the generated dir would blow up the file list.

**Steps**

1. Find or create a project with an orval-generated dir that happens to
   contain `node_modules` (or `dist`, `.turbo`, `.next`) — for instance:
   ```bash
   mkdir -p /tmp/orval-test/node_modules/junk /tmp/orval-test/api
   echo 'export const getFooUrl = () => `/foo`; export const useFoo = async () => {};' > /tmp/orval-test/api/foo.ts
   touch /tmp/orval-test/node_modules/junk/should-not-be-scanned.ts
   ```
2. Run a scanner that calls `scanOrvalHooks('/tmp/orval-test')`. Easiest:
   ```bash
   node -e "const {scanOrvalHooks} = require('./dist/cli.js'); console.log(scanOrvalHooks('/tmp/orval-test'))"
   ```
   (or write a small test harness)
3. Verify the resulting map only contains entries from `api/foo.ts`.

**Pass:** `node_modules`, `dist`, `.turbo`, `.next` never recursed.
**Fail before this fix:** large repos with stale `node_modules` would
add seconds of `stat()` overhead and (if any `.ts` file inside matched
the orval header regex) introduce spurious endpoints.

## TC-08 — no regressions from dead-code removal

**Why:** three dead-code patches in `dc80d8d` / `a5aa93b`. Each is
behavior-preserving; confirm nothing user-visible changed.

**Steps**

1. **`extraNavByRoute` removal (scan-expo-router):** re-run `flowdoc
   scan-expo` on the AresGun and DressIT apps. The output `flows.json`
   should be byte-identical to a pre-`dc80d8d` run (those repos didn't
   surface any cross-component nav refs, hence the dead code).
2. **`PLAT_SHORT` removal (StateCanvas):** open the canvas — platform
   dots still render correctly (compact glyph-only — they never had
   text labels in the live UI, the lookup table was vestigial).
3. **`(s as any).fields` modal removal (StateCanvas):** double-click
   any card to open the details modal. Rows shown: Path, ID, Roles,
   Description, Actions, Incoming, Outgoing, Scenarios. The "Fields:"
   row should be gone — no State in the schema ever populated it.

**Pass:** no visual diff, no scanner output diff, no console errors.

## Edge cases caught WITHOUT fixes (deferred — log only)

These were found during the review but not fixed; either too cosmetic
or too risky for an atomic commit pass.

| # | Where | Note |
| --- | --- | --- |
| E1 | `StateCanvas.tsx:113` | `toggleScenario` references `setOverlayRole` declared 430+ lines below. Works (JS hoists let-bindings into scope; only access before init throws), but ESLint normally flags it. Suggest moving the `useState` near the others. |
| E2 | `scan-expo-router.ts:58-66` | `inferRoleFromRoute` is hardcoded for AresGun/DressIT route names (`/listing`, `/seller`, `/admin/withdrawals`, etc.). Pluto / other Expo projects get `["any"]` for everything. Consider per-project config or removing role inference from the generic scanner. |
| E3 | `App.tsx:68-83` | Project switcher option list is hardcoded `pluto / aresgun / dressit`. Should be driven by a fetched index or an HTML data-attribute. |
| E4 | `enumerate.ts:51-69` | `synthesizeAuthGateTransitions` mutates the input `states` array by pushing a synthetic root. Idempotent only because the next call finds the existing root. Cleaner to return additions, not mutate. |
| E5 | `StateCanvas.tsx:709` | Double-click to open details — on a Mac trackpad in tap-to-click mode, two consecutive single-taps often register as drag-start + drag-end instead of dblclick. Worth re-evaluating after a few users complain. |

## Regression smoke test

A 60-second sanity pass anyone can run before merging:

1. `npm run build && node dist/cli.js build examples/pluto/flows.json -o /tmp/x.html`
   — completes without TS or build errors.
2. Open `/tmp/x.html` in Chromium 138+. Confirm:
   - 52 screens rendered on the sitemap graph
   - cluster outlines visible around every group
   - sidebar role chips + kind chips clickable
   - search input focuses on `/`
   - `f` fits the canvas
   - `?` opens the help modal; Esc closes it
3. Switch to the **Coverage matrix** tab — it loads without console errors
   (no runs DB shipped with the example doc, so the table is empty — that's
   expected, not a bug).
4. (If a fresh `scan-expo` output is available) Switch to the **Canvas**
   tab — confirm cards render, edges visible, dragging a card works,
   pressing `f` fits the layout *after* the drag.

Any of those failing → block merge until investigated.

## Out of scope for v4.2

- `CoverageMatrix.tsx` review — separate plan.
- `RebuildButton` end-to-end (SSE streaming, server endpoint) — covered by
  ad-hoc smoke when deploying.
- Schema migrations (legacy `screens[]` → new `states[]`) — back-compat is
  enforced by `FlowDocSchema.refine`, but a dedicated migration QA pass is
  warranted before removing `screens[]`.
