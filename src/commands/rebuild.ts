import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { enumerateCommand } from "./enumerate.js";
import { buildCommand } from "./build.js";
import { layoutCommand } from "./layout.js";

interface RebuildOpts {
  out: string;                  // HTML output path
  withRuns?: string;            // SQLite path (defaults to .flowdoc/flowdoc.db if exists)
  baselineDir: string;          // .flowdoc dir for cleanup
  maxLen: number;
  maxScenarios: number;
  publishTo?: string[];         // extra paths to cp the HTML to
  skipEnumerate: boolean;
}

export function rebuildCommand(flowsArg: string | undefined, opts: RebuildOpts) {
  const flowsPath = flowsArg ?? "flows.json";

  if (!opts.skipEnumerate) {
    console.log(`▶ reconcile scenarios`);
    enumerateCommand(flowsPath, {
      out: undefined,
      maxLen: opts.maxLen,
      maxScenarios: opts.maxScenarios,
      appendInPlace: false,
      reconcile: true,
      baselineDir: opts.baselineDir,
    });
    console.log("");
    console.log(`▶ layout (BFS tree from Anonymous root)`);
    layoutCommand(flowsPath, { colW: 460, rowH: 200 });
    console.log("");
  }

  // Auto-detect DB if user didn't specify --with-runs
  let dbPath = opts.withRuns;
  if (!dbPath) {
    const auto = resolve(process.cwd(), opts.baselineDir, "flowdoc.db");
    if (existsSync(auto)) dbPath = auto;
  }

  console.log(`▶ build HTML viewer`);
  buildCommand(flowsPath, { out: opts.out, withRuns: dbPath });

  if (opts.publishTo?.length) {
    console.log("");
    console.log(`▶ publish`);
    const srcPath = resolve(process.cwd(), opts.out);
    for (const dest of opts.publishTo) {
      const destPath = resolve(process.cwd(), dest);
      const destDir = dirname(destPath);
      if (!existsSync(destDir)) mkdirSync(destDir, { recursive: true });
      copyFileSync(srcPath, destPath);
      console.log(`  ✓ ${dest}`);
    }
  }

  console.log("");
  console.log(`✓ rebuild complete`);
}
