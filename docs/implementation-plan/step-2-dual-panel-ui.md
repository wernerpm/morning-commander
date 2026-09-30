# Step 2 — Dual-panel UI

> Status: DONE (v1)

## Goals

Two side-by-side panels showing directory listings, MC-style: dense monospace rows, directories first, a `..` row, a path header, a summary footer, and an F-key bar. One panel is active at a time.

## Technical approach

- **State**: `src/panel/store.ts` — `createPanel(id)` returns signals + actions for one panel. It receives `PanelEvent`s from the backend (`backend.panelOpen`) and keeps:
  - `all`: `Map<name, Entry>` (raw, includes hidden files)
  - `sorted`: filtered + sorted `Entry[]` (no `..`)
  - `rows`: memo = `[PARENT, ...sorted]` when not at `/`
  - `cursor` (index into `rows`), `selected` (`Set<name>`), `sort`, `showHidden`, `error`, `loading`
- **Snapshots** replace everything. On a new path the cursor goes to `pendingFocus` (e.g. the directory we came from) or 0, and selection is cleared. Same-path snapshots (refresh) keep the cursor on the same name.
- **Patches** are applied incrementally: remove affected names, then binary-insert upserts (`insertionIndex`). The cursor stays on the same *name*; if that name vanished it stays at the same *index* (clamped).
- **Late events**: every `open()` bumps a generation token; events from older subscriptions are dropped. Patches whose `path` differs from the current path are ignored.
- **Persistence**: path, sort and hidden-toggle per panel in `localStorage` (`mc.panel.<id>`).
- **Rendering**: `src/panel/Panel.tsx` — hand-rolled virtual list, fixed `ROW_HEIGHT = 22`, 8 rows overscan, rows absolutely positioned with `translateY`. `<For>` is keyed by `Entry` object identity, so scrolling reuses DOM nodes. The cursor row is kept in view by an effect.
- **Sort**: `src/panel/sort.ts` — directories (incl. symlinks to dirs) first; names compared by cached natural-sort keys (`sortKey`: accents stripped, lowercased, digit runs length-prefixed) so `report 2` < `Report 10`. Whole listings use `sortEntries` (decorate-sort-undecorate); `comparator` is only for binary-inserting patches — a unit test keeps both in agreement. `Intl.Collator` was 10× slower at 100k entries. Size/ext sorting applies to files only; dirs stay by name.
- **Formatting**: `src/panel/format.ts` — MC-like size column (`<DIR>`, `UP--DIR`, `12.3K`), ls-style dates.

## Files

```
src/panel/store.ts     panel state + actions
src/panel/Panel.tsx    virtual list, header, footer, inline rename input
src/panel/sort.ts      comparator, insertionIndex, extOf
src/panel/format.ts    size/date columns
src/app/app.css        theme variables (dark default, light via prefers-color-scheme)
```

## Tests

- `src/panel/sort.test.ts`, `src/panel/store.test.ts` (Vitest, mock backend)
- `tests/e2e/panels.spec.ts` (Playwright WebKit)

## Acceptance criteria

- [x] `/Users/demo/Many` (2000 files) renders < 100 DOM rows; End jumps to the last file
- [x] Going up puts the cursor on the directory you came from
- [x] External create/delete appear in both panels showing that directory, cursor stays on its file
- [x] 100k-entry directory in the real app: ~0.3 s cold, ~0.14 s cached; End/Home instant (see `window.__mcTiming`, docs/testing.md)

## Follow-ups

- Column widths adapt to panel width; optional columns (permissions, owner)
- Mouse: click the column header to sort, drag-select
- Classic MC blue theme toggle
- Brief/full listing modes (MC `Alt-t`)
