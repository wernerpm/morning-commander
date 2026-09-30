// Mirrors src-tauri/src/model.rs. See docs/ipc.md; change both together.

export type EntryKind = "file" | "dir" | "symlink" | "other";

export interface Entry {
  name: string;
  kind: EntryKind;
  targetIsDir: boolean;
  size: number;
  mtime: number;
  hidden: boolean;
}

export type PanelEvent =
  | { type: "snapshot"; path: string; parent: string | null; entries: Entry[] }
  | { type: "patch"; path: string; removed: string[]; upserted: Entry[] }
  | { type: "error"; path: string; message: string };

export type OpKind = "copy" | "move";

/** Answer to an OpEvent "conflict". Overwrite moves the existing item to the Trash first. */
export type ConflictChoice = "overwrite" | "skip" | "keepBoth" | "cancel";

export type OpEvent =
  | {
      type: "progress";
      id: number;
      filesDone: number;
      filesTotal: number;
      bytesDone: number;
      bytesTotal: number;
      current: string;
    }
  | { type: "conflict"; id: number; path: string }
  | { type: "done"; id: number; errors: string[] }
  | { type: "cancelled"; id: number };

export interface TextPreview {
  text: string;
  truncated: boolean;
  binary: boolean;
  size: number;
}

export type PanelId = 0 | 1;

export function isNavigable(e: Entry): boolean {
  return e.kind === "dir" || (e.kind === "symlink" && e.targetIsDir);
}
