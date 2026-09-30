// In-memory backend used outside Tauri (plain browser, Playwright tests).
// Behaves like the Rust side: snapshots on open, patches on change.
// Tests can reach it as `window.__mock` to simulate external FS changes.

import type { Backend } from "./index";
import type { Entry, OpEvent, PanelEvent, PanelId } from "./types";

interface MockNode {
  kind: "file" | "dir";
  size: number;
  mtime: number;
  children?: Map<string, MockNode>;
  content?: string;
}

const HOME = "/Users/demo";

function file(size = 1234, content?: string): MockNode {
  return { kind: "file", size, mtime: Date.UTC(2026, 8, 1, 12), content };
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
          "report.pdf": file(84_000),
          "notes.md": file(300, "# Notes\n\nhello from the mock backend\n"),
          "budget.csv": file(900, "a,b\n1,2\n"),
        }),
        Downloads: dir({ "movie.mp4": file(50_000_000), "archive.zip": file(3_000_000) }),
        Pictures: dir({ "beach.jpg": file(2_000_000), "cat.png": file(500_000), "Sunset.heic": file(1_500_000) }),
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
    return { type: "snapshot", path: p, parent: this.parentOf(p), entries };
  }

  notify(dirPath: string, removed: string[], upsertedNames: string[]) {
    const d = this.lookup(dirPath);
    const upserted = upsertedNames
      .map((name) => [name, d?.children?.get(name)] as const)
      .filter((x): x is readonly [string, MockNode] => !!x[1])
      .map(([name, n]) => this.entry(name, n));
    // Deliver asynchronously, like the real watcher.
    setTimeout(() => {
      for (const { path, cb } of this.subs.values()) {
        if (path === dirPath) cb({ type: "patch", path, removed, upserted });
      }
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
  async panelOpen(panel, path, onEvent) {
    await delay();
    const snap = fs.snapshot(path);
    fs.subs.set(panel, { path: snap.path, cb: onEvent });
    onEvent(snap);
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
    const dest = fs.lookup(destDir);
    const errors: string[] = [];
    sources.forEach((src, i) => {
      const [d, name] = fs.split(src);
      const node = fs.lookup(src);
      if (!node || !dest?.children) return errors.push(`${src}: not found`);
      if (dest.children.has(name)) return errors.push(`${name}: already exists, skipped`);
      dest.children.set(name, kind === "copy" ? structuredClone(node) : node);
      if (kind === "move") {
        fs.lookup(d)!.children!.delete(name);
        fs.notify(d, [name], []);
      }
      fs.notify(fs.norm(destDir), [], [name]);
      const ev: OpEvent = {
        type: "progress", id, filesDone: i + 1, filesTotal: sources.length,
        bytesDone: 0, bytesTotal: 0, current: name,
      };
      setTimeout(() => onEvent(ev), 10);
    });
    setTimeout(() => onEvent({ type: "done", id, errors }), 50);
    return id;
  },
  async cancelOp() {},
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
  fileUrl(path) {
    return `mock://${path}`;
  },
};
