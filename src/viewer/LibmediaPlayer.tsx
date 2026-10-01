// libmedia engine for MediaView: plays containers and codecs WebKit can't
// (MKV, AVI, MPEG-TS, AC-3, DTS, Xvid…) with WASM demuxers/decoders and
// WebCodecs hardware decoding. libmedia draws into our container; the control
// bar is ours because there is no native one.

import { createSignal, onCleanup, onMount, Show, type JSX } from "solid-js";
import { prefs } from "../app/settings";
import { clampVolume, formatTime } from "./keys";
import { extension } from "./kind";
import { libmediaBase, loadAVPlayer, type AVPlayer } from "./libmedia";
import type { Playback } from "./MediaView";
import { rangeIOLoader } from "./rangeLoader";

const END_MARGIN_S = 1;

export default function LibmediaPlayer(props: {
  url: string;
  name: string;
  video: boolean;
  controls: boolean;
  onReady: (p: Playback) => void;
  onError: (message?: string) => void;
}): JSX.Element {
  let box!: HTMLDivElement;
  let root!: HTMLDivElement;
  let player: AVPlayer | undefined;
  let disposed = false;

  const [loaded, setLoaded] = createSignal(false);
  const [time, setTime] = createSignal(0);
  const [duration, setDuration] = createSignal(NaN);
  const [paused, setPaused] = createSignal(true);
  let ended = false;
  let volume = clampVolume(prefs().videoVolume);
  let muted = false;
  /** Target of a seek in flight: libmedia's clock only moves once it lands. */
  let seekTarget: number | null = null;

  const applyVolume = () => player?.setVolume(muted ? 0 : volume);

  const seek = (to: number) => {
    if (!player) return;
    // A seek to the very end never completes in libmedia: stop just short of it.
    const d = duration();
    const t = d > END_MARGIN_S ? Math.min(to, d - END_MARGIN_S) : to;
    seekTarget = t;
    setTime(t);
    ended = false;
    void player.seek(BigInt(Math.round(t * 1000))).finally(() => {
      if (seekTarget === t) seekTarget = null;
    });
  };

  const play = () => {
    if (!player) return;
    if (ended) {
      ended = false;
      seek(0);
    }
    if (player.isSuspended()) void player.resume();
    void player.play().catch((e) => console.warn("libmedia play:", e));
    setPaused(false);
  };

  const pause = () => {
    if (!player) return;
    void player.pause();
    setPaused(true);
  };

  onMount(async () => {
    try {
      const AVPlayer = await loadAVPlayer();
      if (disposed) return;
      const p = new AVPlayer({
        container: box,
        wasmBaseUrl: libmediaBase(),
        enableHardware: true,
        enableWebCodecs: true,
        // Workers in WKWebView can't load anything from the app's tauri:// scheme
        // (fetch/importScripts fail), and libmedia's workers load chunks and WASM
        // by URL. On the main thread the decoders still run off-thread where it
        // matters: WebCodecs decodes video in hardware.
        enableWorker: false,
      });
      player = p;
      if (import.meta.env.DEV) (window as unknown as { __mcLibmedia: unknown }).__mcLibmedia = p;
      p.on("time", (pts: bigint) => {
        if (seekTarget === null) setTime(Number(pts) / 1000);
      });
      p.on("played", () => setPaused(false));
      p.on("paused", () => setPaused(true));
      p.on("ended", () => {
        ended = true;
        setPaused(true);
      });
      p.on("error", (e: Error) => props.onError(String(e?.message ?? e)));

      await p.load(rangeIOLoader(AVPlayer, props.url, extension(props.name)));
      if (disposed) return;
      setDuration(Number(p.getDuration()) / 1000 || NaN);
      applyVolume();
      setLoaded(true);
      setPaused(false); // autoplay below: Space from here on means pause
      props.onReady({
        get paused() {
          return paused();
        },
        get currentTime() {
          return seekTarget ?? time();
        },
        get duration() {
          return duration();
        },
        get volume() {
          return volume;
        },
        set volume(v) {
          volume = v;
          applyVolume();
        },
        get muted() {
          return muted;
        },
        set muted(m) {
          muted = m;
          applyVolume();
        },
        play,
        pause,
        seek,
        focus: () => root.focus(),
      });
      await p.play();
    } catch (e) {
      if (!disposed) {
        console.warn("libmedia:", e);
        props.onError();
      }
    }
  });

  onCleanup(() => {
    disposed = true;
    void player?.destroy().catch(() => {});
    player = undefined;
  });

  const progress = () => {
    const d = duration();
    return d > 0 ? Math.min(1, time() / d) : 0;
  };

  // Click/drag on the bar seeks.
  const seekFromPointer = (e: PointerEvent) => {
    const bar = e.currentTarget as HTMLElement;
    const r = bar.getBoundingClientRect();
    const d = duration();
    if (!(d > 0) || r.width === 0) return;
    seek(Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * d);
  };

  return (
    <div class="viewer-libmedia" classList={{ audio: !props.video }} ref={root} tabIndex={-1}>
      <div class="viewer-libmedia-canvas" ref={box} classList={{ hidden: !props.video }} />
      <Show when={!loaded()}>
        <div class="viewer-status">Loading…</div>
      </Show>
      <div
        class="viewer-controls"
        classList={{ hidden: !props.controls || !loaded() }}
        onPointerDown={(e) => e.stopPropagation()}
      >
        <button
          class="viewer-controls-play"
          tabIndex={-1}
          aria-label={paused() ? "Play" : "Pause"}
          onClick={() => (paused() ? play() : pause())}
        >
          {paused() ? "▶" : "❚❚"}
        </button>
        <span class="viewer-controls-time">
          {formatTime(time())} / {formatTime(duration())}
        </span>
        <div
          class="viewer-controls-bar"
          role="slider"
          aria-label="Seek"
          aria-valuemin={0}
          aria-valuemax={duration() || 0}
          aria-valuenow={time()}
          onPointerDown={(e) => {
            (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
            seekFromPointer(e);
          }}
          onPointerMove={(e) => {
            if (e.buttons & 1) seekFromPointer(e);
          }}
        >
          <div class="viewer-controls-fill" style={{ width: `${progress() * 100}%` }} />
        </div>
      </div>
    </div>
  );
}
