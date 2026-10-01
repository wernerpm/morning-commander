#!/usr/bin/env node
// Puts the libmedia player into public/libmedia/ (gitignored):
// - avplayer/: the package's prebuilt ESM bundle, copied from node_modules. It
//   lazy-loads its own chunks relative to import.meta.url, so it can't go through
//   Vite (pre-bundling and Rollup both break those paths); the app import()s it at
//   runtime instead (src/viewer/libmedia.ts).
// - decode/, resample/, stretchpitch/: WebAssembly decoders, downloaded pinned to
//   the installed @libmedia/avplayer version and checked against
//   scripts/libmedia-wasm.sha256.
//
//   node scripts/fetch-libmedia.mjs           copy the bundle, fetch missing wasm, verify all
//   node scripts/fetch-libmedia.mjs --update  re-download and rewrite the checksum list
//
// Runs before `pnpm dev` and `pnpm build`. Only the SIMD builds are fetched:
// WKWebView on macOS 13+ supports wasm SIMD, so libmedia always picks them.

import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(root, "public", "libmedia");
const sumsFile = join(root, "scripts", "libmedia-wasm.sha256");
const update = process.argv.includes("--update");

const { version } = JSON.parse(
  readFileSync(join(root, "node_modules", "@libmedia", "avplayer", "package.json"), "utf8"),
);
const base = `https://cdn.jsdelivr.net/gh/zhaohappy/libmedia@${version}/dist`;

const DECODERS = [
  // video
  "h264", "hevc", "mpeg4", "msmpeg4", "mpeg2video", "h263", "vp8", "vp9", "av1", "wmv", "mjpeg", "theora",
  // audio
  "aac", "ac3", "eac3", "dca", "mp3", "opus", "vorbis", "flac", "wma", "pcm", "adpcm",
];
const FILES = [
  ...DECODERS.map((d) => `decode/${d}-simd.wasm`),
  "resample/resample-simd.wasm",
  "stretchpitch/stretchpitch-simd.wasm",
];

const pkgDist = join(root, "node_modules", "@libmedia", "avplayer", "dist", "esm");
rmSync(join(outDir, "avplayer"), { recursive: true, force: true });
cpSync(pkgDist, join(outDir, "avplayer"), { recursive: true });
// libmedia is LGPL-3.0-or-later: ship its licence next to the unmodified files.
cpSync(join(pkgDist, "..", "..", "COPYING.LGPLv3"), join(outDir, "COPYING.LGPLv3"));

const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

const expected = new Map();
if (existsSync(sumsFile) && !update) {
  for (const line of readFileSync(sumsFile, "utf8").split("\n")) {
    const [hash, file] = line.trim().split(/\s+/);
    if (hash && file) expected.set(file, hash);
  }
}

const sums = [];
let fetched = 0;
for (const file of FILES) {
  const dest = join(outDir, file);
  let buf = !update && existsSync(dest) ? readFileSync(dest) : null;
  if (buf && expected.has(file) && sha256(buf) !== expected.get(file)) buf = null;
  if (!buf) {
    const res = await fetch(`${base}/${file}`);
    if (!res.ok) throw new Error(`${file}: HTTP ${res.status}`);
    buf = Buffer.from(await res.arrayBuffer());
    const want = expected.get(file);
    if (want && sha256(buf) !== want) throw new Error(`${file}: checksum mismatch`);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, buf);
    fetched++;
  }
  sums.push(`${sha256(buf)}  ${file}`);
}

if (update || expected.size === 0) writeFileSync(sumsFile, `${sums.join("\n")}\n`);
if (fetched) console.log(`libmedia ${version}: fetched ${fetched} wasm file(s) into public/libmedia/`);
