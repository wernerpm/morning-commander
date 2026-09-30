// Type-to-jump: printable keys move the cursor to the next entry whose name
// starts with the typed prefix. See docs/implementation-plan.md, "Type-to-jump".

import type { Entry } from "../ipc/types";

export const JUMP_TIMEOUT_MS = 1000;

export interface JumpState {
  buffer: string;
  at: number; // timestamp of the last key
}

export const emptyJump: JumpState = { buffer: "", at: 0 };

/** Lowercase and strip diacritics so "É" matches "e". */
export function fold(s: string): string {
  return s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
}

function find(rows: Entry[], prefix: string, start: number): number {
  const n = rows.length;
  if (n === 0) return -1;
  const p = fold(prefix);
  for (let k = 0; k < n; k++) {
    const i = (((start + k) % n) + n) % n;
    if (rows[i].name !== ".." && fold(rows[i].name).startsWith(p)) return i;
  }
  return -1;
}

export interface JumpResult {
  state: JumpState;
  cursor: number; // new cursor, or the old one if nothing matched
  matched: boolean;
}

/**
 * Apply one typed character.
 * - Within the timeout, characters extend the prefix ("r","e" → "re"),
 *   matching from the current row.
 * - Repeating the same single character ("s","s") cycles through entries
 *   starting with it, unless something actually starts with "ss".
 * - After the timeout a new prefix starts, searching from the row after the
 *   cursor, so pressing "s" slowly also cycles.
 */
export function jumpKey(rows: Entry[], cursor: number, state: JumpState, ch: string, now: number): JumpResult {
  const fresh = now - state.at > JUMP_TIMEOUT_MS || state.buffer === "";
  if (fresh) {
    const i = find(rows, ch, cursor + 1);
    return { state: { buffer: ch, at: now }, cursor: i >= 0 ? i : cursor, matched: i >= 0 };
  }
  const candidate = state.buffer + ch;
  const i = find(rows, candidate, cursor);
  if (i >= 0) return { state: { buffer: candidate, at: now }, cursor: i, matched: true };
  const sameChar = [...candidate].every((c) => fold(c) === fold(ch));
  if (sameChar) {
    const j = find(rows, ch, cursor + 1);
    return { state: { buffer: ch, at: now }, cursor: j >= 0 ? j : cursor, matched: j >= 0 };
  }
  return { state: { buffer: candidate, at: now }, cursor, matched: false };
}

/** Backspace inside an active buffer: shorten it and re-match from the top of the current match. */
export function jumpBackspace(rows: Entry[], cursor: number, state: JumpState, now: number): JumpResult {
  const buffer = state.buffer.slice(0, -1);
  if (!buffer) return { state: emptyJump, cursor, matched: true };
  const i = find(rows, buffer, 0);
  return { state: { buffer, at: now }, cursor: i >= 0 ? i : cursor, matched: i >= 0 };
}

export function jumpActive(state: JumpState, now: number): boolean {
  return state.buffer !== "" && now - state.at <= JUMP_TIMEOUT_MS;
}
