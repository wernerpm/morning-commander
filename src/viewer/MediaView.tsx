// Video and audio: plays on open with keyboard focus; arrows seek, =/- volume
// (remembered in preferences.json as videoVolume), Space play/pause, M mute.
// Native controls hide after 2 s without mouse movement (video only).

import { createSignal, onCleanup, onMount, Show, type JSX } from "solid-js";
import { prefs, updatePrefs } from "../app/settings";
import { clampTime, clampVolume, formatTime, mediaKey, type KeyHandler, type MediaAction } from "./keys";

const OVERLAY_MS = 1200;
const CONTROLS_IDLE_MS = 2000;
const SAVE_DEBOUNCE_MS = 500;

export default function MediaView(props: {
  url: string;
  name: string;
  video: boolean;
  register: (h: KeyHandler) => void;
  onError: () => void;
}): JSX.Element {
  let el!: HTMLMediaElement;
  const [overlay, setOverlay] = createSignal<{ text: string; volume?: number } | null>(null);
  const [controls, setControls] = createSignal(true);
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

  // Any volume change (keys or the native slider) is saved after a short pause.
  const onVolumeChange = () => {
    pendingVolume = clampVolume(el.volume);
    clearTimeout(saveTimer);
    saveTimer = window.setTimeout(saveVolume, SAVE_DEBOUNCE_MS);
  };

  const apply = (a: MediaAction) => {
    switch (a.type) {
      case "seek": {
        const t = clampTime(el.currentTime + a.by, el.duration);
        el.currentTime = t;
        const sign = a.by > 0 ? "+" : "−";
        const step = Math.abs(a.by) >= 60 ? `${Math.abs(a.by) / 60} min` : `${Math.abs(a.by)} s`;
        show(`${sign}${step}   ${formatTime(t)} / ${formatTime(el.duration)}`);
        break;
      }
      case "volume": {
        const v = clampVolume(el.volume + a.by);
        el.volume = v;
        if (el.muted && a.by > 0) el.muted = false;
        show(`Volume ${Math.round(v * 100)}%`, v);
        break;
      }
      case "togglePlay":
        if (el.paused) void el.play().catch(() => {});
        else el.pause();
        show(el.paused ? "Paused" : "Playing");
        break;
      case "mute":
        el.muted = !el.muted;
        show(el.muted ? "Muted" : "Sound on", el.muted ? 0 : el.volume);
        break;
    }
  };

  props.register((e) => {
    const a = mediaKey(e);
    if (!a) return false;
    apply(a);
    return true;
  });

  onMount(() => {
    el.volume = clampVolume(prefs().videoVolume);
    el.focus();
    void el.play().catch(() => {}); // autoplay may be refused; the element keeps focus either way
    wakeControls();
  });
  onCleanup(() => {
    clearTimeout(overlayTimer);
    clearTimeout(controlsTimer);
    saveVolume();
    el.pause();
  });

  const common = {
    src: props.url,
    tabIndex: -1,
    autoplay: true,
    onError: props.onError,
    onVolumeChange,
  };

  return (
    <div class="viewer-media" classList={{ audio: !props.video }} onMouseMove={wakeControls}>
      <Show
        when={props.video}
        fallback={
          <>
            <div class="viewer-audio-name">{props.name}</div>
            <audio ref={(a) => (el = a)} {...common} controls />
          </>
        }
      >
        <video ref={(v) => (el = v)} class="viewer-video" {...common} controls={controls()} />
      </Show>
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
