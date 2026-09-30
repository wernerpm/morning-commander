import { createRoot } from "solid-js";
import { describe, expect, it } from "vitest";
import { createPanel } from "./store";

const tick = (ms = 60) => new Promise((r) => setTimeout(r, ms));

function withPanel(fn: (p: ReturnType<typeof createPanel>) => Promise<void>) {
  return new Promise<void>((resolve, reject) =>
    createRoot(async (dispose) => {
      try {
        localStorage.clear();
        await fn(createPanel(0));
        resolve();
      } catch (e) {
        reject(e);
      } finally {
        dispose();
      }
    }),
  );
}

const names = (p: ReturnType<typeof createPanel>) => p.rows().map((e) => e.name);

describe("panel store (mock backend)", () => {
  it("opens a directory with a parent row, dirs first, hidden files filtered", () =>
    withPanel(async (p) => {
      await p.open("/Users/demo");
      expect(p.path()).toBe("/Users/demo");
      const n = names(p);
      expect(n[0]).toBe("..");
      expect(n.slice(1, 7)).toEqual(["Documents", "Downloads", "Many", "Music", "Pictures", "alpha.txt"]);
      expect(n).not.toContain(".zshrc");
      p.toggleHidden();
      expect(names(p)).toContain(".zshrc");
    }));

  it("puts the cursor on the directory we came from when going up", () =>
    withPanel(async (p) => {
      await p.open("/Users/demo/Pictures");
      p.goParent();
      await tick();
      expect(p.current()?.name).toBe("Pictures");
    }));

  it("applies external changes and keeps the cursor on the same file", () =>
    withPanel(async (p) => {
      await p.open("/Users/demo");
      p.focusName("readme.txt");
      const mock = (window as unknown as { __mock: { touch(p: string): void; remove(p: string): void } }).__mock;
      mock.touch("/Users/demo/aaa.txt");
      await tick();
      expect(names(p)).toContain("aaa.txt");
      expect(p.current()?.name).toBe("readme.txt");
      mock.remove("/Users/demo/readme.txt");
      await tick();
      expect(names(p)).not.toContain("readme.txt");
      expect(p.current()).toBeDefined();
    }));

  it("toggles selection and reports targets", () =>
    withPanel(async (p) => {
      await p.open("/Users/demo/Documents");
      p.focusName("notes.md");
      expect(p.targets().map((e) => e.name)).toEqual(["notes.md"]);
      p.toggleSelect("budget.csv");
      p.toggleSelect("report.pdf");
      expect(p.targets().map((e) => e.name)).toEqual(["budget.csv", "report.pdf"]);
    }));
});
