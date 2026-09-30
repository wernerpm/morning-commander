import { describe, expect, it } from "vitest";
import type { Entry } from "../ipc/types";
import { comparator, extOf, insertionIndex } from "./sort";

const f = (name: string, extra: Partial<Entry> = {}): Entry => ({
  name, kind: "file", targetIsDir: false, size: 0, mtime: 0, hidden: false, ...extra,
});
const d = (name: string) => f(name, { kind: "dir" });

describe("sort", () => {
  it("puts directories first, then natural case-insensitive names", () => {
    const list = [f("report 10.pdf"), f("Beta.txt"), d("zeta"), f("report 2.pdf"), f("alpha.txt"), d("Apps")];
    const names = list.sort(comparator({ key: "name", desc: false })).map((e) => e.name);
    expect(names).toEqual(["Apps", "zeta", "alpha.txt", "Beta.txt", "report 2.pdf", "report 10.pdf"]);
  });

  it("treats symlinks to directories as directories", () => {
    const list = [f("a"), f("link", { kind: "symlink", targetIsDir: true })];
    expect(list.sort(comparator({ key: "name", desc: false }))[0].name).toBe("link");
  });

  it("sorts by size descending with directories still first", () => {
    const list = [f("small", { size: 1 }), d("dir"), f("big", { size: 100 })];
    expect(list.sort(comparator({ key: "size", desc: true })).map((e) => e.name)).toEqual(["dir", "big", "small"]);
  });

  it("finds the insertion index that keeps order", () => {
    const cmp = comparator({ key: "name", desc: false });
    const rows = [d("b"), f("a"), f("c")];
    expect(insertionIndex(rows, f("b"), cmp)).toBe(2);
    expect(insertionIndex(rows, d("a"), cmp)).toBe(0);
  });

  it("extracts extensions, ignoring dotfiles", () => {
    expect(extOf("x.TAR.gz")).toBe("gz");
    expect(extOf(".zshrc")).toBe("");
    expect(extOf("Makefile")).toBe("");
  });
});

describe("sortKey", () => {
  it("orders numbers naturally and ignores case and accents", async () => {
    const { sortKey } = await import("./sort");
    const names = ["file10", "File2", "file1", "éclair", "Eclair2", "e", "file02b", "file2a"];
    const sorted = [...names].sort((a, b) => (sortKey(a) < sortKey(b) ? -1 : sortKey(a) > sortKey(b) ? 1 : 0));
    expect(sorted).toEqual(["e", "éclair", "Eclair2", "file1", "File2", "file2a", "file02b", "file10"]);
  });
});

describe("sortEntries", () => {
  it("matches the comparator for every sort spec", async () => {
    const { sortEntries } = await import("./sort");
    let seed = 7;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
    const pieces = ["a", "B", "é", "10", "2", ".", "txt", "Z", "x1", "007"];
    const list: Entry[] = Array.from({ length: 500 }, (_, i) => ({
      name: Array.from({ length: 1 + Math.floor(rnd() * 4) }, () => pieces[Math.floor(rnd() * pieces.length)]).join("") + i,
      kind: rnd() < 0.2 ? "dir" : "file",
      targetIsDir: false,
      size: Math.floor(rnd() * 5),
      mtime: Math.floor(rnd() * 5),
      hidden: false,
    }));
    for (const key of ["name", "ext", "size", "mtime"] as const)
      for (const desc of [false, true]) {
        const spec = { key, desc };
        expect(sortEntries(list, spec).map((e) => e.name)).toEqual([...list].sort(comparator(spec)).map((e) => e.name));
      }
  });
});
