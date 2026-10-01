import { describe, expect, it } from "vitest";
import { formatBytesLong, formatSize } from "./format";

describe("size formatting", () => {
  it("compact column form", () => {
    expect(formatSize(9999)).toBe("9999");
    expect(formatSize(12_345)).toBe("12.1K");
  });

  it("long footer form always has a unit", () => {
    expect(formatBytesLong(512)).toBe("512 B");
    expect(formatBytesLong(7165)).toBe("7.0 KB");
    expect(formatBytesLong(12_345)).toBe("12.1 KB");
    expect(formatBytesLong(2.2 * 1024 ** 4)).toBe("2.2 TB");
    expect(formatBytesLong(113 * 1024 ** 3)).toBe("113 GB");
  });
});
