# Step 8 — Polish

> Status: PARTIAL — sort modes, hidden toggle, swap, same-dir, go-to-path, help overlay, light/dark theme done; bookmarks, free-space, MC theme not started

## Goals

The small things that make it a daily driver.

## Done

| Feature | Keys | Where |
|---|---|---|
| Sort by name/ext/size/mtime/none (press again to reverse) | `⌘1`–`⌘5` | `App.tsx` `setSort`, `panel/sort.ts` |
| Toggle hidden files | `⌘.` | `store.toggleHidden` |
| Swap panels | `⌘U` | handler `panel.swap` |
| Other panel → same dir | `⌘=` | handler `panel.sameDir` |
| Go to path (`~` supported) | `⌘L`, `⇧⌘G` | `goto()` dialog |
| Home | `⇧⌘H` | handler `panel.home` |
| Refresh | `⇧⌘R` | re-opens the panel (cache is served; watcher keeps it right) |
| Help overlay | `F1`, `⌘/` | rendered from `COMMANDS` |
| Theme | — | CSS variables in `app/app.css`, light via `prefers-color-scheme` |
| Remember panel paths, sort, hidden | — | `localStorage` |

## To do (specs)

### Bookmarks / hotlist — `⌘D`
- Dialog listing bookmarks (name → path), type-to-filter, Enter opens in the active panel.
- `⌘⇧D` adds the current directory. Stored in `localStorage` (`mc.bookmarks`), later a JSON file in the app config dir.
- Seed with Home, Desktop, Documents, Downloads, `/Volumes`.

### Free space in the footer
- Rust command `volume_info(path) -> { free, total, name }` via `statvfs`; call on navigate, show `123 GB free` in the panel footer.

### Status line
- Shows the cursor entry's full name, size in bytes, permissions and mtime (MC mini-status). Needs `mode` on `Entry` or a `stat(path)` command.

### Classic MC theme
- `data-theme="mc"` on `<html>` swapping the CSS variables to the blue/cyan palette; toggle in a settings dialog.

### History
- `⌘[` / `⌘]` back/forward per panel (store a stack in `store.ts`).

### Volumes
- `⌘⇧V` lists `/Volumes/*` to jump to; handle ejected volume (panel falls back — backend already sends a snapshot of the nearest ancestor).

## Acceptance criteria

- Every item above is reachable from the keyboard, appears in the F1 help, and has an e2e test with the mock backend.
