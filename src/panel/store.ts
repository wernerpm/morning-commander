// One panel's view state. Rust sends raw listings (snapshot, then patches);
// sorting, hidden-file filtering, cursor and selection live here.

import { batch, createMemo, createSignal } from "solid-js";
import { backend, joinPath } from "../ipc";
import { isNavigable, type Entry, type PanelEvent, type PanelId } from "../ipc/types";
import { comparator, insertionIndex, type SortSpec } from "./sort";

export const PARENT: Entry = {
  name: "..",
  kind: "dir",
  targetIsDir: true,
  size: 0,
  mtime: 0,
  hidden: false,
};

const STORAGE_KEY = (id: PanelId) => `mc.panel.${id}`;

interface Persisted {
  path: string;
  sort: SortSpec;
  showHidden: boolean;
}

function loadPersisted(id: PanelId): Partial<Persisted> {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY(id)) ?? "{}");
  } catch {
    return {};
  }
}

export function basename(path: string): string {
  if (path === "/") return "/";
  return path.slice(path.lastIndexOf("/") + 1);
}

export type Panel = ReturnType<typeof createPanel>;

export function createPanel(id: PanelId) {
  const saved = loadPersisted(id);
  const [path, setPath] = createSignal<string>("");
  const [parent, setParent] = createSignal<string | null>(null);
  // Sorted, filtered entries without the ".." row. Replaced (not mutated) on change.
  const [sorted, setSorted] = createSignal<Entry[]>([]);
  const [all, setAll] = createSignal<Map<string, Entry>>(new Map());
  const [sort, setSortSignal] = createSignal<SortSpec>(saved.sort ?? { key: "name", desc: false });
  const [showHidden, setShowHidden] = createSignal<boolean>(saved.showHidden ?? false);
  const [cursor, setCursor] = createSignal(0);
  const [selected, setSelected] = createSignal<Set<string>>(new Set());
  const [error, setError] = createSignal<string | null>(null);
  const [loading, setLoading] = createSignal(false);

  // Name to put the cursor on when the next snapshot arrives.
  let pendingFocus: string | null = null;
  // Name to put the cursor on when a patch creates it (e.g. after mkdir).
  let expectedName: string | null = null;
  // Monotonic token so late events from an old subscription are dropped.
  let generation = 0;
  // Back/forward history of visited paths.
  const back: string[] = [];
  const forward: string[] = [];
  let historyNav = false;

  const rows = createMemo<Entry[]>(() => (parent() !== null ? [PARENT, ...sorted()] : sorted()));
  const current = createMemo<Entry | undefined>(() => rows()[cursor()]);

  const visible = (e: Entry) => showHidden() || !e.hidden;

  function persist() {
    const p: Persisted = { path: path(), sort: sort(), showHidden: showHidden() };
    try {
      localStorage.setItem(STORAGE_KEY(id), JSON.stringify(p));
    } catch {
      // storage unavailable: nothing to remember
    }
  }

  function resort(keepName?: string) {
    const name = keepName ?? current()?.name;
    const list = [...all().values()].filter(visible).sort(comparator(sort()));
    batch(() => {
      setSorted(list);
      focusName(name);
    });
  }

  function focusName(name: string | undefined | null): boolean {
    if (name == null) return false;
    const i = rows().findIndex((e) => e.name === name);
    if (i >= 0) setCursor(i);
    else setCursor((c) => Math.min(c, Math.max(0, rows().length - 1)));
    return i >= 0;
  }

  function applySnapshot(e: Extract<PanelEvent, { type: "snapshot" }>) {
    const map = new Map(e.entries.map((x) => [x.name, x]));
    const samePath = e.path === path();
    if (!samePath && path() && !historyNav) {
      back.push(path());
      if (back.length > 100) back.shift();
      forward.length = 0;
    }
    historyNav = false;
    const keep = samePath ? current()?.name : undefined;
    batch(() => {
      setPath(e.path);
      setParent(e.parent);
      setAll(map);
      setError(null);
      setLoading(false);
      if (!samePath) {
        setSelected(new Set<string>());
        setCursor(0);
      }
      resort(pendingFocus ?? keep);
      pendingFocus = null;
    });
    persist();
  }

  function applyPatch(e: Extract<PanelEvent, { type: "patch" }>) {
    if (e.path !== path()) return;
    const keep = current()?.name;
    const keepIndex = cursor();
    const map = new Map(all());
    const cmp = comparator(sort());
    const gone = new Set(e.removed);
    for (const u of e.upserted) gone.add(u.name);
    let list = sorted().filter((x) => !gone.has(x.name));
    for (const name of e.removed) map.delete(name);
    for (const u of e.upserted) {
      map.set(u.name, u);
      if (visible(u)) list.splice(insertionIndex(list, u, cmp), 0, u);
    }
    batch(() => {
      setAll(map);
      setSorted(list);
      if (expectedName && e.upserted.some((u) => u.name === expectedName)) {
        focusName(expectedName);
        expectedName = null;
      } else if (!focusName(keep)) setCursor(Math.min(keepIndex, Math.max(0, rows().length - 1)));
      if (e.removed.length) {
        const sel = new Set(selected());
        let changed = false;
        for (const n of e.removed) changed = sel.delete(n) || changed;
        if (changed) setSelected(sel);
      }
    });
  }

  async function open(target: string, focus?: string, fromHistory = false) {
    const token = ++generation;
    historyNav = fromHistory;
    pendingFocus = focus ?? null;
    setLoading(true);
    try {
      await backend.panelOpen(id, target, (ev) => {
        if (token !== generation) return;
        if (ev.type === "snapshot") applySnapshot(ev);
        else if (ev.type === "patch") applyPatch(ev);
        else {
          setLoading(false);
          setError(ev.message);
        }
      });
    } catch (err) {
      if (token === generation) {
        setLoading(false);
        setError(String(err));
      }
    }
  }

  function enter(): { file?: Entry } {
    const e = current();
    if (!e) return {};
    if (e.name === "..") {
      goParent();
      return {};
    }
    if (isNavigable(e)) {
      void open(joinPath(path(), e.name));
      return {};
    }
    return { file: e };
  }

  function goBack() {
    const prev = back.pop();
    if (prev === undefined) return;
    forward.push(path());
    void open(prev, undefined, true);
  }

  function goForward() {
    const next = forward.pop();
    if (next === undefined) return;
    back.push(path());
    void open(next, undefined, true);
  }

  function goParent() {
    const p = parent();
    if (p !== null) void open(p, basename(path()));
  }

  function move(delta: number) {
    const n = rows().length;
    if (n === 0) return;
    setCursor((c) => Math.max(0, Math.min(n - 1, c + delta)));
  }

  function toggleSelect(name = current()?.name) {
    if (!name || name === "..") return;
    const sel = new Set(selected());
    if (!sel.delete(name)) sel.add(name);
    setSelected(sel);
  }

  function selectAll(on: boolean) {
    setSelected(on ? new Set(sorted().map((e) => e.name)) : new Set<string>());
  }

  /** Selected entries, or the entry under the cursor when nothing is selected. */
  function targets(): Entry[] {
    const sel = selected();
    if (sel.size) return sorted().filter((e) => sel.has(e.name));
    const e = current();
    return e && e.name !== ".." ? [e] : [];
  }

  function setSort(spec: SortSpec) {
    setSortSignal(spec);
    resort();
    persist();
  }

  function toggleHidden() {
    setShowHidden((v) => !v);
    resort();
    persist();
  }

  /** Optimistically rename a row so the cursor follows it before the watcher confirms. */
  function localRename(from: string, to: string) {
    const e = all().get(from);
    if (!e) return;
    applyPatch({ type: "patch", path: path(), removed: [from], upserted: [{ ...e, name: to }] });
    focusName(to);
  }

  return {
    id,
    initialPath: saved.path,
    path,
    parent,
    rows,
    entries: sorted,
    current,
    cursor,
    setCursor,
    selected,
    sort,
    showHidden,
    error,
    loading,
    open,
    enter,
    goParent,
    goBack,
    goForward,
    move,
    toggleSelect,
    selectAll,
    targets,
    setSort,
    toggleHidden,
    focusName,
    localRename,
    expectFocus: (name: string) => {
      expectedName = name;
    },
    fullPath: (name: string) => joinPath(path(), name),
  };
}
