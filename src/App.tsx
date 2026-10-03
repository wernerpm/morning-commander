import { batch, createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import Bookmarks, { defaultBookmarks, type Bookmark } from "./app/Bookmarks";
import { prefs, updatePrefs } from "./app/settings";
import ConflictDialog from "./app/ConflictDialog";
import Dialog, { type DialogSpec } from "./app/Dialog";
import OpProgress, { type OpState } from "./app/OpProgress";
import { backend } from "./ipc";
import { isNavigable, type Entry, type OpKind, type PanelId } from "./ipc/types";
import { COMMANDS, commandFor, jumpChar, type CommandId } from "./keys/keymap";
import { emptyJump, jumpActive, jumpBackspace, jumpKey, JUMP_TIMEOUT_MS, type JumpState } from "./panel/jump";
import Panel from "./panel/Panel";
import { basename, createPanel, type Panel as PanelModel } from "./panel/store";
import Viewer from "./viewer/Viewer";
import type { SortKey } from "./panel/sort";
import "./app/app.css";

const FKEYS: { key: string; label: string; cmd: CommandId }[] = [
  { key: "1", label: "Help", cmd: "app.help" },
  { key: "3", label: "View", cmd: "file.view" },
  { key: "4", label: "Edit", cmd: "file.edit" },
  { key: "5", label: "Copy", cmd: "file.copy" },
  { key: "6", label: "Move", cmd: "file.move" },
  { key: "7", label: "Mkdir", cmd: "file.mkdir" },
  { key: "8", label: "Trash", cmd: "file.trash" },
];

export default function App() {
  const panels: [PanelModel, PanelModel] = [createPanel(0), createPanel(1)];
  const [active, setActive] = createSignal<PanelId>(0);
  const [jump, setJump] = createSignal<JumpState>(emptyJump);
  const [jumpMiss, setJumpMiss] = createSignal(false);
  const [renaming, setRenaming] = createSignal<{ panel: PanelId; name: string } | null>(null);
  const [dialog, setDialog] = createSignal<DialogSpec | null>(null);
  const [op, setOp] = createSignal<OpState | null>(null);
  const [conflict, setConflict] = createSignal<{ id: number; path: string } | null>(null);
  const [message, setMessage] = createSignal<{ text: string; error: boolean } | null>(null);
  const [help, setHelp] = createSignal(false);
  const [home, setHome] = createSignal<string | null>(null);
  const bookmarks = createMemo<Bookmark[]>(() => {
    const h = home();
    return prefs().bookmarks ?? (h ? defaultBookmarks(h) : []);
  });
  const [showBookmarks, setShowBookmarks] = createSignal(false);
  const [viewer, setViewer] = createSignal<{ panel: PanelId; files: string[]; index: number } | null>(null);

  const cur = () => panels[active()];
  const other = () => panels[active() === 0 ? 1 : 0];

  let messageTimer: number | undefined;
  function flash(text: string, error = false) {
    setMessage({ text, error });
    clearTimeout(messageTimer);
    messageTimer = window.setTimeout(() => setMessage(null), error ? 6000 : 3000);
  }

  let jumpTimer: number | undefined;
  function clearJump() {
    setJump(emptyJump);
    setJumpMiss(false);
  }

  onMount(async () => {
    const home = await backend.homeDir();
    setHome(home);
    await Promise.all(panels.map((p) => p.open(p.initialPath || home)));
  });

  // --- file actions -------------------------------------------------------

  /** Open the viewer on `e`; ←/→ in the viewer walk the other files of this panel. */
  function openFile(p: PanelModel, e: Entry) {
    const files = p.entries().filter((x) => !isNavigable(x));
    const index = Math.max(0, files.findIndex((x) => x.name === e.name));
    clearJump();
    setViewer({ panel: p.id, files: files.map((x) => p.fullPath(x.name)), index });
  }

  function closeViewer(lastPath: string) {
    const v = viewer();
    setViewer(null);
    if (v) panels[v.panel].focusName(basename(lastPath));
  }

  async function openDefault(p: PanelModel) {
    const e = p.current();
    if (!e || e.name === "..") return;
    try {
      await backend.openDefault(p.fullPath(e.name));
    } catch (err) {
      flash(String(err), true);
    }
  }

  function startRename() {
    const e = cur().current();
    if (!e || e.name === "..") return;
    setRenaming({ panel: active(), name: e.name });
  }

  async function commitRename(p: PanelModel, from: string, to: string) {
    setRenaming(null);
    if (!to || to === from) return;
    try {
      await backend.rename(p.path(), from, to);
      p.localRename(from, to);
    } catch (err) {
      flash(`Rename failed: ${err}`, true);
    }
  }

  function mkdir() {
    const p = cur();
    setDialog({
      kind: "prompt",
      title: "New folder",
      label: `Create in ${p.path()}`,
      value: "",
      okLabel: "Create",
      onSubmit: async (name) => {
        if (!name.trim()) return;
        try {
          p.expectFocus(name.trim());
          await backend.mkdir(p.path(), name.trim());
        } catch (err) {
          flash(`Could not create folder: ${err}`, true);
        }
      },
    });
  }

  function describe(targets: Entry[]): string {
    return targets.length === 1 ? `"${targets[0].name}"` : `${targets.length} items`;
  }

  function trash() {
    const p = cur();
    const targets = p.targets();
    if (!targets.length) return;
    setDialog({
      kind: "confirm",
      title: "Move to Trash",
      message: `Move ${describe(targets)} to the Trash?`,
      okLabel: "Move to Trash",
      danger: true,
      onConfirm: async () => {
        try {
          await backend.trash(targets.map((t) => p.fullPath(t.name)));
          p.selectAll(false);
          p.refreshFreeSpace();
          flash(`Moved ${describe(targets)} to the Trash`);
        } catch (err) {
          flash(`Trash failed: ${err}`, true);
        }
      },
    });
  }

  function copyMove(kind: OpKind) {
    const src = cur();
    const dst = other();
    const targets = src.targets();
    if (!targets.length) return;
    const verb = kind === "copy" ? "Copy" : "Move";
    setDialog({
      kind: "prompt",
      title: verb,
      label: `${verb} ${describe(targets)} to`,
      value: dst.path(),
      okLabel: verb,
      onSubmit: (dest) => void runOp(kind, src, targets, dest.trim()),
    });
  }

  async function runOp(kind: OpKind, src: PanelModel, targets: Entry[], dest: string) {
    if (!dest) return;
    const title = kind === "copy" ? "Copying" : "Moving";
    try {
      const id = await backend.copyMove(
        kind,
        targets.map((t) => src.fullPath(t.name)),
        dest,
        (ev) => {
          if (ev.type === "progress") {
            setOp({ ...ev, title });
          } else if (ev.type === "conflict") {
            setConflict({ id: ev.id, path: ev.path });
          } else if (ev.type === "done") {
            setOp(null);
            setConflict(null);
            panels.forEach((p) => p.refreshFreeSpace());
            src.selectAll(false);
            if (ev.errors.length) flash(`${title} finished with ${ev.errors.length} problem(s): ${ev.errors[0]}`, true);
            else flash(`${kind === "copy" ? "Copied" : "Moved"} ${describe(targets)}`);
          } else if (ev.type === "cancelled") {
            setOp(null);
            setConflict(null);
            flash(`${title} cancelled`);
          }
        },
      );
      setOp((o) => o ?? { id, title, filesDone: 0, filesTotal: targets.length, bytesDone: 0, bytesTotal: 0, current: "" });
    } catch (err) {
      flash(`${title} failed: ${err}`, true);
    }
  }

  function goto() {
    const p = cur();
    setDialog({
      kind: "prompt",
      title: "Go to",
      label: "Path (~ for home)",
      value: p.path(),
      okLabel: "Go",
      onSubmit: (path) => path.trim() && void p.open(path.trim()),
    });
  }

  function setSort(key: SortKey) {
    const p = cur();
    const s = p.sort();
    p.setSort({ key, desc: s.key === key ? !s.desc : key === "mtime" || key === "size" });
  }

  // --- key dispatch -------------------------------------------------------

  const handlers: Record<CommandId, () => void> = {
    "cursor.up": () => cur().move(-1),
    "cursor.down": () => cur().move(1),
    "cursor.pageUp": () => cur().move(-pageSize()),
    "cursor.pageDown": () => cur().move(pageSize()),
    "cursor.home": () => cur().setCursor(0),
    "cursor.end": () => cur().setCursor(Math.max(0, cur().rows().length - 1)),
    "panel.open": () => {
      const p = cur();
      const { file } = p.enter();
      if (file) openFile(p, file);
    },
    "panel.parent": () => cur().goParent(),
    "panel.switch": () => setActive((a) => (a === 0 ? 1 : 0)),
    "panel.swap": () => {
      const a = panels[0].path();
      const b = panels[1].path();
      void panels[0].open(b);
      void panels[1].open(a);
    },
    "panel.sameDir": () => void other().open(cur().path()),
    "panel.toggleHidden": () => cur().toggleHidden(),
    "panel.goto": goto,
    "panel.home": async () => void cur().open(await backend.homeDir()),
    "panel.refresh": () => void cur().reload(),
    "panel.filter": () => {
      const p = cur();
      if (p.filter() === null) p.setFilter("");
    },
    "sort.name": () => setSort("name"),
    "sort.ext": () => setSort("ext"),
    "sort.size": () => setSort("size"),
    "sort.mtime": () => setSort("mtime"),
    "sort.none": () => setSort("none"),
    "select.toggle": () => {
      cur().toggleSelect();
      cur().move(1);
    },
    "select.all": () => cur().selectAll(true),
    "select.none": () => cur().selectAll(false),
    "file.view": () => {
      const p = cur();
      const e = p.current();
      if (e && e.name !== ".." && e.kind !== "dir") openFile(p, e);
    },
    "file.edit": () => void openDefault(cur()),
    "file.openDefault": () => void openDefault(cur()),
    "file.rename": startRename,
    "file.copy": () => copyMove("copy"),
    "file.move": () => copyMove("move"),
    "file.mkdir": mkdir,
    "file.trash": trash,
    "history.back": () => cur().goBack(),
    "history.forward": () => cur().goForward(),
    "bookmarks.open": () => setShowBookmarks(true),
    "bookmarks.add": () => {
      const path = cur().path();
      if (bookmarks().some((b) => b.path === path)) return flash("Already bookmarked");
      updateBookmarks([...bookmarks(), { name: basename(path) || "/", path }]);
      flash(`Bookmarked ${path}`);
    },
    "app.help": () => setHelp((h) => !h),
  };

  function updateBookmarks(list: Bookmark[]) {
    void updatePrefs({ bookmarks: list });
  }

  function pageSize(): number {
    return (cur() as unknown as { pageSize?: number }).pageSize ?? 20;
  }

  function onKeyDown(ev: KeyboardEvent) {
    if (viewer() || dialog() || renaming() || showBookmarks() || conflict()) return; // they own the keyboard
    if (help()) {
      if (ev.key === "Escape" || ev.key === "F1") {
        ev.preventDefault();
        setHelp(false);
      }
      return;
    }

    const now = performance.now();
    const p = cur();

    // While the filter is open, letters and Backspace edit it and Esc ends it;
    // everything else (arrows, Enter, ⌘ commands) works on the filtered rows.
    const f = p.filter();
    if (f !== null) {
      if (ev.key === "Escape") {
        ev.preventDefault();
        p.clearFilter();
        return;
      }
      if (ev.key === "Backspace" && !ev.metaKey && !ev.altKey && !ev.ctrlKey) {
        ev.preventDefault();
        if (f) p.setFilter(f.slice(0, -1));
        else p.clearFilter();
        return;
      }
      const ch = jumpChar(ev);
      if (ch !== null) {
        ev.preventDefault();
        p.setFilter(f + ch);
        return;
      }
    }

    if (op() && ev.key === "Escape") {
      ev.preventDefault();
      void backend.cancelOp(op()!.id);
      return;
    }

    if (jumpActive(jump(), now)) {
      if (ev.key === "Escape") {
        ev.preventDefault();
        clearJump();
        return;
      }
      if (ev.key === "Backspace") {
        ev.preventDefault();
        const r = jumpBackspace(p.rows(), p.cursor(), jump(), now);
        applyJump(p, r);
        return;
      }
    }

    const ch = jumpChar(ev);
    if (ch !== null) {
      ev.preventDefault();
      applyJump(p, jumpKey(p.rows(), p.cursor(), jump(), ch, now));
      return;
    }

    const cmd = commandFor(ev);
    if (!cmd) return;
    ev.preventDefault();
    if (!cmd.startsWith("select.")) clearJump();
    batch(() => handlers[cmd]());
  }

  function applyJump(p: PanelModel, r: ReturnType<typeof jumpKey>) {
    batch(() => {
      setJump(r.state);
      setJumpMiss(!r.matched);
      p.setCursor(r.cursor);
    });
    clearTimeout(jumpTimer);
    jumpTimer = window.setTimeout(clearJump, JUMP_TIMEOUT_MS + 200);
  }

  onMount(() => window.addEventListener("keydown", onKeyDown));
  onCleanup(() => window.removeEventListener("keydown", onKeyDown));

  return (
    <div class="app">
      <div class="panels">
        <For each={panels}>
          {(p) => (
            <Panel
              panel={p}
              active={active() === p.id}
              jumpBuffer={active() === p.id ? jump().buffer : ""}
              jumpMiss={jumpMiss()}
              renaming={renaming()?.panel === p.id ? renaming()!.name : null}
              onActivate={() => setActive(p.id)}
              onOpen={() => {
                setActive(p.id);
                handlers["panel.open"]();
              }}
              onRenameCommit={(from, to) => void commitRename(p, from, to)}
              onRenameCancel={() => setRenaming(null)}
            />
          )}
        </For>
      </div>
      <div class="statusline" classList={{ error: message()?.error }}>
        {message()?.text ?? cur().current()?.name ?? ""}
      </div>
      <nav class="fkeys">
        <For each={FKEYS}>
          {(f) => (
            <button type="button" tabIndex={-1} onClick={() => handlers[f.cmd]()}>
              <kbd>{f.key}</kbd>
              {f.label}
            </button>
          )}
        </For>
      </nav>
      <Show when={op()}>{(o) => <OpProgress op={o()} onCancel={() => void backend.cancelOp(o().id)} />}</Show>
      <Show when={viewer()}>
        {(v) => <Viewer files={v().files} index={v().index} onClose={closeViewer} />}
      </Show>
      <Show when={showBookmarks()}>
        <Bookmarks
          bookmarks={bookmarks()}
          onOpen={(path) => void cur().open(path)}
          onRemove={(b) => updateBookmarks(bookmarks().filter((x) => x.path !== b.path || x.name !== b.name))}
          onClose={() => setShowBookmarks(false)}
        />
      </Show>
      <Show when={conflict()}>
        {(c) => (
          <ConflictDialog
            path={c().path}
            onAnswer={(choice, all) => {
              const id = c().id;
              setConflict(null);
              void backend.resolveConflict(id, choice, all);
            }}
          />
        )}
      </Show>
      <Show when={dialog()}>{(d) => <Dialog spec={d()} onClose={() => setDialog(null)} />}</Show>
      <Show when={help()}>
        <div class="modal-backdrop" onMouseDown={() => setHelp(false)}>
          <div class="modal help">
            <h2>Keys</h2>
            <p class="muted">Type letters to jump to a file; ⌘F filters by any part of the name. Esc closes this.</p>
            <table>
              <tbody>
                <For each={COMMANDS}>
                  {(c) => (
                    <tr>
                      <td>{c.title}</td>
                      <td>
                        <For each={c.keys}>{(k) => <kbd>{k.replace("Meta", "⌘").replace("Shift", "⇧").replace("Alt", "⌥")}</kbd>}</For>
                      </td>
                    </tr>
                  )}
                </For>
              </tbody>
            </table>
          </div>
        </div>
      </Show>
    </div>
  );
}
