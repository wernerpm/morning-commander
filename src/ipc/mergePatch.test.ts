import { describe, expect, it } from "vitest";
import { mergePatch } from "./mergePatch";

describe("mergePatch (RFC 7386)", () => {
  // Examples from RFC 7386 appendix A.
  const cases: [unknown, unknown, unknown][] = [
    [{ a: "b" }, { a: "c" }, { a: "c" }],
    [{ a: "b" }, { b: "c" }, { a: "b", b: "c" }],
    [{ a: "b" }, { a: null }, {}],
    [{ a: "b", b: "c" }, { a: null }, { b: "c" }],
    [{ a: ["b"] }, { a: "c" }, { a: "c" }],
    [{ a: "c" }, { a: ["b"] }, { a: ["b"] }],
    [{ a: { b: "c" } }, { a: { b: "d", c: null } }, { a: { b: "d" } }],
    [{ a: [{ b: "c" }] }, { a: [1] }, { a: [1] }],
    [["a", "b"], ["c", "d"], ["c", "d"]],
    [{ a: "b" }, ["c"], ["c"]],
    [{ a: "foo" }, null, null],
    [{ a: "foo" }, "bar", "bar"],
    [{ e: null }, { a: 1 }, { e: null, a: 1 }],
    [[1, 2], { a: "b", c: null }, { a: "b" }],
    [{}, { a: { bb: { ccc: null } } }, { a: { bb: {} } }],
  ];

  it.each(cases)("%j + %j", (target, patch, expected) => {
    expect(mergePatch(target, patch)).toEqual(expected);
  });

  it("merges one panel without touching the other", () => {
    const state = { panels: { "0": { path: "/a" }, "1": { path: "/b" } }, x: 1 };
    expect(mergePatch(state, { panels: { "1": { path: "/c" } } })).toEqual({
      panels: { "0": { path: "/a" }, "1": { path: "/c" } },
      x: 1,
    });
  });

  it("does not modify or alias its inputs", () => {
    const target = { a: { b: 1 } };
    const patch = { a: { c: [1] } };
    const out = mergePatch<{ a: { c: number[] } }>(target, patch);
    out.a.c.push(2);
    expect(target).toEqual({ a: { b: 1 } });
    expect(patch).toEqual({ a: { c: [1] } });
  });
});
