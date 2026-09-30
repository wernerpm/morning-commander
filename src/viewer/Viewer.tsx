// Full-window viewer for images, PDFs, video, audio and text.
// See docs/implementation-plan/step-5-viewer.md.

import {
  createEffect, createMemo, createResource, createSignal, Match, on, onCleanup, onMount, Show, Switch,
  type JSX,
} from "solid-js";
import { backend } from "../ipc";
import type { TextPreview } from "../ipc/types";
import { viewKind, type ViewKind } from "./kind";
import "./viewer.css";

export interface ViewerProps {
  files: string[];
  index: number;
  onClose: (lastPath: string) => void;
}

const TEXT_MAX = 5 * 1024 * 1024;
const SNIFF_MAX = 64 * 1024;
const SEEK_SECONDS = 5;
const ZOOM_STEP = 1.25;

function baseName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = bytes / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

function clamp(i: number, len: number): number {
  return Math.max(0, Math.min(len - 1, i));
}

export default function Viewer(props: ViewerProps): JSX.Element {
  const [index, setIndex] = createSignal(clamp(props.index, props.files.length));
  const path = () => props.files[index()] ?? "";
  const name = () => baseName(path());
  const kind = createMemo<ViewKind>(() => viewKind(name()));

  // Per-file state, reset whenever the file changes.
  const [mediaError, setMediaError] = createSignal(false);
  const [zoom, setZoom] = createSignal<number | null>(null); // null = fit to window
  createEffect(on(path, () => {
    setMediaError(false);
    setZoom(null);
  }));

  // Text for "text" files, and a sniff for "other" files.
  const [text] = createResource(
    () => (kind() === "text" || kind() === "other" ? { path: path(), kind: kind() } : false),
    async ({ path, kind }): Promise<TextPreview | { error: string }> => {
      try {
        return await backend.readText(path, kind === "text" ? TEXT_MAX : SNIFF_MAX);
      } catch (e) {
        return { error: String(e) };
      }
    },
  );
  const preview = () => {
    const t = text();
    return t && !("error" in t) ? t : undefined;
  };
  const size = () => preview()?.size;

  let root!: HTMLDivElement;
  let media: HTMLMediaElement | undefined;
  let img: HTMLImageElement | undefined;
  let scroller: HTMLDivElement | undefined;

  const openDefault = () => {
    if (path()) void backend.openDefault(path());
  };
  const close = () => props.onClose(path());
  const go = (i: number) => {
    if (props.files.length) setIndex(clamp(i, props.files.length));
  };

  // Enter opens the file externally when we can't show it ourselves.
  const showsFallback = () =>
    mediaError() || (kind() === "other" && !!preview()?.binary) || (!!text() && "error" in text()!);

  const zoomBy = (factor: number) => {
    if (!img || !img.naturalWidth) return;
    const current = zoom() ?? img.clientWidth / img.naturalWidth;
    setZoom(Math.min(32, Math.max(0.05, current * factor)));
  };

  const onKey = (e: KeyboardEvent) => {
    const k = kind();
    const mediaFocused = !!media && document.activeElement === media;
    let handled = true;

    if (e.key === "Escape" || e.key === "F3") close();
    else if (e.metaKey && e.key.toLowerCase() === "o") openDefault();
    else if (e.metaKey || e.ctrlKey || e.altKey) handled = false;
    else if ((k === "video" || k === "audio") && media && e.key === " ") {
      if (media.paused) void media.play();
      else media.pause();
    } else if (mediaFocused && (e.key === "ArrowLeft" || e.key === "ArrowRight")) {
      media!.currentTime = Math.max(0, media!.currentTime + (e.key === "ArrowLeft" ? -SEEK_SECONDS : SEEK_SECONDS));
    } else if (e.key === "ArrowLeft" || e.key === "PageUp") go(index() - 1);
    else if (e.key === "ArrowRight" || e.key === "PageDown") go(index() + 1);
    else if (e.key === "Home") go(0);
    else if (e.key === "End") go(props.files.length - 1);
    else if (e.key === "Enter" && showsFallback()) openDefault();
    else if (k === "image" && (e.key === "+" || e.key === "=")) zoomBy(ZOOM_STEP);
    else if (k === "image" && e.key === "-") zoomBy(1 / ZOOM_STEP);
    else if (k === "image" && e.key === "0") setZoom(null);
    else handled = false;

    if (handled) {
      e.preventDefault();
      e.stopImmediatePropagation();
    } else if (!mediaFocused) {
      // Keep keys away from the panels underneath, but let the browser's
      // default action (e.g. scrolling the text view) happen. Native media
      // controls still get keys while the media element is focused.
      e.stopImmediatePropagation();
    }
  };

  onMount(() => {
    window.addEventListener("keydown", onKey, true);
    root.focus();
  });
  onCleanup(() => {
    window.removeEventListener("keydown", onKey, true);
    (document.activeElement as HTMLElement | null)?.blur?.();
    document.body.focus();
  });

  // Keep keyboard focus in our document: iframes (PDF) and media grab it.
  const reclaimFocus = () => {
    if (document.activeElement instanceof HTMLIFrameElement) document.activeElement.blur();
    (scroller ?? root).focus();
  };
  createEffect(on(path, () => queueMicrotask(reclaimFocus)));

  const onMediaRef = (el: HTMLMediaElement) => {
    media = el;
    onCleanup(() => {
      if (media === el) media = undefined;
    });
  };

  const hint = () => {
    const common = "Esc close · ←/→ prev/next · ⌘O open with default app";
    switch (kind()) {
      case "image": return `${common} · +/− zoom · 0 fit`;
      case "video":
      case "audio": return `${common} · Space play/pause · click player then ←/→ seek`;
      default: return common;
    }
  };

  return (
    <div class="viewer" ref={root} tabIndex={-1} role="dialog" aria-label={`Viewer: ${name()}`}>
      <header class="viewer-header">
        <span class="viewer-name" title={path()}>{name() || "No files"}</span>
        <span class="viewer-meta">
          <Show when={size() !== undefined}>{formatSize(size()!)} · </Show>
          {props.files.length ? `${index() + 1} / ${props.files.length}` : ""}
        </span>
        <button class="viewer-close" onClick={close} aria-label="Close viewer">✕</button>
      </header>

      <div class="viewer-body">
        <Show when={path()} keyed>
          {(p) => (
            <Switch>
              <Match when={mediaError()}>
                <FallbackCard
                  title={kind() === "image" ? "Can't display this image" : "Can't play this format"}
                  name={name()}
                  onOpen={openDefault}
                />
              </Match>

              <Match when={kind() === "image"}>
                <div class="viewer-image" classList={{ zoomed: zoom() !== null }}>
                  <img
                    ref={img}
                    src={backend.fileUrl(p)}
                    alt={name()}
                    draggable={false}
                    style={zoom() !== null && img ? { width: `${img.naturalWidth * zoom()!}px` } : undefined}
                    onError={() => setMediaError(true)}
                  />
                </div>
              </Match>

              <Match when={kind() === "pdf"}>
                <iframe class="viewer-pdf" src={backend.fileUrl(p)} title={name()} onLoad={reclaimFocus} />
              </Match>

              <Match when={kind() === "video"}>
                <video
                  ref={onMediaRef}
                  class="viewer-video"
                  src={backend.fileUrl(p)}
                  controls
                  autoplay
                  onError={() => setMediaError(true)}
                />
              </Match>

              <Match when={kind() === "audio"}>
                <div class="viewer-audio">
                  <div class="viewer-audio-name">{name()}</div>
                  <audio ref={onMediaRef} src={backend.fileUrl(p)} controls autoplay onError={() => setMediaError(true)} />
                </div>
              </Match>

              <Match when={text.loading}>
                <div class="viewer-status">Loading…</div>
              </Match>

              <Match when={text() && "error" in text()!}>
                <FallbackCard
                  title="Can't read this file"
                  detail={(text() as { error: string }).error}
                  name={name()}
                  onOpen={openDefault}
                />
              </Match>

              <Match when={preview()?.binary}>
                <FallbackCard title="No preview" name={name()} size={preview()!.size} onOpen={openDefault} />
              </Match>

              <Match when={preview()}>
                <TextView
                  preview={preview()!}
                  ref={(el) => {
                    scroller = el;
                    onCleanup(() => {
                      if (scroller === el) scroller = undefined;
                    });
                    queueMicrotask(() => el.focus());
                  }}
                />
              </Match>
            </Switch>
          )}
        </Show>
      </div>

      <footer class="viewer-hint">{hint()}</footer>
    </div>
  );
}

function FallbackCard(props: { title: string; name: string; size?: number; detail?: string; onOpen: () => void }) {
  return (
    <div class="viewer-card">
      <div class="viewer-card-title">{props.title}</div>
      <div class="viewer-card-name">{props.name}</div>
      <Show when={props.size !== undefined}>
        <div class="viewer-card-detail">{formatSize(props.size!)}</div>
      </Show>
      <Show when={props.detail}>
        <div class="viewer-card-detail">{props.detail}</div>
      </Show>
      <button class="viewer-card-open" onClick={props.onOpen}>
        Open with default app <kbd>⌘O</kbd> <kbd>Enter</kbd>
      </button>
    </div>
  );
}

// One text node for the content and one for the gutter, so even a 5 MB file
// is only a handful of DOM nodes.
function TextView(props: { preview: TextPreview; ref: (el: HTMLDivElement) => void }) {
  const gutter = createMemo(() => {
    let lines = 1;
    const t = props.preview.text;
    for (let i = 0; i < t.length; i++) if (t.charCodeAt(i) === 10) lines++;
    if (t.endsWith("\n")) lines--;
    const out: string[] = new Array(Math.max(lines, 1));
    for (let i = 0; i < out.length; i++) out[i] = String(i + 1);
    return out.join("\n");
  });

  return (
    <div class="viewer-text" ref={props.ref} tabIndex={-1}>
      <Show when={props.preview.truncated}>
        <div class="viewer-truncated">
          Showing the first {formatSize(props.preview.text.length)} of {formatSize(props.preview.size)}
        </div>
      </Show>
      <div class="viewer-text-grid">
        <pre class="viewer-gutter" aria-hidden="true">{gutter()}</pre>
        <pre class="viewer-code">{props.preview.text}</pre>
      </div>
    </div>
  );
}
