import { describe, it, expect } from "vitest";
import {
  extractParamsFromZodFile,
  extractControlsFromExpressRouteFile,
} from "../controls-scanner.js";

describe("extractParamsFromZodFile — Zod schema introspection", () => {
  it("z.enum yields enum-typed param with values", () => {
    const src = `const Schema = z.object({ status: z.enum(["draft", "published"]) });`;
    const p = extractParamsFromZodFile(src);
    expect(p[0]).toMatchObject({ name: "status", type: "enum", values: ["draft", "published"], required: true });
  });

  it("z.union of z.literal yields enum values", () => {
    const src = `const Schema = z.object({ kind: z.union([z.literal("a"), z.literal("b"), z.literal("c")]) });`;
    const p = extractParamsFromZodFile(src);
    expect(p[0].values).toEqual(["a", "b", "c"]);
  });

  it("z.string().optional() → required=false", () => {
    const src = `const S = z.object({ name: z.string().optional() });`;
    const p = extractParamsFromZodFile(src);
    expect(p[0]).toMatchObject({ name: "name", type: "string", required: false });
  });

  it("z.number is captured with type number", () => {
    const src = `const S = z.object({ page: z.number(), limit: z.number().optional() });`;
    const p = extractParamsFromZodFile(src);
    const page = p.find(x => x.name === "page");
    expect(page).toMatchObject({ type: "number", required: true });
  });

  it("S2 regression: nested z.object doesn't break field parsing", () => {
    const src = `const S = z.object({
      kind: z.enum(["a", "b"]),
      meta: z.object({ inner: z.string() }),
      tail: z.enum(["x", "y", "z"]),
    });`;
    const p = extractParamsFromZodFile(src);
    expect(p.find(x => x.name === "kind")?.values).toEqual(["a", "b"]);
    // "tail" is AFTER the nested object — the old greedy regex would swallow it.
    expect(p.find(x => x.name === "tail")?.values).toEqual(["x", "y", "z"]);
  });

  it("z.array doesn't fool the parser", () => {
    const src = `const S = z.object({
      items: z.array(z.string()),
      status: z.enum(["ok", "err"]),
    });`;
    const p = extractParamsFromZodFile(src);
    expect(p.find(x => x.name === "status")?.values).toEqual(["ok", "err"]);
  });

  it("Zod in block comment is ignored", () => {
    const src = `/* const ghost = z.object({ phantom: z.enum(["a", "b"]) }); */ const Real = z.object({ real: z.string() });`;
    const p = extractParamsFromZodFile(src);
    expect(p.map(x => x.name)).toEqual(["real"]);
  });
});

describe("extractControlsFromExpressRouteFile — multer + file-serving", () => {
  it("multer.single('file') → file control with field name", () => {
    const src = `router.post("/upload", upload.single("avatar"), handler);`;
    const c = extractControlsFromExpressRouteFile(src);
    expect(c[0]).toMatchObject({ kind: "file", label: "avatar" });
  });

  it("multer.array('files') → files multi control", () => {
    const src = `router.post("/upload", upload.array("photos", 10), handler);`;
    const c = extractControlsFromExpressRouteFile(src);
    expect(c[0]).toMatchObject({ kind: "files", label: "photos", multiple: true });
  });

  it("multer.fields([...]) → generic multipart", () => {
    const src = `router.post("/upload", upload.fields([{ name: "a" }, { name: "b" }]), h);`;
    const c = extractControlsFromExpressRouteFile(src);
    expect(c.some(x => x.label === "multipart" && x.multiple === true)).toBe(true);
  });

  it("multer.any() → generic multipart", () => {
    const src = `router.post("/upload", upload.any(), h);`;
    const c = extractControlsFromExpressRouteFile(src);
    expect(c.some(x => x.label === "multipart")).toBe(true);
  });

  it("res.sendFile / res.download → link control", () => {
    const src = `router.get("/file/:id", (req, res) => res.sendFile(path));`;
    const c = extractControlsFromExpressRouteFile(src);
    expect(c.some(x => x.kind === "link" && x.label === "download")).toBe(true);
  });
});
