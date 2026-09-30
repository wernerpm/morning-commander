// PDFs rendered with PDF.js into our own document, so the view has keyboard
// focus on open and Esc always reaches the shell (the native <iframe> viewer
// trapped both). Pages are rendered lazily: only those near the viewport have
// a canvas. Arrows scroll and never change file.

import { createEffect, createMemo, createSignal, Index, on, onCleanup, onMount, Show, type JSX } from "solid-js";
import type { PDFDocumentLoadingTask, PDFDocumentProxy, RenderTask } from "pdfjs-dist/legacy/build/pdf.mjs";
import { pdfKey, type KeyHandler, type PdfAction } from "./keys";

type PdfJs = typeof import("pdfjs-dist/legacy/build/pdf.mjs");

// The legacy build supports the Safari 16 WKWebView of macOS 13 (our minimum).
let pdfjs: Promise<PdfJs> | undefined;
function loadPdfJs(): Promise<PdfJs> {
  pdfjs ??= Promise.all([
    import("pdfjs-dist/legacy/build/pdf.mjs"),
    import("pdfjs-dist/legacy/build/pdf.worker.min.mjs?url"),
  ]).then(([lib, worker]) => {
    lib.GlobalWorkerOptions.workerSrc = worker.default;
    return lib;
  });
  return pdfjs;
}

const MAX_FIT_WIDTH = 1000; // px; "fit" = window width, but not wider than this
const PAGE_GAP = 12;
const PAGE_OVERLAP = 0.9; // Space scrolls 90% of the viewport so a line stays visible

export default function PdfView(props: {
  url: string;
  name: string;
  register: (h: KeyHandler) => void;
  onError: (message: string) => void;
  onStatus: (status: string) => void;
}): JSX.Element {
  let scroller!: HTMLDivElement;
  let doc: PDFDocumentProxy | undefined;
  let loadingTask: PDFDocumentLoadingTask | undefined;
  let disposed = false;
  // Page sizes in PDF points (scale 1). Placeholders use page 1's size until a page renders.
  const [sizes, setSizes] = createSignal<{ w: number; h: number }[]>([]);
  const [loading, setLoading] = createSignal(true);
  const [width, setWidth] = createSignal(0);
  const [zoom, setZoom] = createSignal(1); // 1 = fit width

  const scale = createMemo(() => {
    const first = sizes()[0];
    if (!first || !width()) return 1;
    return (Math.min(width() - 2 * PAGE_GAP, MAX_FIT_WIDTH) / first.w) * zoom();
  });

  const pageEls: HTMLDivElement[] = [];
  const visible = new Set<number>();
  const rendered = new Map<number, number>(); // page index → scale it was rendered at
  const tasks = new Map<number, RenderTask>();

  async function renderPage(i: number) {
    const el = pageEls[i];
    const s = scale();
    if (!doc || !el || rendered.get(i) === s) return;
    tasks.get(i)?.cancel();
    rendered.set(i, s);
    try {
      const page = await doc.getPage(i + 1);
      const base = page.getViewport({ scale: 1 });
      const size = sizes()[i];
      if (size && (Math.abs(size.w - base.width) > 0.5 || Math.abs(size.h - base.height) > 0.5)) {
        setSizes((list) => list.map((x, j) => (j === i ? { w: base.width, h: base.height } : x)));
      }
      const dpr = window.devicePixelRatio || 1;
      const viewport = page.getViewport({ scale: s * dpr });
      const canvas = document.createElement("canvas");
      canvas.width = Math.floor(viewport.width);
      canvas.height = Math.floor(viewport.height);
      const task = page.render({ canvas, viewport });
      tasks.set(i, task);
      await task.promise;
      if (tasks.get(i) === task) tasks.delete(i);
      if (rendered.get(i) === s && visible.has(i)) el.replaceChildren(canvas);
    } catch (err) {
      if ((err as { name?: string })?.name !== "RenderingCancelledException") {
        rendered.delete(i);
        console.warn(`PDF page ${i + 1}:`, err);
      }
    }
  }

  function forget(i: number) {
    tasks.get(i)?.cancel();
    tasks.delete(i);
    rendered.delete(i);
    pageEls[i]?.replaceChildren();
  }

  // Pages within about two screens of the viewport get a canvas; others drop theirs.
  let observer: IntersectionObserver | undefined;
  const observe = (el: HTMLDivElement, i: number) => {
    pageEls[i] = el;
    observer?.observe(el);
  };

  function updateStatus() {
    const n = sizes().length;
    if (!n) return;
    const mid = scroller.scrollTop + scroller.clientHeight / 3;
    let page = 0;
    for (let i = 0; i < pageEls.length; i++) {
      if (pageEls[i] && pageEls[i].offsetTop <= mid) page = i;
      else break;
    }
    props.onStatus(`p. ${page + 1} / ${n}`);
  }

  // Re-render visible pages at the new scale, keeping the relative scroll position.
  createEffect(
    on(scale, () => {
      const ratio = scroller.scrollHeight ? scroller.scrollTop / scroller.scrollHeight : 0;
      queueMicrotask(() => {
        scroller.scrollTop = ratio * scroller.scrollHeight;
        for (const i of visible) void renderPage(i);
      });
    }, { defer: true }),
  );

  const apply = (a: PdfAction) => {
    const h = scroller.clientHeight;
    switch (a.type) {
      case "scroll":
        scroller.scrollTop += a.y * h;
        break;
      case "scrollX":
        scroller.scrollLeft += a.x * scroller.clientWidth;
        break;
      case "page":
        scroller.scrollTop += a.by * h * PAGE_OVERLAP;
        break;
      case "top":
        scroller.scrollTop = 0;
        break;
      case "bottom":
        scroller.scrollTop = scroller.scrollHeight;
        break;
      case "zoom":
        setZoom((z) => Math.min(8, Math.max(0.25, z * a.factor)));
        break;
      case "zoomReset":
        setZoom(1);
        break;
    }
  };

  props.register((e) => {
    const a = pdfKey(e);
    if (!a) return false;
    apply(a);
    return true;
  });

  onMount(() => {
    scroller.focus();
    setWidth(scroller.clientWidth);
    const ro = new ResizeObserver(() => setWidth(scroller.clientWidth));
    ro.observe(scroller);
    observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const i = pageEls.indexOf(entry.target as HTMLDivElement);
          if (i < 0) continue;
          if (entry.isIntersecting) {
            visible.add(i);
            void renderPage(i);
          } else {
            visible.delete(i);
            forget(i);
          }
        }
      },
      { root: scroller, rootMargin: "200% 0px" },
    );
    for (const el of pageEls) if (el) observer.observe(el);
    onCleanup(() => {
      ro.disconnect();
      observer?.disconnect();
    });
    void load();
  });

  async function load() {
    try {
      const lib = await loadPdfJs();
      const res = await fetch(props.url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = new Uint8Array(await res.arrayBuffer());
      if (disposed) return;
      loadingTask = lib.getDocument({ data });
      const loaded = await loadingTask.promise;
      if (disposed) return;
      doc = loaded;
      const first = (await doc.getPage(1)).getViewport({ scale: 1 });
      setSizes(Array.from({ length: doc.numPages }, () => ({ w: first.width, h: first.height })));
      setLoading(false);
      updateStatus();
    } catch (err) {
      if (!disposed) props.onError(err instanceof Error ? err.message : String(err));
    }
  }

  onCleanup(() => {
    disposed = true;
    for (const t of tasks.values()) t.cancel();
    void loadingTask?.destroy(); // also frees the document and the worker
  });

  return (
    <div class="viewer-pdf" ref={scroller} tabIndex={-1} onScroll={updateStatus} aria-label={props.name}>
      <Show when={loading()}>
        <div class="viewer-status">Loading…</div>
      </Show>
      <Index each={sizes()}>
        {(size, i) => (
          <div
            class="viewer-pdf-page"
            data-page={i + 1}
            ref={(el) => observe(el, i)}
            style={{ width: `${Math.floor(size().w * scale())}px`, height: `${Math.floor(size().h * scale())}px` }}
          />
        )}
      </Index>
    </div>
  );
}
