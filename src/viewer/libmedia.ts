// Loads the libmedia player at runtime from public/libmedia/ (see
// scripts/fetch-libmedia.mjs for why it doesn't go through Vite).

import type AVPlayerClass from "@libmedia/avplayer";

export type AVPlayer = AVPlayerClass;
export type AVPlayerModule = typeof AVPlayerClass;

const BASE = "/libmedia";
let loading: Promise<AVPlayerModule> | undefined;

export function libmediaBase(): string {
  return `${location.origin}${BASE}`;
}

export function loadAVPlayer(): Promise<AVPlayerModule> {
  loading ??= import(/* @vite-ignore */ `${libmediaBase()}/avplayer/avplayer.js`).then(
    (m: { default: AVPlayerModule }) => m.default,
    (e) => {
      loading = undefined;
      throw e;
    },
  );
  return loading;
}
