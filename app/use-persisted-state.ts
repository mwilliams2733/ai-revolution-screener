"use client";

import { useEffect, useState } from "react";

/**
 * State that survives a reload. (Finding U4)
 *
 * Sort and filter choices were plain useState, so every refresh dropped the
 * user back to RS-descending / all-sectors. On a phone, where reloads are
 * constant, that is friction on every single visit.
 *
 * Reads on mount rather than during render: localStorage does not exist on the
 * server, and seeding initial state from it would produce a hydration mismatch.
 * The one-frame flash of the default is the honest cost of server rendering.
 */
export function usePersistedState<T>(
  key: string,
  initial: T,
  isValid: (v: unknown) => v is T,
): [T, (v: T) => void] {
  const [value, setValue] = useState<T>(initial);

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(key);
      if (raw == null) return;
      const parsed: unknown = JSON.parse(raw);
      // Validate rather than trust: a stale key from an earlier version could
      // otherwise put the table into a state the current code cannot render.
      if (isValid(parsed)) setValue(parsed);
    } catch {
      // Private mode, quota, or corrupt JSON: fall back to the default.
    }
  }, [key, isValid]);

  const update = (v: T) => {
    setValue(v);
    try {
      window.localStorage.setItem(key, JSON.stringify(v));
    } catch {
      // Persistence is a convenience, never a requirement.
    }
  };

  return [value, update];
}
