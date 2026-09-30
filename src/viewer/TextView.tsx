// Text: one text node for the content and one for the gutter, so even a 5 MB
// file is only a handful of DOM nodes. Arrow keys scroll natively; ←/→ belong to the shell.

import { createMemo, onMount, Show, type JSX } from "solid-js";
import type { TextPreview } from "../ipc/types";
import { formatSize } from "./format";

export default function TextView(props: { preview: TextPreview }): JSX.Element {
  let el!: HTMLDivElement;
  const gutter = createMemo(() => {
    let lines = 1;
    const t = props.preview.text;
    for (let i = 0; i < t.length; i++) if (t.charCodeAt(i) === 10) lines++;
    if (t.endsWith("\n")) lines--;
    const out: string[] = new Array(Math.max(lines, 1));
    for (let i = 0; i < out.length; i++) out[i] = String(i + 1);
    return out.join("\n");
  });

  onMount(() => el.focus());

  return (
    <div class="viewer-text" ref={el} tabIndex={-1}>
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
