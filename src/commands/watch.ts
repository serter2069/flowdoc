import { watch as fsWatch } from "node:fs";
import { resolve } from "node:path";
import { rebuildCommand } from "./rebuild.js";

interface WatchOpts {
  out: string;
  withRuns?: string;
  baselineDir: string;
  maxLen: number;
  maxScenarios: number;
  publishTo?: string[];
  watchSource?: string[];
  debounceMs: number;
}

export function watchCommand(flowsArg: string | undefined, opts: WatchOpts) {
  const flowsPath = resolve(process.cwd(), flowsArg ?? "flows.json");
  const sourceDirs = (opts.watchSource ?? []).map((s) => resolve(process.cwd(), s));

  let pending: NodeJS.Timeout | null = null;
  let runCount = 0;

  function trigger(reason: string) {
    if (pending) clearTimeout(pending);
    pending = setTimeout(() => {
      pending = null;
      runCount++;
      const ts = new Date().toLocaleTimeString();
      console.log(`\n──────────────────────────────────────────────────`);
      console.log(`▶ run #${runCount} @ ${ts}  ·  trigger: ${reason}`);
      try {
        rebuildCommand(flowsArg, {
          out: opts.out,
          withRuns: opts.withRuns,
          baselineDir: opts.baselineDir,
          maxLen: opts.maxLen,
          maxScenarios: opts.maxScenarios,
          publishTo: opts.publishTo,
          skipEnumerate: false,
        });
      } catch (err) {
        console.error(`✗ rebuild failed: ${(err as Error).message}`);
      }
    }, opts.debounceMs);
  }

  // Watch flows.json
  fsWatch(flowsPath, { persistent: true }, (_event, filename) => {
    trigger(`flows.json (${filename ?? "change"})`);
  });

  // Watch optional source directories
  for (const dir of sourceDirs) {
    fsWatch(dir, { persistent: true, recursive: true }, (_event, filename) => {
      if (!filename) return;
      // Filter only meaningful file types: source code, routes, models, notifications
      if (!/\.(tsx?|jsx?|php|json|yaml|yml)$/.test(filename)) return;
      if (/node_modules|vendor|dist|build|\.git/.test(filename)) return;
      trigger(`source ${dir}: ${filename}`);
    });
  }

  console.log(`flowdoc watch:`);
  console.log(`  ↳ flows  ${flowsArg ?? "flows.json"}`);
  for (const dir of sourceDirs) console.log(`  ↳ source ${dir}  (recursive, .ts/.tsx/.js/.jsx/.php/.json)`);
  if (opts.publishTo?.length) for (const p of opts.publishTo) console.log(`  ⇒ publish ${p}`);
  console.log(`  ⏱ debounce ${opts.debounceMs}ms`);
  console.log(`\n(running initial rebuild now)`);
  trigger("startup");
  console.log(`\n(Ctrl+C to stop)`);
}
