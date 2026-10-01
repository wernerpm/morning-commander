// Decides how the viewer renders a file, by lowercase extension.

export type ViewKind = "image" | "pdf" | "video" | "audio" | "text" | "other";

const IMAGE = new Set([
  "png", "jpg", "jpeg", "gif", "webp", "avif", "heic", "heif", "bmp", "tif", "tiff", "svg", "ico",
]);
// WebKit's own player (AVFoundation) handles these containers.
const NATIVE_VIDEO = new Set(["mp4", "m4v", "mov", "webm"]);
const NATIVE_AUDIO = new Set(["mp3", "m4a", "aac", "wav", "flac", "aiff", "ogg"]);
// libmedia (WASM/WebCodecs) handles these; see step-12. No .wmv/.asf: libmedia has no ASF demuxer.
// ".ts" is TypeScript first: the viewer plays it as MPEG-TS only when it sniffs as binary.
const LIBMEDIA_VIDEO = new Set([
  "mkv", "avi", "m2ts", "mts", "mpg", "mpeg", "vob", "flv", "ogv", "3gp", "divx", "f4v",
]);
const LIBMEDIA_AUDIO = new Set(["opus", "ac3", "dts", "mka", "oga", "mp2"]);
const TEXT = new Set([
  "txt", "md", "markdown", "json", "jsonc", "toml", "yaml", "yml",
  "rs", "ts", "tsx", "js", "jsx", "mjs", "cjs", "css", "scss", "html", "htm", "xml",
  "csv", "tsv", "log", "sh", "zsh", "bash", "fish", "py", "rb", "go", "java", "kt", "kts",
  "swift", "c", "h", "cpp", "hpp", "cs", "sql", "ini", "conf", "cfg", "env", "gitignore",
  "dockerfile", "makefile", "lock", "plist",
]);
// Extensionless (or dotfile) names that are nearly always text.
const TEXT_NAMES = new Set([
  "makefile", "dockerfile", "readme", "license", "licence", "copying", "changelog",
  "authors", "notice", "gemfile", "rakefile", "procfile", "brewfile", "justfile",
]);

export function extension(name: string): string {
  const dot = name.lastIndexOf(".");
  // A leading dot is a hidden file, not an extension separator (".zshrc" → "zshrc").
  return dot < 0 ? "" : name.slice(dot + 1).toLowerCase();
}

export function viewKind(name: string): ViewKind {
  const base = name.slice(name.lastIndexOf("/") + 1);
  if (TEXT_NAMES.has(base.toLowerCase())) return "text";
  const ext = extension(base);
  if (IMAGE.has(ext)) return "image";
  if (ext === "pdf") return "pdf";
  if (NATIVE_VIDEO.has(ext) || LIBMEDIA_VIDEO.has(ext)) return "video";
  if (NATIVE_AUDIO.has(ext) || LIBMEDIA_AUDIO.has(ext)) return "audio";
  if (TEXT.has(ext)) return "text";
  return "other";
}

/**
 * Which player a video/audio file starts with. "native" (the <video> element) falls
 * back to "libmedia" when WebKit can't decode the file (e.g. an MP4 with AC-3 audio).
 */
export type MediaEngine = "native" | "libmedia";

export function mediaEngine(name: string): MediaEngine {
  const ext = extension(name.slice(name.lastIndexOf("/") + 1));
  return NATIVE_VIDEO.has(ext) || NATIVE_AUDIO.has(ext) ? "native" : "libmedia";
}

/**
 * Files the viewer steps through together: "next" from a photo goes to the
 * next photo, skipping videos and documents. Text and unknown files share a group.
 */
export type NavGroup = "image" | "video" | "audio" | "pdf" | "document";

export function navGroup(kind: ViewKind): NavGroup {
  return kind === "text" || kind === "other" ? "document" : kind;
}

/** Index of the previous/next/first/last file in `files` in the same group as `files[from]`. */
export function stepInGroup(
  groups: NavGroup[],
  from: number,
  to: "prev" | "next" | "first" | "last",
): number {
  const g = groups[from];
  if (g === undefined) return from;
  switch (to) {
    case "prev":
      for (let i = from - 1; i >= 0; i--) if (groups[i] === g) return i;
      return from;
    case "next":
      for (let i = from + 1; i < groups.length; i++) if (groups[i] === g) return i;
      return from;
    case "first":
      return groups.indexOf(g);
    case "last":
      return groups.lastIndexOf(g);
  }
}
