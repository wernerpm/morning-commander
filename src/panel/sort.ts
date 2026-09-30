import { isNavigable, type Entry } from "../ipc/types";

export type SortKey = "name" | "ext" | "size" | "mtime" | "none";

export interface SortSpec {
  key: SortKey;
  desc: boolean;
}

// Case- and accent-insensitive, numeric-aware: "report 2" < "Report 10".
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

export function extOf(name: string): string {
  const i = name.lastIndexOf(".");
  return i > 0 ? name.slice(i + 1).toLowerCase() : "";
}

function byName(a: Entry, b: Entry): number {
  return collator.compare(a.name, b.name) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
}

function compareWithin(key: SortKey, a: Entry, b: Entry): number {
  switch (key) {
    case "ext":
      return collator.compare(extOf(a.name), extOf(b.name)) || byName(a, b);
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
