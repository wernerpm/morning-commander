import { describe, expect, it } from "vitest";
import type { Entry } from "../ipc/types";
import { applyFilter, filterMatch, foldQuery } from "./filter";

const entry = (name: string): Entry => ({ name, kind: "file", targetIsDir: false, size: 0, mtime: 0, hidden: false });
const rows = ["Documents", "my report.pdf", "readme.txt", "Report 2.pdf", "Résumé.pdf", "Sunset.heic", "zeta.txt"].map(entry);
const names = (q: string) => applyFilter(rows, q).rows.map((e) => e.name);
const best = (q: string) => {
  const r = applyFilter(rows, q);
  return r.rows[r.best]?.name;
};

describe("fuzzy filter", () => {
  it("matches anywhere in the name, not only at the start", () => {
    expect(names("port")).toEqual(["my report.pdf", "Report 2.pdf"]);
    expect(names(".txt")).toEqual(["readme.txt", "zeta.txt"]);
  });

  it("matches characters in order with gaps", () => {
    expect(names("rdm")).toEqual(["readme.txt"]);
    expect(names("dcmnts")).toEqual(["Documents"]);
    expect(names("txtr")).toEqual([]);
  });

  it("ignores case and diacritics", () => {
    expect(names("RESUME")).toEqual(["Résumé.pdf"]);
    expect(names("SUN")).toEqual(["Sunset.heic"]);
  });

  it("keeps the given order and points at the best match", () => {
    // "re" is a prefix of readme/Report, mid-word elsewhere; first prefix match wins ties.
    expect(names("re")).toEqual(["my report.pdf", "readme.txt", "Report 2.pdf", "Résumé.pdf"]);
    expect(best("re")).toBe("readme.txt");
    // Word start beats mid-word, substring beats scattered.
    expect(best("rep")).toBe("Report 2.pdf");
    const score = (name: string, q: string) => filterMatch(entry(name), q)?.score ?? -Infinity;
    expect(score("xab", "ab")).toBeGreaterThan(score("a-b", "ab"));
  });

  it("reports matched positions in the original name", () => {
    expect(filterMatch(entry("Résumé.pdf"), foldQuery("sume"))?.positions).toEqual([2, 3, 4, 5]);
    expect(filterMatch(entry("readme.txt"), "rdm")?.positions).toEqual([0, 3, 4]);
    // Emoji take two UTF-16 units; positions count code points.
    expect(filterMatch(entry("🎬 clip.mp4"), "clip")?.positions).toEqual([2, 3, 4, 5]);
  });

  it("never matches the parent row", () => {
    expect(filterMatch(entry(".."), ".")).toBeNull();
  });
});
