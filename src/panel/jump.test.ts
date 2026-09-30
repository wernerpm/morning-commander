import { describe, expect, it } from "vitest";
import type { Entry } from "../ipc/types";
import { emptyJump, fold, jumpBackspace, jumpKey } from "./jump";

const rows: Entry[] = ["..", "Documents", "Downloads", "readme.txt", "report.pdf", "Résumé.pdf", "sa", "sb", "ssh"].map(
  (name) => ({ name, kind: "file", targetIsDir: false, size: 0, mtime: 0, hidden: false }),
);

describe("type-to-jump", () => {
  it("jumps to the first match after the cursor", () => {
    const r = jumpKey(rows, 0, emptyJump, "d", 1000);
    expect(r.cursor).toBe(1);
    expect(r.state.buffer).toBe("d");
  });

  it("extends the prefix when typing quickly", () => {
    let r = jumpKey(rows, 0, emptyJump, "r", 1000);
    r = jumpKey(rows, r.cursor, r.state, "e", 1100);
    r = jumpKey(rows, r.cursor, r.state, "p", 1200);
    expect(rows[r.cursor].name).toBe("report.pdf");
  });

  it("cycles when the same letter is pressed again quickly", () => {
    let r = jumpKey(rows, 0, emptyJump, "d", 1000);
    expect(rows[r.cursor].name).toBe("Documents");
    r = jumpKey(rows, r.cursor, r.state, "d", 1100);
    expect(rows[r.cursor].name).toBe("Downloads");
    r = jumpKey(rows, r.cursor, r.state, "d", 1200);
    expect(rows[r.cursor].name).toBe("Documents"); // wraps
  });

  it("prefers a real double-letter prefix over cycling", () => {
    let r = jumpKey(rows, 0, emptyJump, "s", 1000);
    r = jumpKey(rows, r.cursor, r.state, "s", 1100);
    expect(rows[r.cursor].name).toBe("ssh");
  });

  it("cycles when pressed slowly", () => {
    let r = jumpKey(rows, 0, emptyJump, "d", 1000);
    r = jumpKey(rows, r.cursor, r.state, "d", 5000);
    expect(rows[r.cursor].name).toBe("Downloads");
  });

  it("matches case- and accent-insensitively", () => {
    let r = jumpKey(rows, 0, emptyJump, "r", 1000);
    r = jumpKey(rows, r.cursor, r.state, "e", 1100);
    r = jumpKey(rows, r.cursor, r.state, "s", 1200);
    expect(rows[r.cursor].name).toBe("Résumé.pdf");
    expect(fold("Ünïcode")).toBe("unicode");
  });

  it("keeps the cursor and reports a miss when nothing matches", () => {
    const r = jumpKey(rows, 3, emptyJump, "q", 1000);
    expect(r.cursor).toBe(3);
    expect(r.matched).toBe(false);
  });

  it("never matches the parent row", () => {
    const r = jumpKey(rows, 1, emptyJump, ".", 1000);
    expect(r.matched).toBe(false);
  });

  it("backspace shortens the buffer", () => {
    let r = jumpKey(rows, 0, emptyJump, "r", 1000);
    r = jumpKey(rows, r.cursor, r.state, "e", 1100);
    r = jumpKey(rows, r.cursor, r.state, "p", 1200);
    r = jumpBackspace(rows, r.cursor, r.state, 1300);
    expect(r.state.buffer).toBe("re");
    expect(rows[r.cursor].name).toBe("readme.txt");
  });
});
