// RFC 7386 JSON merge patch, as applied by prefs_set / state_set on the Rust
// side. Used by the mock backend and the settings module's local copies.

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Returns a new value; neither `target` nor `patch` is modified. */
export function mergePatch<T = unknown>(target: unknown, patch: unknown): T {
  if (!isObject(patch)) return structuredClone(patch) as T;
  const out: Record<string, unknown> = isObject(target) ? { ...target } : {};
  for (const [k, v] of Object.entries(patch)) {
    if (v === null) delete out[k];
    else out[k] = mergePatch(out[k], v);
  }
  return out as T;
}
