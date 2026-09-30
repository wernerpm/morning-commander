// Frontend copy of preferences.json and state.json (docs/ipc.md). Loaded once
// before the app renders; changes go to Rust as merge patches.

import { createSignal } from "solid-js";
import { backend } from "../ipc";
import { mergePatch } from "../ipc/mergePatch";
import type { AppState, MergePatch, PanelState, Preferences } from "../ipc/types";

export const DEFAULT_PREFS: Preferences = {
  videoVolume: 0.8,
  cacheMaxBytes: 100 * 1024 * 1024,
  cacheMaxAgeDays: 180,
};

const [prefs, setPrefsSignal] = createSignal<Preferences>(DEFAULT_PREFS);
let state: AppState = {};

export { prefs };

export function appState(): AppState {
  return state;
}

/** Apply `patch` locally at once and persist it (Rust writes immediately). */
export async function updatePrefs(patch: MergePatch<Preferences>): Promise<void> {
  setPrefsSignal((p) => mergePatch(p, patch));
  try {
    setPrefsSignal(await backend.prefsSet(patch));
  } catch (err) {
    console.warn("saving preferences failed", err);
  }
}

/** Apply `patch` locally and send it (Rust debounces the write). */
export function updateState(patch: MergePatch<AppState>): void {
  state = mergePatch(state, patch);
  backend.stateSet(patch).catch((err) => console.warn("saving state failed", err));
}

const LEGACY_KEYS = ["mc.panel.0", "mc.panel.1", "mc.bookmarks"] as const;

/**
 * Patches that import the pre-files localStorage data without overwriting
 * values already in the files. `stored` maps legacy keys to their raw values.
 */
export function migrationPatches(
  current: { prefs: Preferences; state: AppState },
  stored: Partial<Record<(typeof LEGACY_KEYS)[number], string | null>>,
): { prefs: MergePatch<Preferences> | null; state: MergePatch<AppState> } {
  const parse = (raw: string | null | undefined): unknown => {
    try {
      return raw ? JSON.parse(raw) : undefined;
    } catch {
      return undefined;
    }
  };
  const statePatch: MergePatch<AppState> = { localStorageMigrated: true };
  const panels: Record<string, PanelState> = {};
  for (const id of ["0", "1"] as const) {
    const p = parse(stored[`mc.panel.${id}`]) as PanelState | undefined;
    if (p && typeof p === "object" && !current.state.panels?.[id]) panels[id] = p;
  }
  if (Object.keys(panels).length) statePatch.panels = panels;
  const bookmarks = parse(stored["mc.bookmarks"]);
  const prefsPatch =
    Array.isArray(bookmarks) && current.prefs.bookmarks === undefined ? { bookmarks } : null;
  return { prefs: prefsPatch, state: statePatch };
}

function readLegacy(): Partial<Record<(typeof LEGACY_KEYS)[number], string | null>> {
  const out: Partial<Record<(typeof LEGACY_KEYS)[number], string | null>> = {};
  try {
    for (const k of LEGACY_KEYS) out[k] = localStorage.getItem(k);
  } catch {
    // storage unavailable: nothing to import
  }
  return out;
}

/** Load preferences and state, importing localStorage data once. Call before rendering. */
export async function loadSettings(): Promise<void> {
  try {
    const [p, s] = await Promise.all([backend.prefsGet(), backend.stateGet()]);
    setPrefsSignal(p);
    state = s;
  } catch (err) {
    console.warn("loading settings failed; using defaults", err);
    return;
  }
  if (state.localStorageMigrated) return;
  const m = migrationPatches({ prefs: prefs(), state }, readLegacy());
  if (m.prefs) await updatePrefs(m.prefs);
  updateState(m.state);
  try {
    for (const k of LEGACY_KEYS) localStorage.removeItem(k);
  } catch {
    // ignore
  }
}
