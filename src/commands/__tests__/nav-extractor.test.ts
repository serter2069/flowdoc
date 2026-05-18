import { describe, it, expect } from "vitest";
import { extractNavTargets } from "../scan-expo-router.js";

describe("extractNavTargets", () => {
  it("router.push with plain string", () => {
    const src = `router.push("/profile/123")`;
    expect([...extractNavTargets(src)]).toEqual(["/profile/123"]);
  });

  it("router.replace + router.navigate", () => {
    const src = `router.replace("/home"); router.navigate("/x")`;
    expect([...extractNavTargets(src)].sort()).toEqual(["/home", "/x"]);
  });

  it("router.push with template literal — ${var} normalized to :id", () => {
    const src = "router.push(`/profile/${userId}`)";
    expect([...extractNavTargets(src)]).toEqual(["/profile/:id"]);
  });

  it("router.push with TS-cast", () => {
    const src = `router.push("/admin" as never)`;
    expect([...extractNavTargets(src)]).toEqual(["/admin"]);
  });

  it("router.push with object pathname", () => {
    const src = `router.push({ pathname: "/listing/[id]", params: {} })`;
    expect([...extractNavTargets(src)]).toEqual(["/listing/:id"]);
  });

  it("<Link href=...> plain string", () => {
    const src = `<Link href="/login">Sign in</Link>`;
    expect([...extractNavTargets(src)]).toEqual(["/login"]);
  });

  it("<Link href={`...`}> template literal", () => {
    const src = "<Link href={`/specialist/${id}`}>view</Link>";
    expect([...extractNavTargets(src)]).toEqual(["/specialist/:id"]);
  });

  it("<Link href={\"...\" as never}> cast form", () => {
    const src = `<Link href={"/login" as never}>sign in</Link>`;
    expect([...extractNavTargets(src)]).toEqual(["/login"]);
  });

  it("<Redirect href=...> plain", () => {
    const src = `return <Redirect href="/requests/new"/>;`;
    expect([...extractNavTargets(src)]).toEqual(["/requests/new"]);
  });

  it("<Redirect href={\"...\" as never}> cast", () => {
    // p2ptax's (tabs)/create.tsx does this exact pattern.
    const src = `return <Redirect href={"/requests/new" as never} />;`;
    expect([...extractNavTargets(src)]).toEqual(["/requests/new"]);
  });

  it("<Redirect href={`...`}> template literal", () => {
    const src = "<Redirect href={`/threads/${id}`}/>";
    expect([...extractNavTargets(src)]).toEqual(["/threads/:id"]);
  });

  it("normalizes [id] segments to :id", () => {
    const src = `router.push("/specialists/[id]")`;
    expect([...extractNavTargets(src)]).toEqual(["/specialists/:id"]);
  });

  it("strips query string and hash", () => {
    const src = `router.push("/fns?cityId=10#section")`;
    expect([...extractNavTargets(src)]).toEqual(["/fns"]);
  });

  it("dedupes identical targets", () => {
    const src = `router.push("/x"); router.push("/x"); <Link href="/x"/>;`;
    expect([...extractNavTargets(src)]).toEqual(["/x"]);
  });

  it("non-literal target (variable) is silently skipped — we can't resolve it", () => {
    const src = `router.push(target);`;
    expect([...extractNavTargets(src)]).toEqual([]);
  });
});
