// One panel's view state. Rust sends raw listings (snapshot, then patches);
// sorting, hidden-file filtering, cursor and selection live here.

import { batch, createMemo, createSignal } from "solid-js";
import { panelState, savePanelState } from "../app/settings";
import { backend, joinPath } from "../ipc";
import { isNavigable, type Entry, type PanelEvent, type PanelId } from "../ipc/types";
import { applyFilter } from "./filter";
import { comparator, insertionIndex, sortEntries, type SortSpec } from "./sort";

export const PARENT: Entry = {
  name: "..",
  kind: "dir",
  targetIsDir: true,
  size: 0,
  mtime: 0,
  hidden: false,
};

export function basename(path: string): string {
  if (path === "/") return "/";
  return path.slice(path.lastIndexOf("/") + 1);
}

export type Panel = ReturnType<typeof createPanel>;

export function createPanel(id: PanelId) {
  const saved = panelState(id);
  const [path, setPath] = createSignal<string>("");
  const [parent, setParent] = createSignal<string | null>(null);
  // Sorted, filtered entries without the ".." row. Replaced (not mutated) on change.
  const [sorted, setSorted] = createSignal<Entry[]>([]);
  const [all, setAll] = createSignal<Map<string, Entry>>(new Map());
  const [sort, setSortSignal] = createSignal<SortSpec>(saved?.sort ?? { key: "name", desc: false });
  const [showHidden, setShowHidden] = createSignal<boolean>(saved?.showHidden ?? false);
  // Listing came from a cache and is being revalidated (cleared by `fresh`).
  const [stale, setStale] = createSignal(false);
  // Directory is on a network volume.
  const [network, setNetwork] = createSignal(false);
  const [cursor, setCursor] = createSignal(0);
  const [selected, setSelected] = createSignal<Set<string>>(new Set());
  const [error, setError] = createSignal<string | null>(null);
  const [loading, setLoading] = createSignal(false);
  const [freeSpace, setFreeSpace] = createSignal<number | null>(null);
  // Fuzzy filter (⌘F): null = off, "" = open but empty (shows everything).
  const [filter, setFilterSignal] = createSignal<string | null>(null);

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

  const filtered = createMemo(() => {
    const q = filter();
    return q ? applyFilter(sorted(), q) : null;
  });
  const rows = createMemo<Entry[]>(() => {
    const f = filtered();
    if (f) return f.rows;
    return parent() !== null ? [PARENT, ...sorted()] : sorted();
  });
  const current = createMemo<Entry | undefined>(() => rows()[cursor()]);

  const visible = (e: Entry) => showHidden() || !e.hidden;

  function persist() {
    if (path()) savePanelState(id, { path: path(), sort: sort(), showHidden: showHidden() });
  }

  function resort(keepName?: string) {
    const name = keepName ?? current()?.name;
    const list = sortEntries([...all().values()].filter(visible), sort());
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
      setStale(e.stale);
      setNetwork(e.network);
      if (!samePath) {
        setSelected(new Set<string>());
        setFilterSignal(null);
        setCursor(0);
      }
      resort(pendingFocus ?? keep);
      pendingFocus = null;
    });
    persist();
    if (!samePath) refreshFreeSpace();
  }

  /** Re-read free space for the current directory's volume (after navigation or file ops). */
  function refreshFreeSpace() {
    const p = path();
    backend.volumeInfo(p).then(
      (v) => p === path() && setFreeSpace(v.free),
      () => setFreeSpace(null),
    );
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

  /** `refresh` (⇧⌘R) asks Rust for a full re-read even if the cached listing looks current. */
  async function open(target: string, focus?: string, fromHistory = false, refresh = false) {
    const token = ++generation;
    const t0 = performance.now();
    historyNav = fromHistory;
    pendingFocus = focus ?? null;
    setLoading(true);
    try {
      await backend.panelOpen(
        id,
        target,
        (ev) => {
          if (token !== generation) return;
          if (ev.type === "snapshot") {
            const t1 = performance.now();
            applySnapshot(ev);
            if (import.meta.env.DEV) {
              // Dev-only timing, read by scripts/drive.mjs perf checks.
              const w = window as unknown as { __mcTiming?: object[] };
              (w.__mcTiming ??= []).push({
                path: ev.path,
                n: ev.entries.length,
                stale: ev.stale,
                ipc: Math.round(t1 - t0),
                apply: Math.round(performance.now() - t1),
              });
            }
          } else if (ev.type === "patch") applyPatch(ev);
          else if (ev.type === "fresh") {
            if (ev.path === path()) setStale(false);
          } else {
            batch(() => {
              setLoading(false);
              setStale(false);
              setError(ev.message);
            });
          }
        },
        refresh,
      );
    } catch (err) {
      if (token === generation) {
        setLoading(false);
        setError(String(err));
      }
    }
  }

  /** Change the filter text; the cursor goes to the best match. */
  function setFilter(q: string) {
    const keep = current()?.name;
    batch(() => {
      setFilterSignal(q);
      const f = filtered();
      if (f) setCursor(f.best);
      else focusName(keep);
    });
  }

  /** Turn the filter off, keeping the cursor on `keep` (default: the current entry). */
  function clearFilter(keep = current()?.name) {
    if (filter() === null) return;
    batch(() => {
      setFilterSignal(null);
      if (!focusName(keep)) setCursor(0);
    });
  }

  function enter(): { file?: Entry } {
    const e = current();
    if (!e) return {};
    // Opening a file ends the filter with the file still under the cursor;
    // opening a directory ends it when the new listing arrives.
    if (!isNavigable(e)) clearFilter(e.name);
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

  /** Select all shown entries (only the matches while filtering), or none. */
  function selectAll(on: boolean) {
    const shown = filtered()?.rows ?? sorted();
    setSelected(on ? new Set(shown.map((e) => e.name)) : new Set<string>());
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
    initialPath: saved?.path,
    path,
    parent,
    stale,
    network,
    /** Re-read the current directory (⇧⌘R), bypassing the cache's shortcuts. */
    reload: () => open(path(), undefined, false, true),
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
    freeSpace,
    refreshFreeSpace,
    filter,
    setFilter,
    clearFilter,
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
