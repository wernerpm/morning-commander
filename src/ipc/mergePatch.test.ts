import { describe, expect, it } from "vitest";
import { mergePatch } from "./mergePatch";

describe("mergePatch (RFC 7386)", () => {
  it("merges objects recursively, deletes on null, replaces arrays and scalars", () => {
    const target = { a: "b", c: { d: "e", f: "g" }, arr: [1, 2] };
    const out = mergePatch(target, { a: "z", c: { f: null, h: 1 }, arr: [3] });
    expect(out).toEqual({ a: "z", c: { d: "e", h: 1 }, arr: [3] });
    expect(target).toEqual({ a: "b", c: { d: "e", f: "g" }, arr: [1, 2] });
  });

  it("replaces a non-object target", () => {
    expect(mergePatch({ a: 1 }, { a: { b: 2 } })).toEqual({ a: { b: 2 } });
    expect(mergePatch(undefined, { x: 1 })).toEqual({ x: 1 });
  });
});
