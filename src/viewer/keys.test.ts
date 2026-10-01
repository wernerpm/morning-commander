import { describe, expect, it } from "vitest";
import { navGroup, stepInGroup, viewKind } from "./kind";
import { clampTime, clampVolume, formatTime, imageKey, mediaKey, pdfKey, shellKey, type KeyLike } from "./keys";

const k = (key: string, mods: Partial<KeyLike> = {}): KeyLike => ({
  key, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...mods,
});

describe("mediaKey", () => {
  it("seeks ±5 s with ←/→ and ±1 min with ↑/↓", () => {
    expect(mediaKey(k("ArrowLeft"))).toEqual({ type: "seek", by: -5 });
    expect(mediaKey(k("ArrowRight"))).toEqual({ type: "seek", by: 5 });
    expect(mediaKey(k("ArrowUp"))).toEqual({ type: "seek", by: 60 });
    expect(mediaKey(k("ArrowDown"))).toEqual({ type: "seek", by: -60 });
  });
  it("changes volume with = and -, toggles with Space and M", () => {
    expect(mediaKey(k("="))).toEqual({ type: "volume", by: 0.05 });
    expect(mediaKey(k("+", { shiftKey: true }))).toEqual({ type: "volume", by: 0.05 });
    expect(mediaKey(k("-"))).toEqual({ type: "volume", by: -0.05 });
    expect(mediaKey(k(" "))).toEqual({ type: "togglePlay" });
    expect(mediaKey(k("m"))).toEqual({ type: "mute" });
  });
  it("leaves ⌘-arrows and F to the shell", () => {
    expect(mediaKey(k("ArrowRight", { metaKey: true }))).toBeNull();
    expect(mediaKey(k("f"))).toBeNull();
    expect(mediaKey(k("Escape"))).toBeNull();
  });
});

describe("pdfKey", () => {
  it("takes every arrow so they never change file", () => {
    for (const a of ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"]) expect(pdfKey(k(a))).not.toBeNull();
    expect(pdfKey(k("ArrowDown"))).toEqual({ type: "scroll", y: 0.1 });
  });
  it("pages with Space / ⇧Space and PageUp/PageDown, Home/End jump", () => {
    expect(pdfKey(k(" "))).toEqual({ type: "page", by: 1 });
    expect(pdfKey(k(" ", { shiftKey: true }))).toEqual({ type: "page", by: -1 });
    expect(pdfKey(k("PageUp"))).toEqual({ type: "page", by: -1 });
    expect(pdfKey(k("Home"))).toEqual({ type: "top" });
    expect(pdfKey(k("End"))).toEqual({ type: "bottom" });
  });
  it("leaves ⌘→ to the shell", () => {
    expect(pdfKey(k("ArrowRight", { metaKey: true }))).toBeNull();
  });
});

describe("imageKey and shellKey", () => {
  it("image zoom keys only", () => {
    expect(imageKey(k("+"))).toEqual({ type: "zoom", factor: 1.25 });
    expect(imageKey(k("0"))).toEqual({ type: "zoomReset" });
    expect(imageKey(k("ArrowRight"))).toBeNull();
  });
  it("shell: Esc, F, ⌘O, ⌘←/⌘→, plain arrows and paging", () => {
    expect(shellKey(k("Escape"))).toEqual({ type: "escape" });
    expect(shellKey(k("F", { shiftKey: true }))).toEqual({ type: "fullscreen" });
    expect(shellKey(k("o", { metaKey: true }))).toEqual({ type: "openDefault" });
    expect(shellKey(k("ArrowLeft", { metaKey: true }))).toEqual({ type: "nav", to: "prev" });
    expect(shellKey(k("PageDown"))).toEqual({ type: "nav", to: "next" });
    expect(shellKey(k("f", { metaKey: true }))).toBeNull();
    expect(shellKey(k("x"))).toBeNull();
  });
});

describe("helpers", () => {
  it("clamps time and volume", () => {
    expect(clampTime(-3, 10)).toBe(0);
    expect(clampTime(12, 10)).toBe(10);
    expect(clampTime(12, NaN)).toBe(12);
    expect(clampVolume(1.04)).toBe(1);
    expect(clampVolume(0.8 - 0.05)).toBe(0.75);
    expect(clampVolume(-0.01)).toBe(0);
  });
  it("formats times", () => {
    expect(formatTime(75)).toBe("1:15");
    expect(formatTime(3725)).toBe("1:02:05");
    expect(formatTime(NaN)).toBe("–:––");
  });
});

describe("navigation groups", () => {
  const files = ["a.jpg", "b.mp4", "c.png", "d.txt", "e.zip", "f.heic", "g.pdf"];
  const groups = files.map((f) => navGroup(viewKind(f)));
  it("skips files of other kinds", () => {
    expect(stepInGroup(groups, 0, "next")).toBe(2);
    expect(stepInGroup(groups, 2, "next")).toBe(5);
    expect(stepInGroup(groups, 5, "prev")).toBe(2);
    expect(stepInGroup(groups, 5, "next")).toBe(5); // last photo: stays
    expect(stepInGroup(groups, 1, "next")).toBe(1); // only video
  });
  it("groups text and unknown files together", () => {
    expect(stepInGroup(groups, 3, "next")).toBe(4);
    expect(stepInGroup(groups, 4, "first")).toBe(3);
    expect(stepInGroup(groups, 0, "last")).toBe(5);
  });
});
