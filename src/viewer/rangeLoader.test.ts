import { describe, expect, it } from "vitest";
import { RangeReader, type FetchRange } from "./rangeLoader";

const SIZE = 1000;
const byte = (i: number) => i % 251;

/** A fake server over a SIZE-byte file; `cap` mimics servers that answer short ranges. */
function server(cap = Infinity) {
  const calls: [number, number][] = [];
  let failNext = false;
  const fetcher: FetchRange = async (_url, start, end) => {
    calls.push([start, end]);
    if (failNext) {
      failNext = false;
      throw new Error("network down");
    }
    const n = Math.min(end - start, cap);
    return Uint8Array.from({ length: n }, (_, i) => byte(start + i)).buffer;
  };
  return { fetcher, calls, fail: () => (failNext = true) };
}

async function readAll(r: RangeReader, chunk: number): Promise<number[]> {
  const out: number[] = [];
  const buf = new Uint8Array(chunk);
  for (;;) {
    const n = await r.read(buf);
    if (n === 0) return out;
    out.push(...buf.subarray(0, n));
  }
}

describe("RangeReader", () => {
  it("reads a file sequentially and prefetches the next segment", async () => {
    const s = server();
    const r = new RangeReader("u", SIZE, s.fetcher, 300, 300);
    const data = await readAll(r, 128);
    expect(data).toEqual(Array.from({ length: SIZE }, (_, i) => byte(i)));
    expect(s.calls).toEqual([[0, 300], [300, 600], [600, 900], [900, 1000]]);
  });

  it("starts small after a seek and grows segments on sequential reads", async () => {
    const s = server();
    const r = new RangeReader("u", SIZE, s.fetcher, 400, 50);
    await readAll(r, 64);
    expect(s.calls).toEqual([[0, 50], [50, 150], [150, 350], [350, 750], [750, 1000]]);
    s.calls.length = 0;
    r.pos = 500; // segment 350-750 is still cached
    await r.read(new Uint8Array(1));
    r.pos = 10; // evicted: small segment again
    await r.read(new Uint8Array(1));
    expect(s.calls[0]).toEqual([10, 60]);
  });

  it("handles servers that answer with fewer bytes than asked", async () => {
    const s = server(70); // like Tauri's asset protocol capping ranges
    const r = new RangeReader("u", SIZE, s.fetcher, 300, 300);
    const data = await readAll(r, 128);
    expect(data).toEqual(Array.from({ length: SIZE }, (_, i) => byte(i)));
    // Read-ahead continues from where each short answer ended.
    expect(s.calls.slice(0, 3)).toEqual([[0, 300], [70, 370], [140, 440]]);
  });

  it("seeks to any position and reuses fetched segments", async () => {
    const s = server();
    const r = new RangeReader("u", SIZE, s.fetcher, 300, 300);
    const buf = new Uint8Array(10);
    r.pos = 950;
    expect(await r.read(buf)).toBe(10);
    expect([...buf]).toEqual(Array.from({ length: 10 }, (_, i) => byte(950 + i)));
    r.pos = 0;
    await r.read(buf);
    r.pos = 960; // still cached
    await r.read(buf);
    expect(s.calls.filter(([a]) => a === 950)).toHaveLength(1);
    r.pos = SIZE;
    expect(await r.read(buf)).toBe(0);
  });

  it("retries a segment whose fetch failed", async () => {
    const s = server();
    const r = new RangeReader("u", SIZE, s.fetcher, 300, 300);
    const buf = new Uint8Array(10);
    s.fail();
    await expect(r.read(buf)).rejects.toThrow("network down");
    expect(await r.read(buf)).toBe(10);
    expect([...buf]).toEqual(Array.from({ length: 10 }, (_, i) => byte(i)));
  });
});
