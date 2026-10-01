import { beforeEach, describe, expect, it } from "vitest";
import type { AppState, Preferences } from "../ipc/types";
import { loadSettings, panelState, prefs, resetSettings, savePanelState, updatePrefs } from "./settings";

interface MockSettings {
  prefs: Record<string, unknown>;
  state: AppState;
  resetSettings(seed?: { prefs?: Partial<Preferences>; state?: AppState }): void;
}
const mock = () => (window as unknown as { __mock: MockSettings }).__mock;

const KEYS = ["mc.panel.0", "mc.panel.1", "mc.bookmarks"];
const docs = { path: "/Users/demo/Documents", sort: { key: "size", desc: true }, showHidden: true } as const;
const pics = { path: "/Users/demo/Pictures", sort: { key: "name", desc: false }, showHidden: false } as const;

function seedLocalStorage() {
  localStorage.setItem("mc.panel.0", JSON.stringify(docs));
  localStorage.setItem("mc.panel.1", JSON.stringify(pics));
  localStorage.setItem("mc.bookmarks", JSON.stringify([{ name: "Music", path: "/Users/demo/Music" }]));
}

beforeEach(() => {
  localStorage.clear();
  resetSettings();
  mock().resetSettings();
});

describe("settings", () => {
  it("loads defaults when nothing is stored", async () => {
    await loadSettings();
    expect(prefs().videoVolume).toBe(0.8);
    expect(prefs().bookmarks).toBeUndefined();
    expect(panelState(0)).toBeUndefined();
    expect(mock().state.localStorageMigrated).toBe(true);
  });

  it("imports localStorage into prefs/state, sets the flag and removes the keys", async () => {
    seedLocalStorage();
    await loadSettings();
    expect(mock().state.panels).toEqual({ "0": docs, "1": pics });
    expect(mock().state.localStorageMigrated).toBe(true);
    expect(mock().prefs.bookmarks).toEqual([{ name: "Music", path: "/Users/demo/Music" }]);
    expect(prefs().bookmarks).toEqual([{ name: "Music", path: "/Users/demo/Music" }]);
    expect(panelState(0)).toEqual(docs);
    for (const k of KEYS) expect(localStorage.getItem(k)).toBeNull();
  });

  it("doesn't overwrite values already in the files", async () => {
    const kept = { path: "/tmp", sort: { key: "mtime", desc: true }, showHidden: false } as const;
    const bookmarks = [{ name: "Tmp", path: "/tmp" }];
    mock().resetSettings({ prefs: { bookmarks }, state: { panels: { "0": kept } } });
    seedLocalStorage();
    await loadSettings();
    expect(mock().state.panels).toEqual({ "0": kept, "1": pics });
    expect(mock().prefs.bookmarks).toEqual(bookmarks);
    for (const k of KEYS) expect(localStorage.getItem(k)).toBeNull();
  });

  it("skips malformed values", async () => {
    localStorage.setItem("mc.panel.0", "{not json");
    localStorage.setItem("mc.panel.1", JSON.stringify({ sort: "name" }));
    localStorage.setItem("mc.bookmarks", JSON.stringify([{ name: "no path" }, { name: "Ok", path: "/tmp" }, 3]));
    await loadSettings();
    expect(mock().state.panels).toBeUndefined();
    expect(mock().prefs.bookmarks).toEqual([{ name: "Ok", path: "/tmp" }]);
    expect(mock().state.localStorageMigrated).toBe(true);
    for (const k of KEYS) expect(localStorage.getItem(k)).toBeNull();
  });

  it("migrates only once", async () => {
    await loadSettings();
    seedLocalStorage();
    resetSettings();
    await loadSettings();
    expect(mock().state.panels).toBeUndefined();
    expect(mock().prefs.bookmarks).toBeUndefined();
    expect(localStorage.getItem("mc.panel.0")).not.toBeNull();
  });

  it("saves panel state as a merge patch and prefs immediately", async () => {
    await loadSettings();
    savePanelState(1, pics);
    savePanelState(0, docs);
    expect(mock().state.panels).toEqual({ "0": docs, "1": pics });
    await updatePrefs({ bookmarks: [{ name: "Tmp", path: "/tmp" }] });
    expect(mock().prefs.bookmarks).toEqual([{ name: "Tmp", path: "/tmp" }]);
    expect(prefs().cacheMaxAgeDays).toBe(180);
  });
});
