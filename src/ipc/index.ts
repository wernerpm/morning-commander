// Typed wrappers for the Rust commands in docs/ipc.md. Falls back to an
// in-memory mock when running outside Tauri (plain browser, Playwright).

import { Channel, convertFileSrc, invoke } from "@tauri-apps/api/core";
import type { ConflictChoice, OpEvent, OpKind, PanelEvent, PanelId, TextPreview, VolumeInfo } from "./types";
import { mockBackend } from "./mock";

export const inTauri =
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

export interface Backend {
  panelOpen(panel: PanelId, path: string, onEvent: (e: PanelEvent) => void): Promise<void>;
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
  fileUrl(path: string): string;
}

const tauriBackend: Backend = {
  async panelOpen(panel, path, onEvent) {
    const ch = new Channel<PanelEvent>();
    ch.onmessage = onEvent;
    await invoke("panel_open", { panel, path, onEvent: ch });
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
  fileUrl: (path) => convertFileSrc(path),
};

export const backend: Backend = inTauri ? tauriBackend : mockBackend;

export function joinPath(dir: string, name: string): string {
  return dir.endsWith("/") ? dir + name : `${dir}/${name}`;
}
