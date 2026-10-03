import { createRoot } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resetSettings } from "../app/settings";
import { backend } from "../ipc";
import { createPanel } from "./store";

const tick = (ms = 60) => new Promise((r) => setTimeout(r, ms));

interface Mock {
  touch(p: string, size?: number): void;
  remove(p: string): void;
  setNetwork(prefix: string | null): void;
  clearCache(): void;
  resetSettings(): void;
  revalidateMs: number;
  state: { panels?: Record<string, { path: string; showHidden: boolean }> };
}
const mock = () => (window as unknown as { __mock: Mock }).__mock;

function withPanel(fn: (p: ReturnType<typeof createPanel>) => Promise<void>) {
  return new Promise<void>((resolve, reject) =>
    createRoot(async (dispose) => {
      try {
        resetSettings();
        mock().resetSettings();
        mock().setNetwork(null);
        mock().clearCache();
        mock().revalidateMs = 30;
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

afterEach(() => vi.restoreAllMocks());

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
      mock().touch("/Users/demo/aaa.txt");
      await tick();
      expect(names(p)).toContain("aaa.txt");
      expect(p.current()?.name).toBe("readme.txt");
      mock().remove("/Users/demo/readme.txt");
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

  it("filters by any part of the name and ends with the cursor kept", () =>
    withPanel(async (p) => {
      await p.open("/Users/demo");
      p.setFilter("");
      expect(names(p)[0]).toBe(".."); // empty filter shows everything
      p.setFilter("port");
      expect(names(p)).toEqual(["Report 2.pdf", "report 10.pdf"]);
      p.setFilter("eta");
      expect(names(p)).toEqual(["Beta.txt", "zeta.txt"]);
      p.move(1);
      expect(p.current()?.name).toBe("zeta.txt");
      p.selectAll(true);
      expect([...p.selected()]).toEqual(["Beta.txt", "zeta.txt"]); // only the matches
      p.clearFilter();
      expect(p.filter()).toBeNull();
      expect(names(p)).toContain("Documents");
      expect(p.current()?.name).toBe("zeta.txt");
    }));

  it("opening a file ends the filter with the file focused; a directory clears it on arrival", () =>
    withPanel(async (p) => {
      await p.open("/Users/demo");
      p.setFilter("zet");
      expect(p.enter().file?.name).toBe("zeta.txt");
      expect(p.filter()).toBeNull();
      expect(p.current()?.name).toBe("zeta.txt");
      p.setFilter("pict");
      p.enter();
      await tick();
      expect(p.path()).toBe("/Users/demo/Pictures");
      expect(p.filter()).toBeNull();
    }));

  it("external changes respect the filter", () =>
    withPanel(async (p) => {
      await p.open("/Users/demo");
      p.setFilter("txt");
      mock().touch("/Users/demo/new.txt");
      mock().touch("/Users/demo/new.md");
      await tick();
      expect(names(p)).toContain("new.txt");
      expect(names(p)).not.toContain("new.md");
    }));

  it("persists path, sort and hidden flag to state", () =>
    withPanel(async (p) => {
      await p.open("/Users/demo/Music");
      p.toggleHidden();
      expect(mock().state.panels?.["0"]).toEqual({ path: "/Users/demo/Music", sort: { key: "name", desc: false }, showHidden: true });
    }));

  it("a stale snapshot of a network dir is patched, then cleared by fresh", () =>
    withPanel(async (p) => {
      mock().setNetwork("/Users/demo");
      await p.open("/Users/demo");
      expect(p.network()).toBe(true);
      expect(p.stale()).toBe(false); // not cached yet: read before the snapshot
      await p.open("/Users/demo/Documents");
      mock().touch("/Users/demo/while-away.txt"); // nobody watches /Users/demo now
      await tick();
      await p.open("/Users/demo");
      expect(p.stale()).toBe(true);
      expect(names(p)).not.toContain("while-away.txt");
      await tick();
      expect(p.stale()).toBe(false);
      expect(names(p)).toContain("while-away.txt");
    }));

  it("local dirs are not network and not stale on reopen", () =>
    withPanel(async (p) => {
      await p.open("/Users/demo");
      await p.open("/Users/demo/Documents");
      await p.open("/Users/demo");
      expect(p.network()).toBe(false);
      expect(p.stale()).toBe(false);
    }));

  it("reload passes refresh to panel_open; navigation doesn't", () =>
    withPanel(async (p) => {
      const spy = vi.spyOn(backend, "panelOpen");
      await p.open("/Users/demo");
      expect(spy.mock.lastCall?.[3]).toBe(false);
      await p.reload();
      expect(spy.mock.lastCall?.[1]).toBe("/Users/demo");
      expect(spy.mock.lastCall?.[3]).toBe(true);
      expect(p.stale()).toBe(true); // cached listing, revalidating
      await tick();
      expect(p.stale()).toBe(false);
    }));

  it("ignores fresh for a path the panel has left", () =>
    withPanel(async (p) => {
      mock().revalidateMs = 40;
      await p.open("/Users/demo");
      void p.reload();
      await tick(10);
      await p.open("/Users/demo/Documents");
      await tick();
      expect(p.path()).toBe("/Users/demo/Documents");
      expect(p.stale()).toBe(false);
    }));
});
