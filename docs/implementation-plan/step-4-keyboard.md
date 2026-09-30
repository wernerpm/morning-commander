# Step 4 — Keyboard, type-to-jump, selection

> Status: DONE (v1)

## Goals

Everything is reachable from the keyboard with Midnight Commander conventions, with `⌘` alternatives for Mac laptops (F-keys need `fn`). Bare letters jump to files.

## Technical approach

### Command registry — `src/keys/keymap.ts`

- `COMMANDS`: `{ id, title, keys[] }`. The help overlay (F1 / `⌘/`) renders straight from this table.
- `chord(ev)` canonicalises an event to `Meta+Ctrl+Alt+Shift+Key`. Letters/digits come from `ev.code` so Shift/Option layouts don't change them.
- `commandFor(ev)` maps a chord to a command id. `App.tsx` holds `handlers: Record<CommandId, () => void>`, so the compiler forces every command to have a handler.
- **Rule**: no command may be bound to an unmodified printable key. `jumpChar(ev)` treats any single printable character without ⌘/Ctrl as jump input (Space is excluded — it toggles selection).

### Focus contexts

`App.onKeyDown` (window listener) ignores keys while a viewer, dialog or rename input is open — those components own the keyboard and stop propagation. Order inside the panel context: help overlay → op cancel (Esc) → jump buffer editing (Esc/Backspace) → jump characters → commands.

### Type-to-jump — `src/panel/jump.ts`

Pure functions, unit-tested:

1. A character after the timeout (1000 ms) or with an empty buffer starts a new prefix and searches from the row **after** the cursor, wrapping — so pressing `s` slowly cycles through s-files.
2. Within the timeout, characters extend the prefix and search from the cursor row (inclusive).
3. If the extended prefix matches nothing and consists of one repeated character (`ss`), cycle to the next entry starting with that character instead — so `d`,`d` quickly also cycles — unless something actually starts with `ss`.
4. Matching folds case and diacritics (`fold()`), never matches `..`.
5. Backspace while the buffer is active shortens it and re-matches from the top; Esc clears it.
6. The panel footer shows `Jump: <buffer>`, red when there's no match.

### Selection

`Space` / `Insert` / `⌘T` toggles the cursor entry and moves down. `⌘A` / `⇧⌘A` select all / none. Operations use `panel.targets()`: the selection if any, else the cursor entry (never `..`).

## Keymap (v1)

See `COMMANDS` in `src/keys/keymap.ts` (authoritative) and the README table.

## Tests

- `src/panel/jump.test.ts` — all rules above
- `tests/e2e/panels.spec.ts` — jump, cycling, Tab, Space selection + F5

## Acceptance criteria

- [x] Typing `rea` quickly lands on `readme.txt`; `d`,`d` goes Documents → Downloads
- [x] Letters never trigger commands; commands never eat letters
- [x] Keys don't leak into panels while a dialog/viewer/rename is open

## Follow-ups

- User keymap overrides (JSON in app config dir) with conflict detection
- `⌘K` command palette from the same registry
- MC-style quick search mode (`Ctrl-S`) that filters instead of jumping
- Shift+arrows range selection, `+`/`-` pattern select dialog (bound to ⌘ variants)
