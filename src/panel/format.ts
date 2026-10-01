import type { Entry } from "../ipc/types";

const UNITS = ["B", "K", "M", "G", "T"];

/** Compact size, 6 chars max: "1234", "12.3K", "4.0G". */
export function formatSize(bytes: number): string {
  if (bytes < 10_000) return String(bytes);
  let v = bytes;
  let u = 0;
  while (v >= 1024 && u < UNITS.length - 1) {
    v /= 1024;
    u++;
  }
  return `${v < 100 ? v.toFixed(1) : Math.round(v)}${UNITS[u]}`;
}

/** Footer form: "512 B", "7.0 KB", "2.0 TB". */
export function formatBytesLong(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  let v = bytes;
  let u = 0;
  while (v >= 1024 && u < UNITS.length - 1) {
    v /= 1024;
    u++;
  }
  return `${v < 100 ? v.toFixed(1) : Math.round(v)} ${UNITS[u]}B`;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const pad = (n: number) => String(n).padStart(2, "0");

/** ls-style: "Sep 30 20:33" within the last ~6 months, "Oct 19  2025" otherwise. */
export function formatMtime(ms: number, now = Date.now()): string {
  if (!ms) return "";
  const d = new Date(ms);
  const mon = MONTHS[d.getMonth()];
  const day = String(d.getDate()).padStart(2, " ");
  if (Math.abs(now - ms) < 182 * 86_400_000) return `${mon} ${day} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return `${mon} ${day}  ${d.getFullYear()}`;
}

export function sizeColumn(e: Entry): string {
  if (e.name === "..") return "UP--DIR";
  if (e.kind === "dir" || (e.kind === "symlink" && e.targetIsDir)) return "<DIR>";
  return formatSize(e.size);
}
