import { createSignal, onMount } from "solid-js";
import type { ConflictChoice } from "../ipc/types";

interface Props {
  path: string;
  onAnswer: (choice: ConflictChoice, applyToAll: boolean) => void;
}

/**
 * Asked by a running copy/move when the destination exists.
 * Keys: S skip (also Enter), K keep both, O overwrite, A toggles "apply to all", Esc cancels.
 */
export default function ConflictDialog(props: Props) {
  let skip!: HTMLButtonElement;
  const [all, setAll] = createSignal(false);
  const name = () => props.path.slice(props.path.lastIndexOf("/") + 1);
  const dir = () => props.path.slice(0, props.path.lastIndexOf("/")) || "/";

  onMount(() => skip.focus());

  const answer = (c: ConflictChoice) => props.onAnswer(c, c !== "cancel" && all());

  function onKeyDown(e: KeyboardEvent) {
    e.stopPropagation();
    if (e.metaKey || e.ctrlKey) return;
    const k = e.key.toLowerCase();
    if (e.key === "Escape") answer("cancel");
    else if (e.key === "Enter" || k === "s") answer("skip");
    else if (k === "k") answer("keepBoth");
    else if (k === "o") answer("overwrite");
    else if (k === "a") setAll((v) => !v);
    else return;
    e.preventDefault();
  }

  return (
    <div class="modal-backdrop">
      <div class="modal conflict" role="dialog" aria-label="File exists" onKeyDown={onKeyDown}>
        <h2>“{name()}” already exists</h2>
        <p class="muted">in {dir()}</p>
        <label class="apply-all">
          <input type="checkbox" checked={all()} onChange={(e) => setAll(e.currentTarget.checked)} tabIndex={-1} />
          <span>
            Apply to all remaining conflicts <kbd>A</kbd>
          </span>
        </label>
        <div class="modal-buttons">
          <button type="button" onClick={() => answer("cancel")}>
            Cancel <kbd>Esc</kbd>
          </button>
          <button type="button" class="danger" onClick={() => answer("overwrite")} title="The existing item is moved to the Trash">
            Replace <kbd>O</kbd>
          </button>
          <button type="button" onClick={() => answer("keepBoth")}>
            Keep both <kbd>K</kbd>
          </button>
          <button type="button" ref={skip} class="primary" onClick={() => answer("skip")}>
            Skip <kbd>S</kbd>
          </button>
        </div>
      </div>
    </div>
  );
}
