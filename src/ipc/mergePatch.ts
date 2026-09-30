// RFC 7386 JSON merge patch, as applied by Rust to preferences.json and
// state.json (docs/ipc.md). Used by the mock backend and the frontend's copy.

type Json = unknown;

function isObject(v: Json): v is Record<string, Json> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Returns a new value; neither argument is modified. */
export function mergePatch<T>(target: T, patch: Json): T {
  if (!isObject(patch)) return structuredClone(patch) as T;
  const out: Record<string, Json> = isObject(target) ? { ...target } : {};
  for (const [k, v] of Object.entries(patch)) {
    if (v === null) delete out[k];
    else out[k] = mergePatch(out[k], v);
  }
  return out as T;
}
