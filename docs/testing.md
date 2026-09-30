# Testing

Four layers, from fastest to most realistic. Use the cheapest one that can catch the bug you care about.

| Layer | Tool | Runs on | What it covers |
|---|---|---|---|
| Rust unit + integration | `cargo test` | macOS (watcher/trash tests need macOS FSEvents/NSFileManager; others anywhere) | listing, cache, watcher patches, rename validation, copy/move, read_text |
| Frontend unit | Vitest (`pnpm test`) | anywhere | sort order, type-to-jump rules, panel store (snapshot/patch/cursor/selection) against the mock |
| Frontend e2e | Playwright WebKit (`pnpm test:e2e`) | anywhere | keyboard flows end to end in the real UI against `src/ipc/mock.ts` |
| Real app | `tauri-plugin-webdriver` + `scripts/drive.mjs` | macOS | the actual WKWebView + Rust backend: asset protocol, FSEvents, trash, media playback |

## Mock backend

`src/ipc/mock.ts` is used whenever `window.__TAURI_INTERNALS__` is missing. It seeds `/Users/demo` with a small tree (plus `/Users/demo/Many` with 2000 files) and delivers patches asynchronously like the watcher. Tests can simulate external changes:

```js
window.__mock.touch("/Users/demo/new.txt", 10);
window.__mock.remove("/Users/demo/alpha.txt");
```

Media URLs from the mock (`mock://…`) don't load, so image/video/PDF rendering can only be verified in the real app.

## Driving the real app

```bash
pnpm tauri dev --features webdriver      # starts the app with a WebDriver server on 127.0.0.1:4445
node scripts/drive.mjs state              # both panels' path, cursor and status
node scripts/drive.mjs type:doc key:Enter wait:200 state shot:/tmp/mc.png
```

Steps: `press:<Key>` (synthetic keydown; needed for End/Home/PageUp/PageDown, which tauri-plugin-webdriver 0.2 doesn't map), `fill:<text>` (set the focused input's value — plugin typing appends instead of replacing a selection), `key:<Chord>` (e.g. `key:Meta+r`, `key:F7`), `type:<text>`, `wait:<ms>`, `eval:<js returning JSON>`, `state`, `shot:<file.png>`.

The `webdriver` feature is off by default and must never be enabled in release builds: it lets any local process run JS in a window that can rename and trash files.

Each `drive.mjs` call opens a new WebDriver session on the same page; app state carries over between calls.

In dev builds the store records per-snapshot timings in `window.__mcTiming` (`ipc` = request → snapshot received, `apply` = sort + render), e.g.:

```bash
node scripts/drive.mjs key:Backspace wait:800 key:Enter wait:1500 "eval:return window.__mcTiming.slice(-1)"
```

Reference numbers (M-series Mac, dev build with opt-level 1): 100k files cached → ipc ≈ 50 ms, apply ≈ 70 ms.

A good smoke test after backend changes:

```bash
mkdir -p /tmp/mc-smoke && cd /tmp/mc-smoke && touch a.txt b.txt
node scripts/drive.mjs "eval:return 1" # session works
node scripts/drive.mjs key:Meta+l type:/tmp/mc-smoke key:Enter wait:300 state
touch /tmp/mc-smoke/c.txt && sleep 0.5 && node scripts/drive.mjs "eval:return [...document.querySelectorAll('[data-panel=\"0\"] .row')].map(r=>r.dataset.name)"
```
