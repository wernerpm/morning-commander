import { onMount, Show } from "solid-js";

export type DialogSpec =
  | {
      kind: "prompt";
      title: string;
      label: string;
      value: string;
      okLabel?: string;
      selectStem?: boolean;
      onSubmit: (value: string) => void;
    }
  | {
      kind: "confirm";
      title: string;
      message: string;
      okLabel?: string;
      danger?: boolean;
      onConfirm: () => void;
    };

interface Props {
  spec: DialogSpec;
  onClose: () => void;
}

/** Modal prompt/confirm. Enter accepts, Esc cancels; keys never reach the panels. */
export default function Dialog(props: Props) {
  let input: HTMLInputElement | undefined;
  let ok: HTMLButtonElement | undefined;

  onMount(() => {
    if (input) {
      input.focus();
      const v = input.value;
      const dot = v.lastIndexOf(".");
      if (props.spec.kind === "prompt" && props.spec.selectStem && dot > 0) input.setSelectionRange(0, dot);
      else input.select();
    } else ok?.focus();
  });

  function accept() {
    const spec = props.spec;
    props.onClose();
    if (spec.kind === "prompt") spec.onSubmit(input!.value);
    else spec.onConfirm();
  }

  return (
    <div class="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && props.onClose()}>
      <div
        class="modal"
        role="dialog"
        aria-label={props.spec.title}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Escape") {
            e.preventDefault();
            props.onClose();
          } else if (e.key === "Enter") {
            e.preventDefault();
            accept();
          }
        }}
      >
        <h2>{props.spec.title}</h2>
        <Show
          when={props.spec.kind === "prompt" && props.spec}
          fallback={<p>{props.spec.kind === "confirm" && props.spec.message}</p>}
        >
          {(p) => (
            <label>
              <span>{p().label}</span>
              <input ref={input} value={p().value} spellcheck={false} autocomplete="off" />
            </label>
          )}
        </Show>
        <div class="modal-buttons">
          <button type="button" onClick={() => props.onClose()}>
            Cancel
          </button>
          <button
            type="button"
            ref={ok}
            class="primary"
            classList={{ danger: props.spec.kind === "confirm" && props.spec.danger }}
            onClick={accept}
          >
            {props.spec.okLabel ?? "OK"}
          </button>
        </div>
      </div>
    </div>
  );
}
