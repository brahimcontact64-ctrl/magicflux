'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

export type RuntimeStreamEvent = {
  type: 'runtime_update' | 'heartbeat' | string;
  data: Record<string, unknown>;
};

export type RuntimeStreamState = {
  connected: boolean;
  lastEvent: RuntimeStreamEvent | null;
  retryCount: number;
};

// Connects to the SSE stream at /api/runtime/control/stream.
// Reconnects with exponential backoff (1s → 2s → 4s → … → 30s max).
// Pauses reconnect when the tab is hidden; resumes when visible.
export function useRuntimeStream(
  onEvent?: (event: RuntimeStreamEvent) => void,
  enabled:  boolean = true
): RuntimeStreamState {
  const esRef               = useRef<EventSource | null>(null);
  const reconnectRef        = useRef<ReturnType<typeof setTimeout> | null>(null);
  const retriesRef          = useRef(0);
  const onEventRef          = useRef(onEvent);
  onEventRef.current        = onEvent;

  const [connected,  setConnected]  = useState(false);
  const [lastEvent,  setLastEvent]  = useState<RuntimeStreamEvent | null>(null);
  const [retryCount, setRetryCount] = useState(0);

  const clearReconnect = useCallback(() => {
    if (reconnectRef.current !== null) {
      clearTimeout(reconnectRef.current);
      reconnectRef.current = null;
    }
  }, []);

  const disconnect = useCallback(() => {
    clearReconnect();
    if (esRef.current) {
      esRef.current.close();
      esRef.current = null;
    }
    setConnected(false);
  }, [clearReconnect]);

  const connect = useCallback(() => {
    if (esRef.current || document.hidden) return;

    const es = new EventSource('/api/runtime/control/stream');
    esRef.current = es;

    es.onopen = () => {
      setConnected(true);
      retriesRef.current = 0;
      setRetryCount(0);
    };

    const handleEvent = (type: string, raw: string) => {
      try {
        const data = JSON.parse(raw) as Record<string, unknown>;
        const evt: RuntimeStreamEvent = { type, data };
        setLastEvent(evt);
        onEventRef.current?.(evt);
      } catch {
        // malformed payload — ignore
      }
    };

    es.addEventListener('runtime_update', e =>
      handleEvent('runtime_update', (e as MessageEvent).data as string)
    );

    es.addEventListener('heartbeat', e =>
      handleEvent('heartbeat', (e as MessageEvent).data as string)
    );

    es.onmessage = e => handleEvent('message', (e as MessageEvent).data as string);

    es.onerror = () => {
      setConnected(false);
      es.close();
      esRef.current = null;

      if (!enabled) return;

      // Exponential backoff: 1s, 2s, 4s, 8s, 16s, capped at 30s
      const delayMs = Math.min(30_000, 1_000 * Math.pow(2, retriesRef.current));
      retriesRef.current++;
      setRetryCount(retriesRef.current);

      if (!document.hidden) {
        reconnectRef.current = setTimeout(() => {
          reconnectRef.current = null;
          connect();
        }, delayMs);
      }
    };
  }, [enabled]);

  useEffect(() => {
    if (!enabled) {
      disconnect();
      return;
    }

    connect();

    const onVisibility = () => {
      if (document.hidden) {
        clearReconnect();
      } else if (!esRef.current) {
        retriesRef.current = 0;
        connect();
      }
    };

    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      disconnect();
    };
  }, [enabled, connect, disconnect, clearReconnect]);

  return { connected, lastEvent, retryCount };
}
