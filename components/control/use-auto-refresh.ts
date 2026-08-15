'use client';

import { useCallback, useEffect, useRef } from 'react';

/**
 * Polls `callback` every `intervalMs` while the browser tab is visible.
 * Automatically pauses when the Visibility API reports the tab is hidden
 * and resumes (with an immediate call) when it becomes visible again.
 */
export function useAutoRefresh(
  callback: () => void,
  intervalMs: number,
  enabled: boolean = true,
) {
  const cbRef    = useRef(callback);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  cbRef.current  = callback;

  const stop = useCallback(() => {
    if (timerRef.current !== null) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const start = useCallback(() => {
    if (timerRef.current !== null) return;
    timerRef.current = setInterval(() => { cbRef.current(); }, intervalMs);
  }, [intervalMs]);

  useEffect(() => {
    if (!enabled) { stop(); return; }

    if (!document.hidden) start();

    const onVisibility = () => {
      if (document.hidden) {
        stop();
      } else {
        cbRef.current();
        start();
      }
    };

    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      stop();
    };
  }, [enabled, start, stop]);
}
