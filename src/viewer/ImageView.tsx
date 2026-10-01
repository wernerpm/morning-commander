// Photos: fitted to the window; +/-/0 zoom. ←/→ (previous/next photo) belong to the shell.

import { createSignal, onMount, type JSX } from "solid-js";
import { imageKey, type KeyHandler } from "./keys";

export default function ImageView(props: {
  url: string;
  name: string;
  register: (h: KeyHandler) => void;
  onError: () => void;
}): JSX.Element {
  let img!: HTMLImageElement;
  let box!: HTMLDivElement;
  const [zoom, setZoom] = createSignal<number | null>(null); // null = fit to window

  const zoomBy = (factor: number) => {
    if (!img.naturalWidth) return;
    const current = zoom() ?? img.clientWidth / img.naturalWidth;
    setZoom(Math.min(32, Math.max(0.05, current * factor)));
  };

  onMount(() => box.focus()); // so ↑/↓ scroll a zoomed photo

  props.register((e) => {
    const a = imageKey(e);
    if (!a) return false;
    if (a.type === "zoom") zoomBy(a.factor);
    else setZoom(null);
    return true;
  });

  return (
    <div class="viewer-image" classList={{ zoomed: zoom() !== null }} ref={box} tabIndex={-1}>
      <img
        ref={img}
        src={props.url}
        alt={props.name}
        draggable={false}
        style={zoom() !== null ? { width: `${img.naturalWidth * zoom()!}px` } : undefined}
        onError={props.onError}
      />
    </div>
  );
}
