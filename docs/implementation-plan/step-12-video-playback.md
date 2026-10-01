# Step 12 — Video playback: more formats, NAS read-ahead

> Status: DONE on branch `video-playback` (2026-10-01). Verified in the real app with H.264/AC-3, HEVC/DTS and VP9/Opus MKV, Xvid/MP3 AVI, MPEG-2 TS, and a 300 MB MKV on the NAS. Frontend unit + e2e (Playwright WebKit plays a tiny MKV through libmedia) and Rust tests pass.

## Goals

1. **More formats.** The viewer plays what WebKit/AVFoundation plays (MP4/MOV/M4V/WebM with H.264, HEVC, VP9, AAC, MP3…). Typical media-library files (MKV, AVI, MPEG-TS, MPG/VOB, FLV, OGV, and codecs like AC-3/DTS/Xvid/MPEG-2) show "Can't play this format". They should play inside the viewer with the same keys (`←/→` ±5 s, `↑/↓` ±1 min, `=`/`-` volume, `Space`, `M`, `F`).
2. **Smooth playback from the NAS.** Once a video starts, keep reading it from the network ahead of the playhead into a local spool, so short SMB stalls don't stall playback and seeking back is instant.

## Options considered

| Option | Formats | Effort / risk | Verdict |
|---|---|---|---|
| **[libmedia](https://github.com/zhaohappy/libmedia) `AVPlayer`** (TypeScript + FFmpeg-derived WASM decoders, WebCodecs hardware decoding, LGPL-3.0) | Demuxers: MKV/WebM, MP4/MOV, MPEG-TS, AVI, FLV, Ogg, MP3… Decoders: H.264, HEVC, AV1, VP8/9, MPEG-2/4, Xvid/DivX, MS-MPEG4, WMV1-3, AAC, AC-3, E-AC-3, DTS, Opus, Vorbis, FLAC, WMA… **No ASF demuxer (.wmv/.asf)**, no RealMedia. | Drop-in, runs in WKWebView without cross-origin isolation (worker mode). Verified in the real app with H.264/AC-3 MKV, HEVC/DTS MKV, VP9/Opus MKV, Xvid/MP3 AVI, MPEG-2 TS. | **Chosen** as the fallback engine. |
| [Movi Player](https://github.com/cmjagentes/movi-player) (WebCodecs + FFmpeg WASM, Apache-2.0) | MKV/MP4, H.264/HEVC/AV1/VP9/MPEG-2/4, AAC/AC-3/E-AC-3 (no DTS mentioned) | v0.4, 131 MB package | Too young. |
| Embedded mpv/VLC ([tauri-plugin-libmpv](https://github.com/nini22P/tauri-plugin-libmpv), [tauri-plugin-mpv](https://github.com/nini22P/tauri-plugin-mpv)) | Everything | macOS "not tested"; mpv's `--wid` embedding isn't implemented on macOS without a patched libmpv; needs a transparent webview over a native view and bundling GPL/LGPL dylibs | Not now. |
| Remux/transcode with `ffmpeg` (HLS or fMP4 into `<video>`) | Everything ffmpeg reads | Needs an ffmpeg binary (bundle ~50–80 MB or rely on Homebrew); seeking in a growing remux needs restart-at-offset logic | Keep in reserve for WMV/ASF if it matters. |
| Hand off to an external player | Everything | Trivial | Already there: `⌘O` opens in the default app (IINA/VLC if set). |

## Design

### Engines

`src/viewer/MediaView.tsx` keeps the keyboard, overlay, volume persistence and auto-hiding controls, and drives one of two engines through a small adapter (`play/pause/seek/volume/muted/currentTime/duration`):

- **native**: `<video>`/`<audio>` with native controls (as today) for `mp4 m4v mov webm` and the audio formats WebKit plays.
- **libmedia**: `AVPlayer` rendering into a `<div>`, with a minimal control bar of our own (time / duration, seek bar, play state) for `mkv avi ts m2ts mts mpg mpeg vob flv ogv 3gp divx` and audio `ac3 dts opus mka`.
- A native-engine error falls back to libmedia once (e.g. an MP4 with a codec AVFoundation lacks); a libmedia error shows the existing "Can't play this format" card (`⌘O`/`Enter` opens externally).

### Loading libmedia

The npm package's ESM build lazy-loads its own chunks relative to `import.meta.url`, which breaks under Vite pre-bundling and Rollup. `scripts/fetch-libmedia.mjs` (run by `predev`/`prebuild`) copies `node_modules/@libmedia/avplayer/dist/esm` to `public/libmedia/avplayer/` and downloads the needed WASM decoders (SIMD builds, ~15 MB, pinned to the package version, SHA-256 checked against `scripts/libmedia-wasm.sha256`) into `public/libmedia/`. `src/viewer/libmedia.ts` `import()`s it at runtime. CSP gains `'wasm-unsafe-eval'`.

libmedia's own HTTP loader only accepts `http(s)` URLs, so `src/viewer/rangeLoader.ts` implements its `CustomIOLoader` with `fetch` + `Range` against our URL schemes, with segment read-ahead (and tolerance for short range responses).

### `media://` scheme + NAS spool (Rust, `src-tauri/src/media.rs`)

Both engines load videos and audio from `media://localhost/<encodeURIComponent(path)>` instead of `asset://`:

- Range requests (`206`, `Content-Range`, `Accept-Ranges`, CORS headers for `fetch`), at most 4 MiB per response.
- **Local files**: served straight from the file.
- **Network volumes** (`netvol::is_network`, or `MC_FORCE_NETWORK=1`): served through a **spool**: a sparse temp file in `~/.morning-commander/media/` plus a bitmap of 1 MiB blocks already fetched. A reader thread fetches missing blocks sequentially (4 MiB reads) from the latest requested position up to `mediaReadAheadBytes` ahead (default 1 GiB). A request for blocks not yet spooled reads them directly from the source (and spools them), so a seek never waits behind read-ahead. Blocks more than 256 MiB behind the playhead are released with `F_PUNCHHOLE`, so the spool stays bounded.
- One spool at a time: opening another media file, `media_close` (viewer closed) or app exit deletes it; leftovers are removed at startup.

IPC: `media_status(path) → { size, cached, ahead, network }` (polled ~1 s by the viewer to show "Buffered 1.2 GB ahead" in the header on network files) and `media_close()`.

## Implementation notes

- `src/viewer/MediaView.tsx`: shell + `NativePlayer`; `src/viewer/LibmediaPlayer.tsx`: libmedia engine and control bar; `src/viewer/kind.ts` `mediaEngine()`.
- `.ts` stays TypeScript by name; the viewer plays it as MPEG-TS only when the text sniff says binary (`read_text` now sniffs the first 8 KB before reading more, so this costs one small read on the NAS).
- libmedia runs with `enableWorker: false`: in WKWebView, workers can't load anything from the app's `tauri://` scheme (fetch and `importScripts` fail with a network error), and libmedia's workers load their chunks and WASM by URL. This only shows in the bundled app (dev serves from `http://localhost:1420`). Video decoding still happens in hardware via WebCodecs; software decoders (DTS, Xvid…) run on the main thread, fine for SD/HD.
- The bundled app's CSP needed `connect-src 'self'` (libmedia fetches its WASM) and `script-src blob:` (its AudioWorklet module); `pnpm tauri dev` doesn't enforce the CSP.
- libmedia never finishes a seek to exactly the duration: its seeks stop 1 s short of the end.
- libmedia reports `currentTime` 0 for about the first second of playback even though frames are showing; the first frame lands ~0.4 s after open (local).
- The JS range reader starts each random access with a 256 KB segment and doubles up to 4 MB on sequential reads (fast start and seeks, few round trips during playback).
- The spool tracks blocks as missing / pending / present, so a request waits for blocks the read-ahead thread is already fetching instead of reading them twice (a test checks every byte is read from the source exactly once during sequential playback).

### Measured (M-series Mac, dev build; 300 MB, 20 Mbit/s H.264/AC-3 MKV)

| | Local | NAS (SMB) |
|---|---|---|
| Open → first frame | ≈ 0.4 s | ≈ 1.2 s cold, ≈ 0.6 s with a warm SMB cache |
| Read-ahead | — | ≈ 9 MB/s (3.5× the stream's bitrate); whole file spooled in ≈ 30 s |
| Seek beyond the buffer | ≈ 0.4 s | ≈ 0.4 s |

## Later

- WMV/ASF (no libmedia demuxer): an ffmpeg remux, or keep handing off with `⌘O`.
- Audio/subtitle track selection for MKV (libmedia has `selectAudio`/`selectSubtitle`), external `.srt` next to the video.
- Prefetch the next video's first megabytes on the NAS.

## Acceptance

- MKV (H.264/HEVC + AAC/AC-3/DTS), AVI (Xvid), MPEG-TS play in the viewer with sound; all media keys work; volume persists.
- MP4/MOV still use the native player.
- WMV shows the "Can't play" card; `⌘O` opens it externally.
- On a NAS file, the header shows the buffer growing ahead of the playhead; pulling the network briefly (or a slow SMB read) doesn't stall playback while buffered data lasts; seeking back is instant.
- The spool directory is empty after closing the viewer.
- Unit tests: range reader (short responses, read-ahead, seeks), engine selection, Rust range parsing and spool (block bitmap, direct reads, read-ahead window, hole punching).
