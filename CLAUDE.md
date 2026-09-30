# Morning Commander — agent guide

Dual-pane, keyboard-first file manager for macOS. Tauri 2 (Rust) + SolidJS/TypeScript in WKWebView.

Start with:
- `docs/implementation-plan.md`: status table and overall design. **Update its status table when you finish a step.**
- `docs/implementation-plan/step-*.md`: detailed specs per step (goals, files, invariants, acceptance criteria).
- `docs/ipc.md`: the Rust ↔ webview contract. `src-tauri/src/model.rs`, `src/ipc/types.ts` and `docs/ipc.md` must change together.
- `docs/testing.md`: how to test at each layer, including driving the real app.
- `docs/release.md`: building, versioning, signing/notarisation and publishing.

## Commands

| What | Command |
|---|---|
| Install JS deps | `pnpm install` |
| Frontend typecheck | `pnpm typecheck` |
| Frontend unit tests (Vitest) | `pnpm test` |
| Frontend e2e (Playwright WebKit, mock backend) | `pnpm test:e2e` (first time: `pnpm exec playwright install webkit`) |
| Rust tests | `cd src-tauri && cargo test` |
| Rust lint | `cd src-tauri && cargo clippy --all-targets -- -D warnings` |
| Run the app | `pnpm tauri dev` |
| Build `.app` + `.dmg` | `pnpm tauri build` (see `docs/release.md`) |
| Run the app, drivable via WebDriver | `pnpm tauri dev --features webdriver`, then `node scripts/drive.mjs ...` |
| Frontend only in a browser (mock backend) | `pnpm dev` → http://localhost:1420 |
| Screenshot of frontend (mock) | `node scripts/screenshot.mjs out.png type:rea Enter` (needs `pnpm dev`) |

Run the relevant checks before every commit.

**On Linux (e.g. Claude Cloud)** — not yet verified, expected to work: the frontend checks (`pnpm typecheck`, `pnpm test`, `pnpm test:e2e`; Playwright may need `pnpm exec playwright install --with-deps webkit`) run anywhere and are the main way to verify UI changes. The Rust crate gates macOS code with `cfg(target_os = "macos")`, but compiling Tauri needs system packages: `sudo apt-get install -y libwebkit2gtk-4.1-dev libgtk-3-dev libayatana-appindicator3-dev librsvg2-dev libssl-dev build-essential pkg-config`. Watcher tests use inotify there instead of FSEvents, so treat macOS CI (GitHub Actions) as the authority for backend behaviour. The real app and `scripts/drive.mjs` need macOS.

## Layout

```
src/                      SolidJS frontend
  App.tsx                 layout, key dispatch, dialogs, file-op orchestration
  app/                    Dialog, OpProgress, app.css (theme variables)
  panel/                  store.ts (panel state), Panel.tsx (virtual list), sort.ts, jump.ts, format.ts
  keys/keymap.ts          command registry + default key bindings
  viewer/                 full-window viewer (image/pdf/video/audio/text)
  ipc/                    types.ts (wire types), index.ts (Tauri calls), mock.ts (in-memory backend)
src-tauri/src/            Rust backend (listing, cache, watcher, commands, file ops)
tests/e2e/                Playwright specs (WebKit, mock backend)
scripts/                  screenshot.mjs, drive.mjs
```

## Conventions

- Rust owns the filesystem; the frontend owns sorting, cursor, selection and the jump buffer. Don't add per-keypress IPC.
- Never bind a command to an unmodified letter or digit: bare printable keys are type-to-jump.
- All keys go through `src/keys/keymap.ts`. Add a command there, then a handler in `App.tsx`'s `handlers`.
- Deletions always go to the Trash. Nothing in the app permanently deletes user files.
- Changes to the filesystem are never patched into the UI by the code that made them (except the optimistic rename); the watcher reports them.
- Keep the mock backend (`src/ipc/mock.ts`) in sync with new commands so e2e tests can cover them.
- **Privacy:** never commit real paths, share names or file names from the owner's disks or NAS (docs, tests, fixtures, commit messages). Use placeholders (`/Volumes/<share>/<dir>`) or the mock tree (`/Users/demo`).
- Commit messages: imperative subject, short body; end with the `Co-Authored-By` line the harness gives you.
