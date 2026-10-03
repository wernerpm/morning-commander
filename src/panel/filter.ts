// Fuzzy filter (⌘F): the panel shows only entries whose name contains the
// typed characters in order, anywhere in the name. See
// docs/implementation-plan.md, "Fuzzy filter".

import type { Entry } from "../ipc/types";
import { fold } from "./jump";

export interface FilterMatch {
  /** Higher is better: substring beats scattered, word start beats mid-word, earlier beats later. */
  score: number;
  /** Matched code point indices into `[...name]`, ascending, for highlighting. */
  positions: number[];
}

interface Folded {
  text: string; // folded name
  owner: number[]; // folded char index → code point index in the original name
}

// Folding per code point keeps a map back to the original name; entries are
// immutable (patches replace them), so caching by object is safe.
const cache = new WeakMap<Entry, Folded>();

function folded(e: Entry): Folded {
  let f = cache.get(e);
  if (!f) {
    if (/^[\x00-\x7f]*$/.test(e.name)) {
      // ASCII: folding is just lowercasing and indices line up.
      f = { text: e.name.toLowerCase(), owner: Array.from({ length: e.name.length }, (_, i) => i) };
    } else {
      let text = "";
      const owner: number[] = [];
      [...e.name].forEach((c, i) => {
        const x = fold(c);
        text += x;
        for (let k = 0; k < x.length; k++) owner.push(i);
      });
      f = { text, owner };
    }
    cache.set(e, f);
  }
  return f;
}

const isWordChar = (c: string) => /[\p{L}\p{N}]/u.test(c);
const atWordStart = (s: string, i: number) => i === 0 || !isWordChar(s[i - 1]);

function positionsOf(f: Folded, idx: number[]): number[] {
  const out: number[] = [];
  for (const i of idx) if (out[out.length - 1] !== f.owner[i]) out.push(f.owner[i]);
  return out;
}

/** Fold the typed query the same way names are folded. */
export function foldQuery(q: string): string {
  return fold(q);
}

/** Match `e` against an already folded, non-empty query; `null` when it doesn't match. */
export function filterMatch(e: Entry, q: string): FilterMatch | null {
  if (e.name === "..") return null;
  const f = folded(e);
  const s = f.text;

  // 1. Contiguous substring, preferring an occurrence at a word start.
  const first = s.indexOf(q);
  if (first >= 0) {
    let at = first;
    for (let i = first; i >= 0; i = s.indexOf(q, i + 1)) {
      if (atWordStart(s, i)) {
        at = i;
        break;
      }
    }
    const score = 2000 + (at === 0 ? 500 : atWordStart(s, at) ? 250 : 0) - Math.min(at, 200);
    return { score, positions: positionsOf(f, Array.from({ length: q.length }, (_, k) => at + k)) };
  }

  // 2. Scattered: characters in order (greedy, leftmost).
  const idx: number[] = [];
  let j = 0;
  for (let i = 0; i < s.length && j < q.length; i++) {
    if (s[i] === q[j]) {
      idx.push(i);
      j++;
    }
  }
  if (j < q.length) return null;
  const span = idx[idx.length - 1] - idx[0] + 1;
  const starts = idx.filter((i) => atWordStart(s, i)).length;
  const score = 1000 - (span - q.length) * 10 + starts * 20 - Math.min(idx[0], 200);
  return { score, positions: positionsOf(f, idx) };
}

export interface FilterResult {
  rows: Entry[]; // matching entries, in the panel's sort order
  best: number; // index in `rows` of the best match, or 0
}

/** Filter `entries` (already sorted) by `query`. Keeps the sort order; reports the best match. */
export function applyFilter(entries: Entry[], query: string): FilterResult {
  const q = foldQuery(query);
  const rows: Entry[] = [];
  let best = 0;
  let bestScore = -Infinity;
  for (const e of entries) {
    const m = filterMatch(e, q);
    if (!m) continue;
    if (m.score > bestScore) {
      bestScore = m.score;
      best = rows.length;
    }
    rows.push(e);
  }
  return { rows, best };
}
