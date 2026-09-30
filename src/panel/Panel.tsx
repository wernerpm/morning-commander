import { createEffect, createMemo, createSignal, For, on, onCleanup, onMount, Show } from "solid-js";
import { isNavigable, type Entry } from "../ipc/types";
import { formatBytesLong, formatMtime, sizeColumn } from "./format";
import type { Panel as PanelModel } from "./store";

export const ROW_HEIGHT = 22;
const OVERSCAN = 8;

interface Props {
  panel: PanelModel;
  active: boolean;
  jumpBuffer: string;
  jumpMiss: boolean;
  renaming: string | null;
  onActivate: () => void;
  onOpen: () => void;
  onRenameCommit: (from: string, to: string) => void;
  onRenameCancel: () => void;
}

function glyph(e: Entry): string {
  if (e.name === "..") return "/";
  if (e.kind === "dir") return "/";
  if (e.kind === "symlink") return e.targetIsDir ? "~" : "@";
  if (e.kind === "other") return "=";
  return " ";
}

/** Select the stem ("report" in "report.pdf"), like Finder. */
function selectStem(input: HTMLInputElement) {
  const v = input.value;
  const dot = v.lastIndexOf(".");
  input.setSelectionRange(0, dot > 0 ? dot : v.length);
}

export default function Panel(props: Props) {
  let scroller!: HTMLDivElement;
  const [scrollTop, setScrollTop] = createSignal(0);
  const [height, setHeight] = createSignal(400);

  onMount(() => {
    const ro = new ResizeObserver(() => setHeight(scroller.clientHeight));
    ro.observe(scroller);
    onCleanup(() => ro.disconnect());
  });

  const pageSize = createMemo(() => Math.max(1, Math.floor(height() / ROW_HEIGHT) - 1));

  const range = createMemo(() => {
    const n = props.panel.rows().length;
    const start = Math.max(0, Math.floor(scrollTop() / ROW_HEIGHT) - OVERSCAN);
    const end = Math.min(n, Math.ceil((scrollTop() + height()) / ROW_HEIGHT) + OVERSCAN);
    return { start, end };
  });

  const slice = createMemo(() => {
    const { start, end } = range();
    return props.panel.rows().slice(start, end);
  });

  // Keep the cursor row in view.
  createEffect(
    on([() => props.panel.cursor(), height, () => props.panel.rows().length], ([c]) => {
      const top = c * ROW_HEIGHT;
      const bottom = top + ROW_HEIGHT;
      if (top < scroller.scrollTop) scroller.scrollTop = top;
      else if (bottom > scroller.scrollTop + scroller.clientHeight) scroller.scrollTop = bottom - scroller.clientHeight;
    }),
  );

  const summary = createMemo(() => {
    const entries = props.panel.entries();
    const sel = props.panel.selected();
    if (sel.size) {
      let bytes = 0;
      for (const e of entries) if (sel.has(e.name) && !isNavigable(e)) bytes += e.size;
      return `${sel.size} selected, ${formatBytesLong(bytes)}`;
    }
    let dirs = 0;
    let files = 0;
    let bytes = 0;
    for (const e of entries) {
      if (isNavigable(e)) dirs++;
      else {
        files++;
        bytes += e.size;
      }
    }
    return `${dirs} dirs, ${files} files, ${formatBytesLong(bytes)}`;
  });

  // Expose page size for PgUp/PgDn handling.
  createEffect(() => {
    (props.panel as unknown as { pageSize: number }).pageSize = pageSize();
  });

  return (
    <section
      class="panel"
      classList={{ active: props.active }}
      data-panel={props.panel.id}
      onMouseDown={() => props.onActivate()}
    >
      <header class="panel-path" title={props.panel.path()}>
        <span>{props.panel.path() || "…"}</span>
      </header>
      <div class="panel-cols">
        <span class="col-name">Name</span>
        <span class="col-size">Size</span>
        <span class="col-mtime">Modified</span>
      </div>
      <div class="panel-list" ref={scroller} onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}>
        <Show when={props.panel.error()}>
          <div class="panel-error">{props.panel.error()}</div>
        </Show>
        <div class="panel-spacer" style={{ height: `${props.panel.rows().length * ROW_HEIGHT}px` }}>
          <For each={slice()}>
            {(e, i) => {
              const index = () => range().start + i();
              const isCursor = () => props.panel.cursor() === index();
              return (
                <div
                  class="row"
                  classList={{
                    cursor: isCursor(),
                    dir: isNavigable(e),
                    hidden: e.hidden,
                    selected: props.panel.selected().has(e.name),
                  }}
                  style={{ transform: `translateY(${index() * ROW_HEIGHT}px)` }}
                  data-name={e.name}
                  onMouseDown={() => props.panel.setCursor(index())}
                  onDblClick={() => props.onOpen()}
                >
                  <span class="col-name">
                    <span class="glyph">{glyph(e)}</span>
                    <Show when={props.renaming === e.name && isCursor()} fallback={<span class="name">{e.name}</span>}>
                      <input
                        class="rename"
                        value={e.name}
                        spellcheck={false}
                        autocomplete="off"
                        ref={(el) =>
                          queueMicrotask(() => {
                            el.focus();
                            selectStem(el);
                          })
                        }
                        onKeyDown={(ev) => {
                          ev.stopPropagation();
                          if (ev.key === "Enter") {
                            ev.preventDefault();
                            props.onRenameCommit(e.name, ev.currentTarget.value);
                          } else if (ev.key === "Escape") {
                            ev.preventDefault();
                            props.onRenameCancel();
                          } else if (ev.key === "r" && ev.metaKey) {
                            ev.preventDefault();
                            ev.currentTarget.select();
                          }
                        }}
                        onBlur={() => props.onRenameCancel()}
                      />
                    </Show>
                  </span>
                  <span class="col-size">{sizeColumn(e)}</span>
                  <span class="col-mtime">{formatMtime(e.mtime)}</span>
                </div>
              );
            }}
          </For>
        </div>
      </div>
      <footer class="panel-status">
        <Show
          when={props.active && props.jumpBuffer}
          fallback={<span class="summary">{summary()}</span>}
        >
          <span class="jump" classList={{ miss: props.jumpMiss }}>
            Jump: {props.jumpBuffer}
          </span>
        </Show>
        <span class="sort-indicator">
          {props.panel.sort().key}
          {props.panel.sort().desc ? "↓" : "↑"}
          {props.panel.showHidden() ? " ·hidden" : ""}
        </span>
      </footer>
    </section>
  );
}
