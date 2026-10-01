// Key maps for the viewer, as pure functions (see step-10-media-viewers.md).
// The shell asks the active view first, then falls back to shellKey.

export type KeyLike = Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey">;

const SEEK_SHORT = 5;
const SEEK_LONG = 60;
export const VOLUME_STEP = 0.05;
export const ZOOM_STEP = 1.25;

const modified = (e: KeyLike) => e.metaKey || e.ctrlKey || e.altKey;

export type ShellAction =
  | { type: "escape" }
  | { type: "close" }
  | { type: "openDefault" }
  | { type: "fullscreen" }
  | { type: "nav"; to: "prev" | "next" | "first" | "last" }
  | { type: "enter" };

/** Keys every viewer understands, when the active view didn't take them. */
export function shellKey(e: KeyLike): ShellAction | null {
  if (e.key === "Escape") return { type: "escape" };
  if (e.key === "F3") return { type: "close" };
  if (e.metaKey && !e.ctrlKey && !e.altKey) {
    if (e.key.toLowerCase() === "o") return { type: "openDefault" };
    if (e.key === "ArrowLeft") return { type: "nav", to: "prev" };
    if (e.key === "ArrowRight") return { type: "nav", to: "next" };
    return null;
  }
  if (modified(e)) return null;
  switch (e.key) {
    case "f":
    case "F":
      return { type: "fullscreen" };
    case "ArrowLeft":
    case "PageUp":
      return { type: "nav", to: "prev" };
    case "ArrowRight":
    case "PageDown":
      return { type: "nav", to: "next" };
    case "Home":
      return { type: "nav", to: "first" };
    case "End":
      return { type: "nav", to: "last" };
    case "Enter":
      return { type: "enter" };
  }
  return null;
}

export type MediaAction =
  | { type: "seek"; by: number }
  | { type: "volume"; by: number }
  | { type: "togglePlay" }
  | { type: "mute" };

/** Video and audio: arrows seek (←/→ 5 s, ↑/↓ 1 min), =/- volume, Space, M. */
export function mediaKey(e: KeyLike): MediaAction | null {
  if (modified(e)) return null;
  switch (e.key) {
    case "ArrowLeft":
      return { type: "seek", by: -SEEK_SHORT };
    case "ArrowRight":
      return { type: "seek", by: SEEK_SHORT };
    case "ArrowUp":
      return { type: "seek", by: SEEK_LONG };
    case "ArrowDown":
      return { type: "seek", by: -SEEK_LONG };
    case "=":
    case "+":
      return { type: "volume", by: VOLUME_STEP };
    case "-":
    case "_":
      return { type: "volume", by: -VOLUME_STEP };
    case " ":
      return { type: "togglePlay" };
    case "m":
    case "M":
      return { type: "mute" };
  }
  return null;
}

export type PdfAction =
  | { type: "scroll"; y: number } // fraction of the viewport height
  | { type: "scrollX"; x: number } // fraction of the viewport width
  | { type: "page"; by: number } // one viewport height
  | { type: "top" }
  | { type: "bottom" }
  | { type: "zoom"; factor: number }
  | { type: "zoomReset" };

/** PDF: arrows scroll (never change file), Space/⇧Space and PageUp/PageDown page, +/-/0 zoom. */
export function pdfKey(e: KeyLike): PdfAction | null {
  if (modified(e)) return null;
  switch (e.key) {
    case "ArrowDown":
      return { type: "scroll", y: 0.1 };
    case "ArrowUp":
      return { type: "scroll", y: -0.1 };
    case "ArrowRight":
      return { type: "scrollX", x: 0.1 };
    case "ArrowLeft":
      return { type: "scrollX", x: -0.1 };
    case " ":
      return { type: "page", by: e.shiftKey ? -1 : 1 };
    case "PageDown":
      return { type: "page", by: 1 };
    case "PageUp":
      return { type: "page", by: -1 };
    case "Home":
      return { type: "top" };
    case "End":
      return { type: "bottom" };
    case "+":
    case "=":
      return { type: "zoom", factor: ZOOM_STEP };
    case "-":
      return { type: "zoom", factor: 1 / ZOOM_STEP };
    case "0":
      return { type: "zoomReset" };
  }
  return null;
}

export type ImageAction = { type: "zoom"; factor: number } | { type: "zoomReset" };

/** Photos: +/-/0 zoom; ←/→ are left to the shell (previous/next photo). */
export function imageKey(e: KeyLike): ImageAction | null {
  if (modified(e)) return null;
  if (e.key === "+" || e.key === "=") return { type: "zoom", factor: ZOOM_STEP };
  if (e.key === "-") return { type: "zoom", factor: 1 / ZOOM_STEP };
  if (e.key === "0") return { type: "zoomReset" };
  return null;
}

export function clampTime(t: number, duration: number): number {
  const max = Number.isFinite(duration) ? duration : Infinity;
  return Math.max(0, Math.min(max, t));
}

export function clampVolume(v: number): number {
  return Math.max(0, Math.min(1, Math.round(v * 100) / 100));
}

/** 75 → "1:15", 3725 → "1:02:05". */
export function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "–:––";
  const s = Math.floor(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

/** A view's key handler: return true when it consumed the key. */
export type KeyHandler = (e: KeyboardEvent) => boolean;
