import { api, isSettled, subscribeExecutions, type Execution, type ExecutionEvent } from "../api";

/**
 * One event stream per project, shared by every component that needs it (P1-3).
 *
 * The workbench, the endpoint list and the batch drawer all care about the same
 * events. Subscribing per component would open one SSE connection each, so the
 * connection is refcounted here instead and torn down when the last consumer
 * leaves.
 */
type Channel = {
  listeners: Set<(event: ExecutionEvent) => void>;
  /** Runs somebody is waiting on, keyed by execution id. */
  waiters: Map<string, { resolve: (execution: Execution) => void; reject: (error: unknown) => void }>;
  close: () => void;
  poll?: ReturnType<typeof setTimeout>;
  /** Current backoff step of the fallback poll, reset whenever a run is awaited. */
  pollDelay: number;
  refs: number;
};

const channels = new Map<string, Channel>();

/**
 * Safety net for the stream.
 *
 * SSE delivers at most once and a reconnect leaves a gap, so a run that settles
 * while the connection is down would leave its waiter hanging forever.
 *
 * The interval ramps rather than sitting at one value. A broken stream is
 * otherwise indistinguishable from a slow one — it just silently costs a full
 * period on every run, which is exactly how a CORS fault on the stream route
 * once passed for "执行有点慢". Starting fast keeps that failure survivable;
 * backing off keeps a genuinely long run from polling in a tight loop.
 *
 * It only ever runs while something is actually being awaited, so the steady
 * state is zero requests.
 */
const POLL_MIN_MS = 250;
const POLL_MAX_MS = 3_000;

function schedulePoll(projectId: string, restart = false) {
  const channel = channels.get(projectId);
  if (!channel) return;
  if (restart) channel.pollDelay = POLL_MIN_MS;
  /* One timer at a time, and none at all when nobody is waiting. */
  if (channel.poll || !channel.waiters.size) return;
  channel.poll = setTimeout(() => {
    channel.poll = undefined;
    void reconcile(projectId).finally(() => {
      channel.pollDelay = Math.min(POLL_MAX_MS, channel.pollDelay * 2);
      schedulePoll(projectId);
    });
  }, channel.pollDelay);
}

function open(projectId: string): Channel {
  const channel: Channel = {
    listeners: new Set(),
    waiters: new Map(),
    close: () => {},
    pollDelay: POLL_MIN_MS,
    refs: 0,
  };
  channel.close = subscribeExecutions(projectId, (event) => {
    for (const listener of channel.listeners) listener(event);
    if (event.kind !== "execution" || !isSettled(event.status)) return;
    if (channel.waiters.has(event.executionId)) void settle(projectId, event.executionId);
  });
  return channel;
}

/** Fetches the full record and hands it to whoever was waiting on it. */
async function settle(projectId: string, executionId: string) {
  const channel = channels.get(projectId);
  const waiter = channel?.waiters.get(executionId);
  if (!channel || !waiter) return;
  /* Removed first so a stream event and a poll landing together resolve once. */
  channel.waiters.delete(executionId);
  try { waiter.resolve(await api.execution(projectId, executionId)); }
  catch (error) { waiter.reject(error); }
}

async function reconcile(projectId: string) {
  const channel = channels.get(projectId);
  if (!channel?.waiters.size) return;
  for (const executionId of [...channel.waiters.keys()]) {
    try {
      const execution = await api.execution(projectId, executionId);
      if (isSettled(execution.status)) await settle(projectId, executionId);
    } catch { /* transient; the next tick tries again */ }
  }
}

export function acquireChannel(projectId: string) {
  let channel = channels.get(projectId);
  if (!channel) { channel = open(projectId); channels.set(projectId, channel); }
  channel.refs += 1;

  let released = false;
  return {
    /** Fires for every event in the project, used for batch progress. */
    listen(listener: (event: ExecutionEvent) => void) {
      channel!.listeners.add(listener);
      return () => { channel!.listeners.delete(listener); };
    },
    /** Resolves once the run reaches a terminal state, with the full record. */
    await(executionId: string) {
      return new Promise<Execution>((resolve, reject) => {
        channel!.waiters.set(executionId, { resolve, reject });
        /* It may already be finished — a fast local endpoint can settle before
           the POST response is even parsed. */
        void reconcile(projectId);
        /* Restarts the ramp so this run gets the fast polls, not whatever
           backoff a previous long-running one left behind. */
        schedulePoll(projectId, true);
      });
    },
    release() {
      if (released) return;
      released = true;
      channel!.refs -= 1;
      if (channel!.refs > 0) return;
      if (channel!.poll) clearTimeout(channel!.poll);
      channel!.close();
      /* Nobody is listening, so nobody can be told the wait failed. */
      for (const waiter of channel!.waiters.values()) waiter.reject(new Error("stream closed"));
      channels.delete(projectId);
    },
  };
}

export type ExecutionChannel = ReturnType<typeof acquireChannel>;
