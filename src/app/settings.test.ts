import { describe, expect, it } from "vitest";
import type { PanelState } from "../ipc/types";
import { DEFAULT_PREFS, migrationPatches } from "./settings";

const panel0: PanelState = { path: "/Users/demo/Documents", sort: { key: "size", desc: true }, showHidden: true };

describe("localStorage migration", () => {
  it("imports panels and bookmarks and marks the migration done", () => {
    const m = migrationPatches(
      { prefs: DEFAULT_PREFS, state: {} },
      { "mc.panel.0": JSON.stringify(panel0), "mc.panel.1": null, "mc.bookmarks": '[{"name":"Home","path":"/Users/demo"}]' },
    );
    expect(m.state).toEqual({ localStorageMigrated: true, panels: { "0": panel0 } });
    expect(m.prefs).toEqual({ bookmarks: [{ name: "Home", path: "/Users/demo" }] });
  });

  it("never overwrites values already in the files, and ignores junk", () => {
    const existing = { ...panel0, path: "/tmp" };
    const m = migrationPatches(
      { prefs: { ...DEFAULT_PREFS, bookmarks: [] }, state: { panels: { "0": existing } } },
      { "mc.panel.0": JSON.stringify(panel0), "mc.panel.1": "{not json", "mc.bookmarks": "[]" },
    );
    expect(m.state).toEqual({ localStorageMigrated: true });
    expect(m.prefs).toBeNull();
  });
});
