// Video and audio: plays on open with keyboard focus; arrows seek, =/- volume
// (remembered in preferences.json as videoVolume), Space play/pause, M mute.
// Controls hide after 2 s without mouse movement (video only).
//
// Two engines behind one `Playback` interface (step 12):
// - native: <video>/<audio> (WebKit/AVFoundation) with native controls;
// - libmedia: WASM/WebCodecs player for MKV, AVI, MPEG-TS… with our own control bar.
// A native decode error switches to libmedia once; a libmedia error is reported.

import { createSignal, Match, onCleanup, onMount, Show, Switch, type JSX } from "solid-js";
import { prefs, updatePrefs } from "../app/settings";
import { clampTime, clampVolume, formatTime, mediaKey, type KeyHandler, type MediaAction } from "./keys";
import type { MediaEngine } from "./kind";
import LibmediaPlayer from "./LibmediaPlayer";

const OVERLAY_MS = 1200;
const CONTROLS_IDLE_MS = 2000;
const SAVE_DEBOUNCE_MS = 500;

/** What the view needs from a player. Times are in seconds. */
export interface Playback {
  readonly paused: boolean;
  readonly currentTime: number;
  /** NaN while unknown. */
  readonly duration: number;
  volume: number;
  muted: boolean;
  play(): void;
  pause(): void;
  seek(t: number): void;
  focus(): void;
}

export default function MediaView(props: {
  url: string;
  name: string;
  video: boolean;
  engine: MediaEngine;
  register: (h: KeyHandler) => void;
  onError: (message?: string) => void;
}): JSX.Element {
  const [engine, setEngine] = createSignal(props.engine);
  const [overlay, setOverlay] = createSignal<{ text: string; volume?: number } | null>(null);
  const [controls, setControls] = createSignal(true);
  let pb: Playback | undefined;
  let overlayTimer: number | undefined;
  let controlsTimer: number | undefined;
  let saveTimer: number | undefined;
  let pendingVolume: number | null = null;

  const show = (text: string, volume?: number) => {
    setOverlay({ text, volume });
    clearTimeout(overlayTimer);
    overlayTimer = window.setTimeout(() => setOverlay(null), OVERLAY_MS);
  };

  const wakeControls = () => {
    if (!props.video) return;
    setControls(true);
    clearTimeout(controlsTimer);
    controlsTimer = window.setTimeout(() => setControls(false), CONTROLS_IDLE_MS);
  };

  const saveVolume = () => {
    clearTimeout(saveTimer);
    saveTimer = undefined;
    if (pendingVolume !== null && pendingVolume !== prefs().videoVolume) {
      void updatePrefs({ videoVolume: pendingVolume });
    }
    pendingVolume = null;
  };

  // Any volume change (keys or a slider) is saved after a short pause.
  const noteVolume = (v: number) => {
    pendingVolume = clampVolume(v);
    clearTimeout(saveTimer);
    saveTimer = window.setTimeout(saveVolume, SAVE_DEBOUNCE_MS);
  };

  const apply = (p: Playback, a: MediaAction) => {
    switch (a.type) {
      case "seek": {
        const t = clampTime(p.currentTime + a.by, p.duration);
        p.seek(t);
        const sign = a.by > 0 ? "+" : "−";
        const step = Math.abs(a.by) >= 60 ? `${Math.abs(a.by) / 60} min` : `${Math.abs(a.by)} s`;
        show(`${sign}${step}   ${formatTime(t)} / ${formatTime(p.duration)}`);
        break;
      }
      case "volume": {
        const v = clampVolume(p.volume + a.by);
        p.volume = v;
        if (p.muted && a.by > 0) p.muted = false;
        noteVolume(v);
        show(`Volume ${Math.round(v * 100)}%`, v);
        break;
      }
      case "togglePlay":
        if (p.paused) p.play();
        else p.pause();
        show(p.paused ? "Paused" : "Playing");
        break;
      case "mute":
        p.muted = !p.muted;
        show(p.muted ? "Muted" : "Sound on", p.muted ? 0 : p.volume);
        break;
    }
  };

  props.register((e) => {
    const a = mediaKey(e);
    if (!a) return false;
    if (pb) apply(pb, a);
    return true; // keys belong to the player even while it is still loading
  });

  const ready = (p: Playback) => {
    pb = p;
    p.focus();
    wakeControls();
  };

  const engineFailed = (message?: string) => {
    pb = undefined;
    if (engine() === "native") setEngine("libmedia");
    else props.onError(message);
  };

  onCleanup(() => {
    clearTimeout(overlayTimer);
    clearTimeout(controlsTimer);
    saveVolume();
  });

  return (
    <div class="viewer-media" classList={{ audio: !props.video }} onMouseMove={wakeControls}>
      <Show when={!props.video}>
        <div class="viewer-audio-name">{props.name}</div>
      </Show>
      <Switch>
        <Match when={engine() === "native"}>
          <NativePlayer
            url={props.url}
            video={props.video}
            controls={controls()}
            onReady={ready}
            onError={() => engineFailed()}
            onVolume={noteVolume}
          />
        </Match>
        <Match when={engine() === "libmedia"}>
          <LibmediaPlayer
            url={props.url}
            name={props.name}
            video={props.video}
            controls={controls() || !props.video}
            onReady={ready}
            onError={engineFailed}
          />
        </Match>
      </Switch>
      <Show when={overlay()}>
        {(o) => (
          <div class="viewer-overlay" role="status">
            <div>{o().text}</div>
            <Show when={o().volume !== undefined}>
              <div class="viewer-overlay-bar">
                <div style={{ width: `${Math.round(o().volume! * 100)}%` }} />
              </div>
            </Show>
          </div>
        )}
      </Show>
    </div>
  );
}

function NativePlayer(props: {
  url: string;
  video: boolean;
  controls: boolean;
  onReady: (p: Playback) => void;
  onError: () => void;
  onVolume: (v: number) => void;
}): JSX.Element {
  let el!: HTMLMediaElement;

  onMount(() => {
    el.volume = clampVolume(prefs().videoVolume);
    props.onReady({
      get paused() {
        return el.paused;
      },
      get currentTime() {
        return el.currentTime;
      },
      get duration() {
        return el.duration;
      },
      get volume() {
        return el.volume;
      },
      set volume(v) {
        el.volume = v;
      },
      get muted() {
        return el.muted;
      },
      set muted(m) {
        el.muted = m;
      },
      play: () => void el.play().catch(() => {}),
      pause: () => el.pause(),
      seek: (t) => {
        el.currentTime = t;
      },
      focus: () => el.focus(),
    });
    void el.play().catch(() => {}); // autoplay may be refused; the element keeps focus either way
  });
  onCleanup(() => el.pause());

  const common = {
    src: props.url,
    tabIndex: -1,
    autoplay: true,
    onError: props.onError,
    onVolumeChange: () => props.onVolume(el.volume),
  };

  return (
    <Show when={props.video} fallback={<audio ref={(a) => (el = a)} {...common} controls />}>
      <video ref={(v) => (el = v)} class="viewer-video" {...common} controls={props.controls} />
    </Show>
  );
}
