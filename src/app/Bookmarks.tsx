import { createMemo, createSignal, For, onMount, Show } from "solid-js";
import type { Bookmark } from "../ipc/types";
import { fold } from "../panel/jump";
import { prefs, updatePrefs } from "./settings";

export type { Bookmark };

/** Saved bookmarks, or the defaults when none were ever saved. */
export function loadBookmarks(home: string): Bookmark[] {
  return (
    prefs().bookmarks ?? [
      { name: "Home", path: home },
      { name: "Desktop", path: `${home}/Desktop` },
      { name: "Documents", path: `${home}/Documents` },
      { name: "Downloads", path: `${home}/Downloads` },
      { name: "Applications", path: "/Applications" },
      { name: "Volumes", path: "/Volumes" },
    ]
  );
}

export function saveBookmarks(list: Bookmark[]) {
  void updatePrefs({ bookmarks: list });
}

interface Props {
  bookmarks: Bookmark[];
  onOpen: (path: string) => void;
  onRemove: (b: Bookmark) => void;
  onClose: () => void;
}

/** Hotlist (MC Ctrl-\): type to filter, arrows to pick, Enter to go, ⌘⌫ to remove. */
export default function Bookmarks(props: Props) {
  let input!: HTMLInputElement;
  const [filter, setFilter] = createSignal("");
  const [index, setIndex] = createSignal(0);

  const shown = createMemo(() => {
    const f = fold(filter());
    return props.bookmarks.filter((b) => fold(b.name).includes(f) || fold(b.path).includes(f));
  });

  onMount(() => input.focus());

  function onKeyDown(e: KeyboardEvent) {
    e.stopPropagation();
    const n = shown().length;
    if (e.key === "Escape") props.onClose();
    else if (e.key === "ArrowDown") setIndex((i) => Math.min(n - 1, i + 1));
    else if (e.key === "ArrowUp") setIndex((i) => Math.max(0, i - 1));
    else if (e.key === "Enter") {
      const b = shown()[index()];
      props.onClose();
      if (b) props.onOpen(b.path);
    } else if (e.key === "Backspace" && e.metaKey) {
      const b = shown()[index()];
      if (b) props.onRemove(b);
    } else return;
    e.preventDefault();
  }

  return (
    <div class="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && props.onClose()}>
      <div class="modal bookmarks" role="dialog" aria-label="Bookmarks" onKeyDown={onKeyDown}>
        <h2>Bookmarks</h2>
        <input
          ref={input}
          placeholder="Filter…"
          value={filter()}
          spellcheck={false}
          onInput={(e) => {
            setFilter(e.currentTarget.value);
            setIndex(0);
          }}
        />
        <ul>
          <For each={shown()}>
            {(b, i) => (
              <li
                classList={{ current: i() === index() }}
                onMouseDown={() => {
                  props.onClose();
                  props.onOpen(b.path);
                }}
              >
                <span>{b.name}</span>
                <span class="muted">{b.path}</span>
              </li>
            )}
          </For>
        </ul>
        <Show when={shown().length === 0}>
          <p class="muted">No bookmarks match.</p>
        </Show>
        <p class="muted hint">Enter go · ⇧⌘D add current folder · ⌘⌫ remove · Esc close</p>
      </div>
    </div>
  );
}
