import { build } from "esbuild";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

const outdir = resolve(ROOT, "dist/viewer");
await mkdir(outdir, { recursive: true });

const result = await build({
  entryPoints: [resolve(ROOT, "src/viewer/main.tsx")],
  bundle: true,
  format: "iife",
  target: "es2020",
  jsx: "automatic",
  minify: true,
  write: false,
  loader: { ".css": "text" },
  define: {
    "process.env.NODE_ENV": '"production"',
    "process.env.NEXT_RUNTIME": '"browser"',
  },
  logLevel: "info",
});

const js = result.outputFiles[0]?.text ?? "";
if (!js) throw new Error("esbuild produced no JS output");

const reactFlowCssPath = resolve(
  ROOT,
  "node_modules/@xyflow/react/dist/style.css"
);
const reactFlowCss = await readFile(reactFlowCssPath, "utf8").catch(() => "");

const appCss = await readFile(
  resolve(ROOT, "src/viewer/styles.css"),
  "utf8"
);

const htmlTemplate = await readFile(
  resolve(ROOT, "src/viewer/template.html"),
  "utf8"
);

// Use callback form for replace — string replacement interprets `$&`, `$'`,
// `` $` ``, `$<n>` as backreferences, which corrupts bundles that contain
// those substrings (e.g. minified template literals like `${x}` ending in
// backticks produce `` $` ``, which would be expanded to the prefix of the
// template, duplicating the entire HTML once per occurrence).
const html = htmlTemplate
  .replace("/* %REACT_FLOW_CSS% */", () => reactFlowCss)
  .replace("/* %APP_CSS% */", () => appCss)
  .replace("// %BUNDLE_JS%", () => js);

await writeFile(resolve(outdir, "index.html"), html, "utf8");
const sizeKB = (Buffer.byteLength(html, "utf8") / 1024).toFixed(1);
console.log(`✓ dist/viewer/index.html (${sizeKB} KB)`);
