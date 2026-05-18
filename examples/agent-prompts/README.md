# flowdoc agent prompts

Per-platform prompts you can hand to any LLM-driven agent (Claude Code, Cursor, OpenClaw, internal swarm) to drive `flowdoc test`-tracked QA runs.

Each prompt assumes:

- `flowdoc` CLI is in `$PATH` (or use absolute `/root/flowdoc/dist/cli.js`).
- The project's flows.json + handwritten scenarioTrees are already synced via `flowdoc test sync`.
- `$PROJECT` is the project name passed to `--project`. Defaults to the lowercase first word of `flows.json` `title` field.

## Common contract

The agent loops until `flowdoc test next` exits with code 2 (no pending cases for the filter):

1. `case=$(flowdoc test next --project $PROJECT --platform $PLATFORM)`
2. If exit code 2 — stop.
3. Parse the JSON case — `steps[]` is the sequence to execute.
4. Run the steps in order — navigate, interact, observe.
5. Decide verdict:
   - `pass`  — every step's `expect` is satisfied, no console/native errors.
   - `fail`  — at least one step diverged from `expect` or threw an error.
   - `blocked` — couldn't run (env missing, dependency down, fixture absent).
6. `flowdoc test mark <case.id> --status <pass|fail|blocked> --notes "<one-line evidence>"`
7. Loop.

**Always include in `notes`:**
- which step number failed,
- the observed vs expected,
- a screenshot path if the runner takes one (e.g. `screenshot=./shots/<id>.png`).

## Files

- [web-desktop.md](./web-desktop.md) — Playwright + Chromium, 1280×800 viewport.
- [web-mobile.md](./web-mobile.md) — Playwright + Chromium with iPhone 14 viewport + UA + touch.
- [ios.md](./ios.md) — Appium + iOS Simulator (Xcode required).
- [android.md](./android.md) — Appium + Android Emulator.
