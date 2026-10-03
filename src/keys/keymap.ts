// One registry of commands and their default keys. Handlers are attached by
// the app; this module only knows names, titles and bindings.

export type CommandId =
  | "cursor.up" | "cursor.down" | "cursor.pageUp" | "cursor.pageDown" | "cursor.home" | "cursor.end"
  | "panel.open" | "panel.parent" | "panel.switch" | "panel.swap" | "panel.sameDir"
  | "panel.toggleHidden" | "panel.goto" | "panel.home" | "panel.refresh" | "panel.filter"
  | "sort.name" | "sort.ext" | "sort.size" | "sort.mtime" | "sort.none"
  | "select.toggle" | "select.all" | "select.none"
  | "file.view" | "file.edit" | "file.openDefault" | "file.rename"
  | "file.copy" | "file.move" | "file.mkdir" | "file.trash"
  | "history.back" | "history.forward" | "bookmarks.open" | "bookmarks.add"
  | "app.help";

export interface Command {
  id: CommandId;
  title: string;
  keys: string[];
}

export const COMMANDS: Command[] = [
  { id: "cursor.up", title: "Up", keys: ["ArrowUp"] },
  { id: "cursor.down", title: "Down", keys: ["ArrowDown"] },
  { id: "cursor.pageUp", title: "Page up", keys: ["PageUp", "Alt+ArrowUp"] },
  { id: "cursor.pageDown", title: "Page down", keys: ["PageDown", "Alt+ArrowDown"] },
  { id: "cursor.home", title: "First entry", keys: ["Home"] },
  { id: "cursor.end", title: "Last entry", keys: ["End"] },
  { id: "panel.open", title: "Open", keys: ["Enter", "Meta+ArrowDown"] },
  { id: "panel.parent", title: "Parent directory", keys: ["Backspace", "Meta+ArrowUp"] },
  { id: "panel.switch", title: "Switch panel", keys: ["Tab", "Shift+Tab"] },
  { id: "panel.swap", title: "Swap panels", keys: ["Meta+U"] },
  { id: "panel.sameDir", title: "Other panel: same directory", keys: ["Meta+="] },
  { id: "panel.toggleHidden", title: "Toggle hidden files", keys: ["Meta+."] },
  { id: "panel.goto", title: "Go to path", keys: ["Meta+L", "Meta+Shift+G"] },
  { id: "panel.home", title: "Home directory", keys: ["Meta+Shift+H"] },
  { id: "panel.refresh", title: "Re-read directory", keys: ["Meta+Shift+R"] },
  { id: "panel.filter", title: "Filter (fuzzy, Esc ends)", keys: ["Meta+F"] },
  { id: "history.back", title: "Back", keys: ["Meta+["] },
  { id: "history.forward", title: "Forward", keys: ["Meta+]"] },
  { id: "bookmarks.open", title: "Bookmarks", keys: ["Meta+D"] },
  { id: "bookmarks.add", title: "Bookmark this folder", keys: ["Meta+Shift+D"] },
  { id: "sort.name", title: "Sort by name", keys: ["Meta+1"] },
  { id: "sort.ext", title: "Sort by extension", keys: ["Meta+2"] },
  { id: "sort.size", title: "Sort by size", keys: ["Meta+3"] },
  { id: "sort.mtime", title: "Sort by modified time", keys: ["Meta+4"] },
  { id: "sort.none", title: "Unsorted", keys: ["Meta+5"] },
  { id: "select.toggle", title: "Toggle selection", keys: ["Space", "Insert", "Meta+T"] },
  { id: "select.all", title: "Select all", keys: ["Meta+A"] },
  { id: "select.none", title: "Select none", keys: ["Meta+Shift+A"] },
  { id: "file.view", title: "View", keys: ["F3"] },
  { id: "file.edit", title: "Edit", keys: ["F4"] },
  { id: "file.openDefault", title: "Open with default app", keys: ["Meta+O", "Meta+Enter"] },
  { id: "file.rename", title: "Rename", keys: ["Meta+R", "Shift+F6", "F2"] },
  { id: "file.copy", title: "Copy to other panel", keys: ["F5", "Meta+C"] },
  { id: "file.move", title: "Move to other panel", keys: ["F6", "Meta+M"] },
  { id: "file.mkdir", title: "New folder", keys: ["F7", "Meta+Shift+N"] },
  { id: "file.trash", title: "Move to Trash", keys: ["F8", "Meta+Backspace", "Delete"] },
  { id: "app.help", title: "Keyboard help", keys: ["F1", "Meta+/"] },
];

/**
 * Canonical chord string for a keyboard event: modifiers in a fixed order
 * (Meta, Ctrl, Alt, Shift) followed by the key. Letters and digits come from
 * `code` so Shift/Option layouts don't change them ("Meta+Shift+N").
 */
export function chord(ev: KeyboardEvent): string {
  let key = ev.key;
  if (/^Key[A-Z]$/.test(ev.code)) key = ev.code.slice(3);
  else if (/^Digit\d$/.test(ev.code)) key = ev.code.slice(5);
  else if (ev.code === "Period") key = ".";
  else if (ev.code === "Equal") key = "=";
  else if (ev.code === "Slash") key = "/";
  else if (ev.code === "BracketLeft") key = "[";
  else if (ev.code === "BracketRight") key = "]";
  else if (key === " ") key = "Space";
  const mods: string[] = [];
  if (ev.metaKey) mods.push("Meta");
  if (ev.ctrlKey) mods.push("Ctrl");
  if (ev.altKey) mods.push("Alt");
  if (ev.shiftKey && key.length > 1) mods.push("Shift");
  else if (ev.shiftKey && /^[A-Z0-9.=/[\]]$/.test(key)) mods.push("Shift");
  return [...mods, key].join("+");
}

function normalise(binding: string): string {
  const parts = binding.split("+");
  const order = ["Meta", "Ctrl", "Alt", "Shift"];
  const mods = order.filter((m) => parts.includes(m));
  const key = parts.filter((p) => !order.includes(p));
  return [...mods, ...key].join("+");
}

const byChord = new Map<string, CommandId>();
for (const c of COMMANDS) for (const k of c.keys) byChord.set(normalise(k), c.id);

export function commandFor(ev: KeyboardEvent): CommandId | undefined {
  return byChord.get(chord(ev));
}

/** A key that should feed type-to-jump: one printable character, no Cmd/Ctrl. */
export function jumpChar(ev: KeyboardEvent): string | null {
  if (ev.metaKey || ev.ctrlKey) return null;
  if (ev.key.length !== 1 || ev.key === " ") return null;
  return ev.key;
}

export function keysFor(id: CommandId): string[] {
  return COMMANDS.find((c) => c.id === id)?.keys ?? [];
}
