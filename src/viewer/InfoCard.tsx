// Shown for files we can't display (binary, unsupported or failing media).

import { Show, type JSX } from "solid-js";
import { formatSize } from "./format";

export default function InfoCard(props: {
  title: string;
  name: string;
  size?: number;
  detail?: string;
  onOpen: () => void;
}): JSX.Element {
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
