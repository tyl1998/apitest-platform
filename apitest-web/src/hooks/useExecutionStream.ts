import { useEffect, useRef } from "react";
import { acquireChannel, type ExecutionChannel } from "../lib/executionStream";
import type { ExecutionEvent } from "../api";

/**
 * Access to the project's execution event stream (P1-3).
 *
 * Returns a stable handle so callers can `await` a queued run without the
 * identity of the function changing on every render.
 */
export function useExecutionStream(projectId: string | undefined) {
  const channel = useRef<ExecutionChannel>();
  const listener = useRef<(event: ExecutionEvent) => void>();

  useEffect(() => {
    if (!projectId) return;
    const acquired = acquireChannel(projectId);
    channel.current = acquired;
    /* Indirection through a ref so a caller that changes its handler does not
       have to re-open the connection. */
    const stop = acquired.listen((event) => listener.current?.(event));
    return () => { stop(); acquired.release(); channel.current = undefined; };
  }, [projectId]);

  return useRef({
    /** Resolves with the full record once the run reaches a terminal state. */
    awaitRun(executionId: string) {
      if (!channel.current) return Promise.reject(new Error("stream not ready"));
      return channel.current.await(executionId);
    },
    /** Replaces the event handler. Only one is kept; the last caller wins. */
    onEvent(handler: ((event: ExecutionEvent) => void) | undefined) { listener.current = handler; },
  }).current;
}
