// In-memory backend used outside Tauri (plain browser, Playwright tests).
// Behaves like the Rust side: snapshots on open, patches on change.
// Tests can reach it as `window.__mock` to simulate external FS changes,
// inspect prefs/state, and simulate network volumes (stale-while-revalidate).
// Tests can preseed prefs/state with `window.__mockSeed = { prefs, state }`
// (e.g. from Playwright's addInitScript) before the app loads.

import type { Backend } from "./index";
import { mergePatch } from "./mergePatch";
import type { AppState, ConflictChoice, Entry, PanelEvent, PanelId, Preferences } from "./types";

interface MockNode {
  kind: "file" | "dir";
  size: number;
  mtime: number;
  children?: Map<string, MockNode>;
  content?: string;
  /** Real file served by the dev server (tests/fixtures), for media the viewer must load. */
  url?: string;
}

const HOME = "/Users/demo";

export const PREF_DEFAULTS = { videoVolume: 0.8, cacheMaxBytes: 104_857_600, cacheMaxAgeDays: 180 };

interface MockSeed {
  prefs?: Partial<Preferences>;
  state?: AppState;
}

function file(size = 1234, content?: string): MockNode {
  return { kind: "file", size, mtime: Date.UTC(2026, 8, 1, 12), content };
}

/** A file whose bytes come from tests/fixtures (served by Vite in dev and e2e). */
function fixture(name: string, size: number): MockNode {
  return { ...file(size), url: `/tests/fixtures/${name}` };
}

function dir(children: Record<string, MockNode> = {}): MockNode {
  return {
    kind: "dir",
    size: 0,
    mtime: Date.UTC(2026, 8, 1, 12),
    children: new Map(Object.entries(children)),
  };
}

function seed(): MockNode {
  const many: Record<string, MockNode> = {};
  for (let i = 1; i <= 2000; i++) many[`file-${String(i).padStart(4, "0")}.txt`] = file(i * 10);
  return dir({
    Users: dir({
      demo: dir({
        ".zshrc": file(120, "export PATH=$PATH\n"),
        Documents: dir({
          "report.pdf": fixture("pages.pdf", 1_897),
          "notes.md": file(300, "# Notes\n\nhello from the mock backend\n"),
          "budget.csv": file(900, "a,b\n1,2\n"),
        }),
        Downloads: dir({
          "movie.mp4": fixture("tiny.mp4", 26_143),
          "clip.webm": fixture("tiny.webm", 29_139),
          "installer.dmg": file(80_000_000),
          "archive.zip": file(3_000_000),
        }),
        Pictures: dir({
          "beach.jpg": fixture("tiny.jpg", 9059),
          "cat.png": fixture("tiny.png", 2687),
          "holiday.mp4": fixture("tiny.mp4", 26_143),
          "Sunset.heic": file(1_500_000),
        }),
        Music: dir({}),
        Many: dir(many),
        "readme.txt": file(42, "Morning Commander mock filesystem\n"),
        "Report 2.pdf": file(10_000),
        "report 10.pdf": file(10_000),
        "alpha.txt": file(1),
        "Beta.txt": file(2),
        "zeta.txt": file(3),
      }),
    }),
    tmp: dir({}),
  });
}

class MockFs {
  root = seed();
  subs = new Map<PanelId, { path: string; cb: (e: PanelEvent) => void }>();
  nextOp = 1;
  ops = new Map<number, { cancelled: boolean; answer: null | ((c: [ConflictChoice, boolean]) => void) }>();

  // preferences.json / state.json contents (only what was set, like the files).
  prefs: Record<string, unknown> = {};
  state: AppState = {};
  // Window fullscreen (the viewer's F key) and how often focusWindow was called.
  fullscreen = false;
  focusRequests = 0;

  // Stale-while-revalidate simulation. `cache` holds the listing last sent for
  // each directory; reopening a cached network dir (or any cached dir with
  // refresh) sends it as a stale snapshot, then the differences and `fresh`.
  cache = new Map<string, Entry[]>();
  networkPrefixes: string[] = [];
  revalidateMs = 30;

  constructor() {
    const w = typeof window !== "undefined" ? (window as unknown as { __mockSeed?: MockSeed }) : undefined;
    this.resetSettings(w?.__mockSeed);
  }

  resetSettings(seed?: MockSeed) {
    this.prefs = structuredClone(seed?.prefs ?? {});
    this.state = structuredClone(seed?.state ?? {});
  }

  /** Mark paths under `prefix` as on a network volume; `null` clears all. */
  setNetwork(prefix: string | null) {
    if (prefix === null) this.networkPrefixes = [];
    else this.networkPrefixes.push(this.norm(prefix));
  }

  isNetwork(path: string): boolean {
    return this.networkPrefixes.some((pre) => path === pre || path.startsWith(pre === "/" ? "/" : pre + "/"));
  }

  /** Forget cached listings (like deleting the disk cache). */
  clearCache() {
    this.cache.clear();
  }

  remember(dirPath: string) {
    const d = this.lookup(dirPath);
    if (d?.children) this.cache.set(dirPath, [...d.children].map(([name, n]) => this.entry(name, n)));
  }

  /** Patch turning the cached listing `old` into `cur`, or null if they're equal. */
  diff(old: Entry[], cur: Entry[]): { removed: string[]; upserted: Entry[] } | null {
    const before = new Map(old.map((e) => [e.name, e]));
    const now = new Set(cur.map((e) => e.name));
    const removed = old.filter((e) => !now.has(e.name)).map((e) => e.name);
    const upserted = cur.filter((e) => {
      const b = before.get(e.name);
      return !b || b.size !== e.size || b.mtime !== e.mtime || b.kind !== e.kind;
    });
    return removed.length || upserted.length ? { removed, upserted } : null;
  }

  freeName(dir: MockNode, name: string): string {
    const dot = name.lastIndexOf(".");
    const [stem, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ""];
    for (let n = 2; ; n++) if (!dir.children!.has(`${stem} ${n}${ext}`)) return `${stem} ${n}${ext}`;
  }

  norm(path: string): string {
    if (path === "~" || path.startsWith("~/")) path = HOME + path.slice(1);
    const parts: string[] = [];
    for (const p of path.split("/")) {
      if (!p || p === ".") continue;
      if (p === "..") parts.pop();
      else parts.push(p);
    }
    return "/" + parts.join("/");
  }

  lookup(path: string): MockNode | undefined {
    let node: MockNode | undefined = this.root;
    for (const p of this.norm(path).split("/").filter(Boolean)) {
      node = node?.children?.get(p);
      if (!node) return undefined;
    }
    return node;
  }

  split(path: string): [string, string] {
    const n = this.norm(path);
    const i = n.lastIndexOf("/");
    return [i === 0 ? "/" : n.slice(0, i), n.slice(i + 1)];
  }

  entry(name: string, n: MockNode): Entry {
    return {
      name,
      kind: n.kind,
      targetIsDir: false,
      size: n.kind === "dir" ? 0 : n.size,
      mtime: n.mtime,
      hidden: name.startsWith("."),
    };
  }

  parentOf(path: string): string | null {
    return path === "/" ? null : this.split(path)[0];
  }

  snapshot(path: string): PanelEvent {
    let p = this.norm(path);
    let node = this.lookup(p);
    while (!node || node.kind !== "dir") {
      if (p === "/") return { type: "error", path, message: "not found" };
      p = this.split(p)[0];
      node = this.lookup(p);
    }
    const entries = [...node.children!].map(([name, n]) => this.entry(name, n));
    return { type: "snapshot", path: p, parent: this.parentOf(p), entries, stale: false, network: this.isNetwork(p) };
  }

  notify(dirPath: string, removed: string[], upsertedNames: string[]) {
    const d = this.lookup(dirPath);
    const upserted = upsertedNames
      .map((name) => [name, d?.children?.get(name)] as const)
      .filter((x): x is readonly [string, MockNode] => !!x[1])
      .map(([name, n]) => this.entry(name, n));
    // Deliver asynchronously, like the real watcher.
    setTimeout(() => {
      let watched = false;
      for (const { path, cb } of this.subs.values()) {
        if (path !== dirPath) continue;
        watched = true;
        cb({ type: "patch", path, removed, upserted });
      }
      // A watched directory's cached listing stays current; an unwatched one
      // goes stale until it's revalidated on the next open.
      if (watched) this.remember(dirPath);
    }, 30);
  }

  // Public helpers for tests: simulate external changes.
  touch(path: string, size = 0) {
    const [d, name] = this.split(path);
    const parent = this.lookup(d);
    if (!parent?.children) throw new Error("no parent");
    parent.children.set(name, file(size));
    this.notify(d, [], [name]);
  }

  remove(path: string) {
    const [d, name] = this.split(path);
    this.lookup(d)?.children?.delete(name);
    this.notify(d, [name], []);
  }
}

const fs = new MockFs();
if (typeof window !== "undefined") (window as unknown as { __mock: MockFs }).__mock = fs;

const delay = () => new Promise((r) => setTimeout(r, 5));

export const mockBackend: Backend = {
  async panelOpen(panel, path, onEvent, refresh = false) {
    await delay();
    const snap = fs.snapshot(path);
    if (snap.type !== "snapshot") {
      fs.subs.delete(panel);
      onEvent(snap);
      return;
    }
    const sub = { path: snap.path, cb: onEvent };
    fs.subs.set(panel, sub);
    const cached = fs.cache.get(snap.path);
    if (!cached || !(snap.network || refresh)) {
      fs.cache.set(snap.path, snap.entries);
      onEvent(snap);
      return;
    }
    // Stale-while-revalidate: the cached listing now, differences and `fresh` later.
    onEvent({ ...snap, entries: cached, stale: true });
    setTimeout(() => {
      if (fs.subs.get(panel) !== sub) return; // navigated away
      const cur = fs.snapshot(snap.path);
      if (cur.type !== "snapshot" || cur.path !== snap.path) return;
      const d = fs.diff(cached, cur.entries);
      fs.cache.set(snap.path, cur.entries);
      if (d) onEvent({ type: "patch", path: snap.path, ...d });
      onEvent({ type: "fresh", path: snap.path });
    }, fs.revalidateMs);
  },
  async homeDir() {
    return HOME;
  },
  async rename(dir, from, to) {
    const d = fs.lookup(dir);
    const node = d?.children?.get(from);
    if (!node) throw "source does not exist";
    if (!to || to.includes("/")) throw "invalid name";
    if (d!.children!.has(to) && to.toLowerCase() !== from.toLowerCase()) throw `"${to}" already exists`;
    d!.children!.delete(from);
    d!.children!.set(to, node);
    fs.notify(fs.norm(dir), [from], [to]);
  },
  async mkdir(dir, name) {
    const d = fs.lookup(dir);
    if (!d?.children) throw "no such directory";
    if (d.children.has(name)) throw `"${name}" already exists`;
    d.children.set(name, { kind: "dir", size: 0, mtime: Date.now(), children: new Map() });
    fs.notify(fs.norm(dir), [], [name]);
  },
  async trash(paths) {
    for (const p of paths) fs.remove(p);
  },
  async copyMove(kind, sources, destDir, onEvent) {
    const id = fs.nextOp++;
    const op = { cancelled: false, answer: null as null | ((c: [ConflictChoice, boolean]) => void) };
    fs.ops.set(id, op);
    const ask = (path: string) =>
      new Promise<[ConflictChoice, boolean]>((resolve) => {
        op.answer = resolve;
        onEvent({ type: "conflict", id, path });
      });
    void (async () => {
      const errors: string[] = [];
      let policy: ConflictChoice | null = null;
      const destPath = fs.norm(destDir);
      const dest = fs.lookup(destPath);
      for (const [i, src] of sources.entries()) {
        await new Promise((r) => setTimeout(r, 10));
        if (op.cancelled) return onEvent({ type: "cancelled", id });
        const [d, name] = fs.split(src);
        const node = fs.lookup(src);
        if (!node || !dest?.children) {
          errors.push(`${src}: not found`);
          continue;
        }
        let target = name;
        if (dest.children.has(name)) {
          let choice: ConflictChoice;
          if (d === destPath) choice = kind === "copy" ? "keepBoth" : "skip";
          else if (policy) choice = policy;
          else {
            const [c, all] = await ask(`${destPath}/${name}`);
            choice = c;
            if (all) policy = c;
          }
          if (choice === "cancel") return onEvent({ type: "cancelled", id });
          if (choice === "skip") continue;
          if (choice === "keepBoth") target = fs.freeName(dest, name);
          if (choice === "overwrite") dest.children.delete(name);
        }
        dest.children.set(target, kind === "copy" ? structuredClone(node) : node);
        if (kind === "move") {
          fs.lookup(d)!.children!.delete(name);
          fs.notify(d, [name], []);
        }
        fs.notify(destPath, [], [target]);
        onEvent({ type: "progress", id, filesDone: i + 1, filesTotal: sources.length, bytesDone: 0, bytesTotal: 0, current: name });
      }
      fs.ops.delete(id);
      onEvent({ type: "done", id, errors });
    })();
    return id;
  },
  async cancelOp(id) {
    const op = fs.ops.get(id);
    if (!op) return;
    op.cancelled = true;
    op.answer?.(["cancel", false]);
  },
  async resolveConflict(id, choice, applyToAll) {
    fs.ops.get(id)?.answer?.([choice, applyToAll]);
  },
  async openDefault(path) {
    console.info("[mock] open", path);
  },
  async readText(path, maxBytes) {
    const n = fs.lookup(path);
    if (!n || n.kind !== "file") throw "not a file";
    const text = n.content ?? "";
    const binary = n.content === undefined;
    return { text: binary ? "" : text.slice(0, maxBytes), truncated: text.length > maxBytes, binary, size: n.size };
  },
  async volumeInfo() {
    return { free: 123 * 1024 ** 3, total: 494 * 1024 ** 3 };
  },
  async prefsGet() {
    await delay();
    return { ...PREF_DEFAULTS, ...structuredClone(fs.prefs) } as Preferences;
  },
  async prefsSet(patch) {
    await delay();
    fs.prefs = mergePatch(fs.prefs, patch);
    return { ...PREF_DEFAULTS, ...structuredClone(fs.prefs) } as Preferences;
  },
  async stateGet() {
    await delay();
    return structuredClone(fs.state);
  },
  async stateSet(patch) {
    fs.state = mergePatch(fs.state, patch);
  },
  async setFullscreen(on) {
    fs.fullscreen = on;
  },
  async isFullscreen() {
    return fs.fullscreen;
  },
  async focusWindow() {
    fs.focusRequests++;
  },
  fileUrl(path) {
    return fs.lookup(path)?.url ?? `mock://${path}`;
  },
};
