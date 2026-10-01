// Preferences (preferences.json) and session state (state.json), both owned
// by Rust. Loaded once before the app renders; changes are sent as JSON merge
// patches (docs/ipc.md "Preferences and state").

import { createSignal } from "solid-js";
import { backend } from "../ipc";
import { mergePatch } from "../ipc/mergePatch";
import type { AppState, Bookmark, MergePatch, PanelId, PanelState, Preferences, SortKey } from "../ipc/types";

const DEFAULT_PREFS: Preferences = { videoVolume: 0.8, cacheMaxBytes: 104_857_600, cacheMaxAgeDays: 180 };

const [prefs, setPrefs] = createSignal<Preferences>(DEFAULT_PREFS);
let state: AppState = {};

export { prefs };

/** Load prefs and state, then import pre-files localStorage data once. Never throws. */
export async function loadSettings(): Promise<void> {
  try {
    const [p, s] = await Promise.all([backend.prefsGet(), backend.stateGet()]);
    setPrefs(p);
    state = s ?? {};
  } catch (err) {
    console.error("loading settings failed", err);
    return;
  }
  if (state.localStorageMigrated !== true) {
    try {
      await migrateLocalStorage();
    } catch (err) {
      console.error("localStorage migration failed", err);
    }
  }
}

export async function updatePrefs(patch: MergePatch<Preferences>): Promise<void> {
  setPrefs((p) => mergePatch<Preferences>(p, patch)); // optimistic
  try {
    setPrefs(await backend.prefsSet(patch));
  } catch (err) {
    console.error("saving preferences failed", err);
  }
}

export function panelState(id: PanelId): PanelState | undefined {
  return state.panels?.[`${id}`];
}

/** Remember a panel's path/sort/hidden flag. Rust debounces the write. */
export function savePanelState(id: PanelId, st: PanelState): void {
  if (JSON.stringify(panelState(id)) === JSON.stringify(st)) return;
  setState({ panels: { [`${id}`]: st } });
}

function setState(patch: MergePatch<AppState>) {
  state = mergePatch<AppState>(state, patch);
  backend.stateSet(patch).catch((err) => console.error("saving state failed", err));
}

/** Test hook: forget everything loaded. */
export function resetSettings(): void {
  setPrefs(DEFAULT_PREFS);
  state = {};
}

// --- one-time import from localStorage -------------------------------------

const LS_PANEL = (id: PanelId) => `mc.panel.${id}`;
const LS_BOOKMARKS = "mc.bookmarks";
const SORT_KEYS: SortKey[] = ["name", "ext", "size", "mtime", "none"];

function readJson(key: string): unknown {
  try {
    const raw = localStorage.getItem(key);
    return raw == null ? undefined : JSON.parse(raw);
  } catch {
    return undefined;
  }
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function toPanelState(v: unknown): PanelState | undefined {
  if (!isObj(v) || typeof v.path !== "string" || !v.path) return undefined;
  const s = v.sort;
  const sort =
    isObj(s) && SORT_KEYS.includes(s.key as SortKey) && typeof s.desc === "boolean"
      ? { key: s.key as SortKey, desc: s.desc }
      : { key: "name" as SortKey, desc: false };
  return { path: v.path, sort, showHidden: v.showHidden === true };
}

function toBookmarks(v: unknown): Bookmark[] | undefined {
  if (!Array.isArray(v)) return undefined;
  return v
    .filter((b): b is Bookmark => isObj(b) && typeof b.name === "string" && typeof b.path === "string")
    .map((b) => ({ name: b.name, path: b.path }));
}

async function migrateLocalStorage() {
  const panels: Record<string, PanelState> = {};
  for (const id of [0, 1] as const) {
    const st = toPanelState(readJson(LS_PANEL(id)));
    if (st && !panelState(id)) panels[`${id}`] = st;
  }
  const bookmarks = toBookmarks(readJson(LS_BOOKMARKS));
  // Await both writes so a failure leaves localStorage alone for the next launch.
  if (bookmarks && prefs().bookmarks === undefined) setPrefs(await backend.prefsSet({ bookmarks }));
  const patch: MergePatch<AppState> = { localStorageMigrated: true };
  if (Object.keys(panels).length) patch.panels = panels;
  await backend.stateSet(patch);
  state = mergePatch<AppState>(state, patch);
  for (const key of [LS_PANEL(0), LS_PANEL(1), LS_BOOKMARKS]) {
    try {
      localStorage.removeItem(key);
    } catch {
      // storage unavailable: nothing to remove
    }
  }
}
