import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { validateFlowDoc } from "../schema.js";

function loadViewerTemplate(): string {
  const candidates = [
    resolve(__dirname, "viewer/index.html"),
    resolve(__dirname, "../dist/viewer/index.html"),
    resolve(__dirname, "../viewer/index.html"),
  ];
  for (const c of candidates) {
    try {
      return readFileSync(c, "utf8");
    } catch {
      // try next
    }
  }
  throw new Error(
    "Could not locate viewer template. Did you run `npm run build:viewer`?"
  );
}

export function renderHtml(flowsJsonPath: string): string {
  const raw = readFileSync(resolve(process.cwd(), flowsJsonPath), "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`${flowsJsonPath} is not valid JSON: ${(err as Error).message}`);
  }
  const doc = validateFlowDoc(parsed);
  const template = loadViewerTemplate();
  const inlined = JSON.stringify(doc).replace(/</g, "\\u003c");
  // Function-form replace avoids `$&` / `` $` `` / `$'` / `$<n>` being
  // interpreted as backreferences if user data ever contains those.
  return template.replace("__FLOWDOC_DATA__", () => inlined);
}

export function buildCommand(flowsArg: string, opts: { out: string }) {
  const flowsPath = flowsArg ?? "flows.json";
  const outPath = resolve(process.cwd(), opts.out);
  const html = renderHtml(flowsPath);
  writeFileSync(outPath, html, "utf8");
  const sizeKB = (html.length / 1024).toFixed(1);
  console.log(`✓ ${opts.out} (${sizeKB} KB)`);
  console.log(`  Open it in any browser — no server required.`);
}
