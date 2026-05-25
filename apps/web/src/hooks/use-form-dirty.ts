'use client';

import { useEffect, useMemo } from 'react';

export interface FormDirtyState<T> {
  isDirty: boolean;
  dirtyFields: Set<keyof T>;
}

/**
 * Compare a `current` form state against the `initial` snapshot and
 * return the dirty-field set + an aggregate flag. Treats null and ''
 * as equivalent so a "clear by typing nothing" doesn't read as a
 * change, and so a server-side null stayed null when shown as an
 * empty input.
 *
 * Use the returned isDirty to gate Save buttons (and useBeforeUnloadOnDirty
 * to warn on navigate-away). dirtyFields powers the per-input
 * "modified" indicator.
 */
export function useFormDirty<T extends Record<string, unknown>>(
  current: T,
  initial: T,
): FormDirtyState<T> {
  return useMemo(() => {
    const dirtyFields = new Set<keyof T>();
    const keys = new Set<keyof T>([
      ...(Object.keys(current) as Array<keyof T>),
      ...(Object.keys(initial) as Array<keyof T>),
    ]);
    for (const k of keys) {
      const a = current[k] ?? '';
      const b = initial[k] ?? '';
      if (a !== b) dirtyFields.add(k);
    }
    return { isDirty: dirtyFields.size > 0, dirtyFields };
  }, [current, initial]);
}

/**
 * Attach a `beforeunload` listener while `isDirty` is true so the
 * browser surfaces its "leave anyway?" prompt on tab close, refresh,
 * or full-page navigation. SPA-internal navigation is not caught —
 * Next.js doesn't fire beforeunload for App-Router pushes. Forms
 * that need to catch route changes too need a route-guard hook;
 * for now the browser prompt covers the high-risk cases (closing
 * the tab mid-edit).
 */
export function useBeforeUnloadOnDirty(isDirty: boolean): void {
  useEffect(() => {
    if (!isDirty) return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      // Required for older browsers that read returnValue rather
      // than calling preventDefault. The empty string is the
      // canonical "show the default prompt" value — modern browsers
      // ignore custom messages.
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [isDirty]);
}
