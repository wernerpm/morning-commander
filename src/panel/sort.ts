import { isNavigable, type Entry } from "../ipc/types";

export type SortKey = "name" | "ext" | "size" | "mtime" | "none";

export interface SortSpec {
  key: SortKey;
  desc: boolean;
}

// Case- and accent-insensitive, numeric-aware: "report 2" < "Report 10".
// Sorting 100k names with Intl.Collator takes ~200 ms in WKWebView, so we
// compare precomputed keys with plain string comparison instead (~15 ms).
// Key: diacritics stripped, lowercased, each digit run prefixed by its length
// (leading zeros dropped) so "2" → "\u00012" sorts before "10" → "\u000210".
const keyCache = new Map<string, string>();
const MAX_CACHE = 400_000;

export function sortKey(name: string): string {
  let k = keyCache.get(name);
  if (k === undefined) {
    const folded = /^[\x20-\x7e]*$/.test(name) ? name.toLowerCase() : name.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
    k = folded.replace(/\d+/g, (d) => {
      const n = d.replace(/^0+(?=\d)/, "");
      return String.fromCharCode(n.length) + n;
    });
    if (keyCache.size >= MAX_CACHE) keyCache.clear();
    keyCache.set(name, k);
  }
  return k;
}

function cmpStr(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function extOf(name: string): string {
  const i = name.lastIndexOf(".");
  return i > 0 ? name.slice(i + 1).toLowerCase() : "";
}

function byName(a: Entry, b: Entry): number {
  return cmpStr(sortKey(a.name), sortKey(b.name)) || cmpStr(a.name, b.name);
}

function compareWithin(key: SortKey, a: Entry, b: Entry): number {
  switch (key) {
    case "ext":
      return cmpStr(extOf(a.name), extOf(b.name)) || byName(a, b);
    case "size":
      return a.size - b.size || byName(a, b);
    case "mtime":
      return a.mtime - b.mtime || byName(a, b);
    default:
      return byName(a, b);
  }
}

/** Comparator: directories first (MC order), then by `spec` within each group. */
export function comparator(spec: SortSpec): (a: Entry, b: Entry) => number {
  return (a, b) => {
    const da = isNavigable(a);
    const db = isNavigable(b);
    if (da !== db) return da ? -1 : 1;
    if (spec.key === "none") return 0;
    const c = compareWithin(da && (spec.key === "size" || spec.key === "ext") ? "name" : spec.key, a, b);
    return spec.desc ? -c : c;
  };
}

/**
 * Sort a whole listing. Same order as `comparator(spec)`, but computes each
 * entry's key once (decorate-sort-undecorate): with 100k entries in random
 * order the comparator would otherwise do ~3.4M key lookups (~850 ms).
 */
export function sortEntries(list: Entry[], spec: SortSpec): Entry[] {
  if (spec.key === "none") return list.slice().sort(comparator(spec));
  const dec = list.map((e) => {
    const dir = isNavigable(e);
    const k = sortKey(e.name);
    return { e, dir, k, ext: spec.key === "ext" && !dir ? extOf(e.name) : "", num: spec.key === "size" ? (dir ? 0 : e.size) : e.mtime };
  });
  const sign = spec.desc ? -1 : 1;
  dec.sort((a, b) => {
    if (a.dir !== b.dir) return a.dir ? -1 : 1;
    let c = 0;
    if (spec.key === "ext") c = cmpStr(a.ext, b.ext);
    else if (spec.key === "size" && !a.dir) c = a.num - b.num;
    else if (spec.key === "mtime") c = a.num - b.num;
    c = c || cmpStr(a.k, b.k) || cmpStr(a.e.name, b.e.name);
    return sign * c;
  });
  return dec.map((d) => d.e);
}

/** Index at which `e` should be inserted into the already-sorted `rows`. */
export function insertionIndex(rows: Entry[], e: Entry, cmp: (a: Entry, b: Entry) => number): number {
  let lo = 0;
  let hi = rows.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (cmp(rows[mid], e) <= 0) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}
