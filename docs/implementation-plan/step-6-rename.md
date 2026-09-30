# Step 6 — Rename in place

> Status: DONE (frontend); backend `rename` command in Step 1/7 backend work

## Goals

`⌘R` / `Shift+F6` / `F2` turns the cursor row's name into an input, Finder-style.

## Technical approach

- `App.tsx` holds `renaming: { panel, name } | null`. `Panel.tsx` renders an `<input class="rename">` in place of the name when the row is the cursor row and its name matches.
- On mount the input focuses and selects the **stem** (`report` of `report.pdf`); `⌘R` again selects everything.
- The input stops propagation of all keys, so letters don't jump and ⌘C/⌘⌫ behave as text editing.
- `Enter` → `backend.rename(dir, from, to)`; on success `panel.localRename(from, to)` applies an optimistic patch so the cursor follows the new name immediately; the watcher's patch later confirms it (idempotent).
- `Esc` or blur cancels. Errors (exists, invalid, permission) show in the status line; nothing changes.
- Backend validation (Rust): non-empty, no `/`, no NUL, not `.`/`..`; target must not exist unless it's a case-only rename (goes via a temp name on case-insensitive APFS).

## Tests

- e2e: `rename in place with Cmd+R`, `rename cancels with Escape`
- Rust: rename validation and case-only rename

## Acceptance criteria

- [x] Stem preselected, typing replaces it and keeps the extension
- [x] Enter commits, cursor stays on renamed file
- [x] Esc cancels without side effects
- [ ] Renaming onto an existing name shows an error and keeps the old name (verify in the real app)

## Follow-ups

- Batch rename dialog when several files are selected (find/replace, numbering, preview)
- Undo last rename (`⌘Z`)
