import { describe, expect, it } from "vitest";
import { mediaEngine, viewKind } from "./kind";

describe("media kinds and engines", () => {
  it("plays WebKit formats natively", () => {
    for (const n of ["a.mp4", "b.MOV", "c.m4v", "d.webm", "e.mp3", "f.flac"]) {
      expect(mediaEngine(n)).toBe("native");
    }
  });

  it("plays other containers with libmedia", () => {
    expect(viewKind("Movie.2019.mkv")).toBe("video");
    expect(viewKind("/Volumes/<share>/clip.AVI")).toBe("video");
    expect(viewKind("rec.m2ts")).toBe("video");
    expect(viewKind("track.opus")).toBe("audio");
    for (const n of ["Movie.2019.mkv", "clip.avi", "rec.ts", "rec.m2ts", "old.mpg", "x.vob", "track.dts"]) {
      expect(mediaEngine(n)).toBe("libmedia");
    }
  });

  it("keeps .ts as text (TypeScript) by name", () => {
    expect(viewKind("App.ts")).toBe("text");
  });

  it("leaves formats nobody can play as other", () => {
    expect(viewKind("clip.wmv")).toBe("other");
  });
});
