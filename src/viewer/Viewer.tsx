// Full-window viewer shell: header, file-to-file navigation by kind, fullscreen,
// and one of the per-type views. See docs/implementation-plan/step-10-media-viewers.md.
//
// One capture-phase key listener asks the active view first (its handleKey),
// then falls back to the shell keys: Esc, F3, ⌘O, F, ⌘←/⌘→, and plain
// ←/→/PageUp/PageDown/Home/End when the view doesn't use them.

import {
  createEffect, createMemo, createResource, createSignal, Match, on, onCleanup, onMount, Show, Switch,
  type JSX,
} from "solid-js";
import { backend } from "../ipc";
import type { MediaStatus, TextPreview } from "../ipc/types";
import { formatSize } from "./format";
import ImageView from "./ImageView";
import InfoCard from "./InfoCard";
import { extension, mediaEngine, navGroup, stepInGroup, viewKind, type NavGroup, type ViewKind } from "./kind";
import { shellKey, type KeyHandler } from "./keys";
import MediaView from "./MediaView";
import PdfView from "./PdfView";
import TextView from "./TextView";
import "./viewer.css";

export interface ViewerProps {
  files: string[];
  index: number;
  onClose: (lastPath: string) => void;
}

const TEXT_MAX = 5 * 1024 * 1024;
// Leaving macOS fullscreen is an animated Space switch, after which the webview
// is no longer first responder: keys go nowhere, even after ⌘Tab, until a click.
// Re-focus the window and webview a few times while the animation settles.
const REFOCUS_DELAYS_MS = [0, 300, 800];
const SNIFF_MAX = 64 * 1024;
const MEDIA_STATUS_MS = 1000;

const GROUP_NOUN: Record<NavGroup, string> = {
  image: "photos",
  video: "videos",
  audio: "audio files",
  pdf: "PDFs",
  document: "files",
};

function baseName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

/** Header text for a network file's read-ahead buffer. */
export function bufferText(st: MediaStatus): string {
  if (st.size > 0 && st.cached >= st.size) return "fully buffered";
  return `${formatSize(st.ahead)} buffered`;
}

function clamp(i: number, len: number): number {
  return Math.max(0, Math.min(len - 1, i));
}

export default function Viewer(props: ViewerProps): JSX.Element {
  const [index, setIndex] = createSignal(clamp(props.index, props.files.length));
  const path = () => props.files[index()] ?? "";
  const name = () => baseName(path());
  const kind = createMemo<ViewKind>(() => viewKind(name()));
  const groups = createMemo(() => props.files.map((f) => navGroup(viewKind(baseName(f)))));

  // Per-file state, reset whenever the file changes.
  const [error, setError] = createSignal<string | null>(null);
  const [status, setStatus] = createSignal("");
  let viewKeys: KeyHandler | undefined;
  createEffect(on(path, () => {
    setError(null);
    setStatus("");
    // Views focus themselves on mount; if the old view took focus with it, keep it in the viewer.
    queueMicrotask(() => {
      if (!root.contains(document.activeElement)) root.focus();
    });
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

  // Video/audio (and .ts files that turn out to be MPEG-TS) play from media://.
  // On network volumes Rust reads ahead into a spool: show how much is buffered,
  // and drop the spool when the viewer leaves the file.
  const playsMedia = () =>
    kind() === "video" || kind() === "audio" || (extension(name()) === "ts" && !!preview()?.binary);
  const [buffer, setBuffer] = createSignal("");
  createEffect(() => {
    const p = path();
    if (!p || !playsMedia()) return;
    const poll = () =>
      backend.mediaStatus(p).then(
        (st) => setBuffer(st.network ? bufferText(st) : ""),
        () => {},
      );
    void poll();
    const timer = window.setInterval(poll, MEDIA_STATUS_MS);
    onCleanup(() => {
      clearInterval(timer);
      setBuffer("");
      backend.mediaClose(p).catch((err) => console.warn("media close:", err));
    });
  });

  const [fullscreen, setFullscreenSignal] = createSignal(false);
  /** After leaving fullscreen: focus the window, then the element that had focus (or the viewer). */
  const restoreFocus = () => {
    const target = document.activeElement;
    for (const ms of REFOCUS_DELAYS_MS) {
      window.setTimeout(() => {
        backend.focusWindow().catch((err) => console.warn("focus:", err));
        if (!root.isConnected) return; // viewer closed: the panels take focus
        const el = target instanceof HTMLElement && root.contains(target) ? target : root;
        if (document.activeElement !== el) el.focus();
      }, ms);
    }
  };
  const setFullscreen = (on: boolean) => {
    setFullscreenSignal(on);
    backend.setFullscreen(on).then(
      () => !on && restoreFocus(),
      (err) => console.warn("fullscreen:", err),
    );
  };
  // The window can also leave fullscreen without us (green button, Mission Control).
  const syncFullscreen = () =>
    void backend.isFullscreen().then((on) => {
      const left = fullscreen() && !on;
      setFullscreenSignal(on);
      if (left) restoreFocus();
    }, () => {});

  let root!: HTMLDivElement;

  const openDefault = () => {
    if (path()) void backend.openDefault(path());
  };
  const close = () => {
    if (fullscreen()) setFullscreen(false);
    props.onClose(path());
  };
  const nav = (to: "prev" | "next" | "first" | "last") => {
    const i = stepInGroup(groups(), index(), to);
    if (i !== index()) setIndex(i);
  };

  // Enter opens the file externally when we can't show it ourselves.
  const showsFallback = () =>
    !!error() || (kind() === "other" && !!preview()?.binary) || (!!text() && "error" in text()!);

  const onKey = (e: KeyboardEvent) => {
    let handled = e.key !== "Escape" && !!viewKeys?.(e);
    if (!handled) {
      const a = shellKey(e);
      handled = true;
      if (!a) handled = false;
      else if (a.type === "escape") {
        if (fullscreen()) setFullscreen(false);
        else close();
      } else if (a.type === "close") close();
      else if (a.type === "openDefault") openDefault();
      else if (a.type === "fullscreen") setFullscreen(!fullscreen());
      else if (a.type === "nav") nav(a.to);
      else if (a.type === "enter" && showsFallback()) openDefault();
      else handled = false;
    }

    if (handled) {
      e.preventDefault();
      e.stopImmediatePropagation();
    } else {
      // Keep keys away from the panels underneath, but let the browser's
      // default action (e.g. scrolling the text view) happen.
      e.stopImmediatePropagation();
    }
  };

  onMount(() => {
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("resize", syncFullscreen);
    syncFullscreen();
    root.focus();
  });
  onCleanup(() => {
    window.removeEventListener("keydown", onKey, true);
    window.removeEventListener("resize", syncFullscreen);
    (document.activeElement as HTMLElement | null)?.blur?.();
    document.body.focus();
  });

  const position = () => {
    const g = groups();
    const mine = g[index()];
    if (mine === undefined) return "";
    let pos = 0;
    let total = 0;
    for (let i = 0; i < g.length; i++) {
      if (g[i] !== mine) continue;
      total++;
      if (i <= index()) pos = total;
    }
    return `${pos} / ${total} ${GROUP_NOUN[mine]}`;
  };

  const hint = () => {
    const tail = "F fullscreen · ⌘O open with default app · Esc close";
    switch (kind()) {
      case "image": return `←/→ previous/next photo · +/− zoom · 0 fit · ${tail}`;
      case "video":
      case "audio": return `←/→ ±5 s · ↑/↓ ±1 min · =/− volume · Space play/pause · M mute · ⌘←/⌘→ previous/next · ${tail}`;
      case "pdf": return `↑/↓ scroll · Space/⇧Space page · Home/End · +/− zoom · ⌘←/⌘→ previous/next PDF · ${tail}`;
      default: return `←/→ previous/next file · ${tail}`;
    }
  };

  const register = (h: KeyHandler) => {
    viewKeys = h;
    onCleanup(() => {
      if (viewKeys === h) viewKeys = undefined;
    });
  };
  const onMediaError = () => setError("unsupported");

  return (
    <div
      class="viewer"
      classList={{ fullscreen: fullscreen() }}
      ref={root}
      tabIndex={-1}
      role="dialog"
      aria-label={`Viewer: ${name()}`}
      data-kind={kind()}
    >
      <header class="viewer-header">
        <span class="viewer-name" title={path()}>{name() || "No files"}</span>
        <span class="viewer-meta">
          <Show when={preview()?.size !== undefined}>{formatSize(preview()!.size)} · </Show>
          <Show when={status()}>{status()} · </Show>
          <Show when={buffer()}>{buffer()} · </Show>
          {position()}
        </span>
        <button class="viewer-close" onClick={close} aria-label="Close viewer">✕</button>
      </header>

      <div class="viewer-body">
        <Show when={path()} keyed>
          {(p) => (
            <Switch>
              <Match when={error()}>
                <InfoCard
                  title={
                    kind() === "image" ? "Can't display this image"
                    : kind() === "pdf" ? "Can't display this PDF"
                    : "Can't play this format"
                  }
                  name={name()}
                  detail={error() !== "unsupported" ? error()! : undefined}
                  onOpen={openDefault}
                />
              </Match>

              <Match when={kind() === "image"}>
                <ImageView url={backend.fileUrl(p)} name={name()} register={register} onError={onMediaError} />
              </Match>

              <Match when={kind() === "pdf"}>
                <PdfView
                  url={backend.fileUrl(p)}
                  name={name()}
                  register={register}
                  onError={(m) => setError(m)}
                  onStatus={setStatus}
                />
              </Match>

              <Match when={kind() === "video" || kind() === "audio"}>
                <MediaView
                  url={backend.mediaUrl(p)}
                  name={name()}
                  video={kind() === "video"}
                  engine={mediaEngine(name())}
                  register={register}
                  onError={onMediaError}
                />
              </Match>

              <Match when={text.loading}>
                <div class="viewer-status">Loading…</div>
              </Match>

              <Match when={text() && "error" in text()!}>
                <InfoCard
                  title="Can't read this file"
                  detail={(text() as { error: string }).error}
                  name={name()}
                  onOpen={openDefault}
                />
              </Match>

              <Match when={preview()?.binary && extension(name()) === "ts"}>
                <MediaView
                  url={backend.mediaUrl(p)}
                  name={name()}
                  video
                  engine="libmedia"
                  register={register}
                  onError={onMediaError}
                />
              </Match>

              <Match when={preview()?.binary}>
                <InfoCard title="No preview" name={name()} size={preview()!.size} onOpen={openDefault} />
              </Match>

              <Match when={preview()}>
                <TextView preview={preview()!} />
              </Match>
            </Switch>
          )}
        </Show>
      </div>

      <footer class="viewer-hint">{hint()}</footer>
    </div>
  );
}
