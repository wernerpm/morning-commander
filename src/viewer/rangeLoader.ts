// Reads a file for libmedia through range requests on the app's own URL
// schemes. libmedia's FetchIOLoader only accepts http(s), so we do the fetching.
//
// Reads are served from cached segments; while one is consumed the next is
// already being fetched, so sequential playback rarely waits on a round trip.
// A server may answer with fewer bytes than asked (Tauri's asset protocol caps
// a range response at ~1 MB), so a segment covers whatever actually arrived.

import type { AVPlayerModule } from "./libmedia";

/** libmedia's IOError.END: end of stream. */
const IO_END = -1048576;
/** libmedia's generic I/O failure. */
const IO_FAIL = -1;

/** First segment after a seek: small, so playback starts (or resumes) quickly. */
export const MIN_SEGMENT_BYTES = 256 * 1024;
/** Segments double on sequential reads up to this. */
export const SEGMENT_BYTES = 4 * 1024 * 1024;
/** Segments kept around: the current one, the one being read ahead and a little history. */
const KEEP_SEGMENTS = 4;

export type FetchRange = (url: string, start: number, end: number) => Promise<ArrayBuffer>;

const fetchRange: FetchRange = async (url, start, end) => {
  const res = await fetch(url, { headers: { Range: `bytes=${start}-${end - 1}` } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.arrayBuffer();
};

interface Segment {
  start: number;
  /** End as requested; narrowed to what arrived once the data is in. */
  end: number;
  data: Promise<Uint8Array>;
}

/** Byte source with read-ahead; independent of libmedia so it can be unit tested. */
export class RangeReader {
  pos = 0;
  private segments: Segment[] = [];

  constructor(
    private url: string,
    readonly size: number,
    private fetcher: FetchRange = fetchRange,
    private maxSegment = SEGMENT_BYTES,
    private minSegment = MIN_SEGMENT_BYTES,
  ) {}

  private find(pos: number): Segment | undefined {
    return this.segments.find((s) => s.start <= pos && pos < s.end);
  }

  private fetchAt(start: number, bytes: number): Segment {
    const seg: Segment = {
      start,
      end: Math.min(this.size, start + bytes),
      data: Promise.resolve(new Uint8Array()),
    };
    seg.data = this.fetcher(this.url, start, seg.end).then((b) => {
      const data = new Uint8Array(b);
      if (data.length === 0) throw new Error(`empty response at ${start}`);
      seg.end = start + data.length;
      return data;
    });
    // A failed segment is dropped so the next read retries it.
    seg.data.catch(() => {
      this.segments = this.segments.filter((s) => s !== seg);
    });
    this.segments.push(seg);
    if (this.segments.length > KEEP_SEGMENTS) this.segments.shift();
    return seg;
  }

  /** Copies up to `out.length` bytes at `pos` into `out`; returns the count (0 at the end). */
  async read(out: Uint8Array): Promise<number> {
    if (this.pos >= this.size) return 0;
    let seg = this.find(this.pos) ?? this.fetchAt(this.pos, this.minSegment);
    let data = await seg.data;
    // Short response that ended before pos (only possible for a guessed end): fetch from pos.
    while (this.pos >= seg.end) {
      seg = this.find(this.pos) ?? this.fetchAt(this.pos, this.minSegment);
      data = await seg.data;
    }
    if (seg.end < this.size && !this.find(seg.end)) {
      const next = Math.min(this.maxSegment, Math.max(this.minSegment, 2 * data.length));
      void this.fetchAt(seg.end, next).data.catch(() => {});
    }
    const offset = this.pos - seg.start;
    const n = Math.min(out.length, data.length - offset);
    out.set(data.subarray(offset, offset + n));
    this.pos += n;
    return n;
  }
}

/** Total size of the file behind `url`, from a one-byte range request. */
export async function probeSize(url: string): Promise<number> {
  const res = await fetch(url, { headers: { Range: "bytes=0-0" } });
  const range = res.headers.get("content-range"); // "bytes 0-0/12345"
  const total = range ? Number(range.slice(range.lastIndexOf("/") + 1)) : NaN;
  if (Number.isFinite(total)) return total;
  const len = Number(res.headers.get("content-length"));
  if (res.status === 200 && Number.isFinite(len)) return len;
  throw new Error("can't determine file size");
}

/**
 * A libmedia CustomIOLoader over `url`. Built from the runtime-loaded module's
 * base class, because AVPlayer.load checks `instanceof` against its own copy.
 */
export function rangeIOLoader(AVPlayer: AVPlayerModule, url: string, ext: string) {
  type Buffer = Parameters<InstanceType<typeof AVPlayer.IOLoader.CustomIOLoader>["read"]>[0];

  class RangeIOLoader extends AVPlayer.IOLoader.CustomIOLoader {
    private reader: RangeReader | undefined;

    override get ext(): string {
      return ext;
    }

    override get name(): string {
      return url;
    }

    async open(): Promise<number> {
      try {
        this.reader = new RangeReader(url, await probeSize(url));
        return 0;
      } catch (e) {
        console.warn("media open:", e);
        return IO_FAIL;
      }
    }

    async read(buffer: Buffer): Promise<number> {
      if (!this.reader) return IO_FAIL;
      try {
        const n = await this.reader.read(buffer as unknown as Uint8Array);
        return n === 0 ? IO_END : n;
      } catch (e) {
        console.warn("media read:", e);
        return IO_FAIL;
      }
    }

    async seek(pos: bigint): Promise<number> {
      if (!this.reader) return IO_FAIL;
      this.reader.pos = Number(pos);
      return 0;
    }

    async size(): Promise<bigint> {
      return BigInt(this.reader?.size ?? 0);
    }

    async stop(): Promise<void> {
      this.reader = undefined;
    }
  }
  return new RangeIOLoader();
}
