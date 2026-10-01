// Typed wrappers for the Rust commands in docs/ipc.md. Falls back to an
// in-memory mock when running outside Tauri (plain browser, Playwright).

import { Channel, convertFileSrc, invoke } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type {
  AppState,
  ConflictChoice,
  MediaStatus,
  MergePatch,
  OpEvent,
  OpKind,
  PanelEvent,
  PanelId,
  Preferences,
  TextPreview,
  VolumeInfo,
} from "./types";
import { mockBackend } from "./mock";

export const inTauri =
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

export interface Backend {
  /** `refresh` forces a full re-read even when a cached listing looks current. */
  panelOpen(panel: PanelId, path: string, onEvent: (e: PanelEvent) => void, refresh?: boolean): Promise<void>;
  homeDir(): Promise<string>;
  rename(dir: string, from: string, to: string): Promise<void>;
  mkdir(dir: string, name: string): Promise<void>;
  trash(paths: string[]): Promise<void>;
  copyMove(kind: OpKind, sources: string[], destDir: string, onEvent: (e: OpEvent) => void): Promise<number>;
  cancelOp(id: number): Promise<void>;
  resolveConflict(id: number, choice: ConflictChoice, applyToAll: boolean): Promise<void>;
  openDefault(path: string): Promise<void>;
  readText(path: string, maxBytes: number): Promise<TextPreview>;
  volumeInfo(path: string): Promise<VolumeInfo>;
  prefsGet(): Promise<Preferences>;
  prefsSet(patch: MergePatch<Preferences>): Promise<Preferences>;
  stateGet(): Promise<AppState>;
  stateSet(patch: MergePatch<AppState>): Promise<void>;
  /** Window fullscreen (the viewer fills the window, so this is viewer fullscreen). */
  setFullscreen(on: boolean): Promise<void>;
  isFullscreen(): Promise<boolean>;
  /** Make the window key and the webview first responder (after leaving fullscreen). */
  focusWindow(): Promise<void>;
  fileUrl(path: string): string;
  /** URL for video/audio: range requests with read-ahead on network volumes. */
  mediaUrl(path: string): string;
  mediaStatus(path: string): Promise<MediaStatus>;
  /** Stop read-ahead for `path` and drop its spool. */
  mediaClose(path: string): Promise<void>;
}

const tauriBackend: Backend = {
  async panelOpen(panel, path, onEvent, refresh = false) {
    const ch = new Channel<PanelEvent>();
    ch.onmessage = onEvent;
    await invoke("panel_open", { panel, path, refresh, onEvent: ch });
  },
  homeDir: () => invoke<string>("home_dir"),
  rename: (dir, from, to) => invoke("rename", { dir, from, to }),
  mkdir: (dir, name) => invoke("mkdir", { dir, name }),
  trash: (paths) => invoke("trash", { paths }),
  async copyMove(kind, sources, destDir, onEvent) {
    const ch = new Channel<OpEvent>();
    ch.onmessage = onEvent;
    return invoke<number>("copy_move", { kind, sources, destDir, onEvent: ch });
  },
  cancelOp: (id) => invoke("cancel_op", { id }),
  resolveConflict: (id, choice, applyToAll) => invoke("resolve_conflict", { id, choice, applyToAll }),
  openDefault: (path) => invoke("open_default", { path }),
  readText: (path, maxBytes) => invoke<TextPreview>("read_text", { path, maxBytes }),
  volumeInfo: (path) => invoke<VolumeInfo>("volume_info", { path }),
  prefsGet: () => invoke<Preferences>("prefs_get"),
  prefsSet: (patch) => invoke<Preferences>("prefs_set", { patch }),
  stateGet: () => invoke<AppState>("state_get"),
  stateSet: (patch) => invoke("state_set", { patch }),
  setFullscreen: (on) => getCurrentWindow().setFullscreen(on),
  isFullscreen: () => getCurrentWindow().isFullscreen(),
  async focusWindow() {
    await getCurrentWindow().setFocus();
    await getCurrentWebview().setFocus();
  },
  fileUrl: (path) => convertFileSrc(path),
  mediaUrl: (path) => convertFileSrc(path, "media"),
  mediaStatus: (path) => invoke<MediaStatus>("media_status", { path }),
  mediaClose: (path) => invoke("media_close", { path }),
};

export const backend: Backend = inTauri ? tauriBackend : mockBackend;

export function joinPath(dir: string, name: string): string {
  return dir.endsWith("/") ? dir + name : `${dir}/${name}`;
}
