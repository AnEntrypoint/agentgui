import { createMachine, createActor, assign } from 'xstate';

const machine = createMachine({
  id: 'conv-execution',
  initial: 'idle',
  context: {
    pid: null,
    proc: null,
    sessionId: null,
    startTime: null,
    lastActivity: null,
    queue: [],
    nextItem: null,
  },
  states: {
    idle: {
      entry: assign({ pid: null, proc: null, sessionId: null, nextItem: null }),
      on: {
        START: {
          target: 'streaming',
          actions: assign(({ event }) => ({
            sessionId: event.sessionId,
            startTime: Date.now(),
            lastActivity: Date.now(),
            pid: null,
            proc: null,
          })),
        },
      },
    },
    streaming: {
      on: {
        SET_PID: { actions: assign(({ event }) => ({ pid: event.pid, lastActivity: Date.now() })) },
        SET_PROC: { actions: assign(({ event }) => ({ proc: event.proc, lastActivity: Date.now() })) },
        ACTIVITY: { actions: assign(() => ({ lastActivity: Date.now() })) },
        ENQUEUE: {
          actions: assign(({ context, event }) => ({
            queue: [...context.queue, event.item],
          })),
        },
        SET_QUEUE: {
          actions: assign(({ event }) => ({ queue: event.queue })),
        },
        COMPLETE: [
          {
            guard: ({ context }) => context.queue.length > 0,
            target: 'draining',
          },
          { target: 'idle' },
        ],
        CANCEL: {
          target: 'idle',
          actions: assign({ queue: [] }),
        },
        RATE_LIMITED: {
          target: 'rate_limited',
          actions: assign(({ event }) => ({
            rateLimitRetryAt: event.retryAt,
            rateLimitCooldownMs: event.cooldownMs,
            rateLimitRetryCount: event.retryCount,
            rateLimitMessageId: event.messageId,
            rateLimitContent: event.content,
            rateLimitAgentId: event.agentId,
            rateLimitModel: event.model,
            rateLimitSubAgent: event.subAgent,
          })),
        },
      },
    },
    rate_limited: {
      on: {
        RETRY: {
          target: 'streaming',
          actions: assign(({ event }) => ({
            sessionId: event.sessionId,
            startTime: Date.now(),
            lastActivity: Date.now(),
            pid: null,
            proc: null,
            rateLimitRetryAt: null,
          })),
        },
        CANCEL: {
          target: 'idle',
          actions: assign({ queue: [] }),
        },
      },
    },
    draining: {
      always: {
        target: 'streaming',
        actions: assign(({ context }) => {
          const [next, ...rest] = context.queue;
          return {
            pid: null,
            proc: null,
            sessionId: null,
            queue: rest,
            nextItem: next,
          };
        }),
      },
    },
  },
});

const actors = new Map();
// Per-convId listeners: Map<convId, Set<(snapshot) => void>>
const listeners = new Map();

function notifyListeners(convId, snapshot) {
  const set = listeners.get(convId);
  if (!set) return;
  for (const fn of set) {
    try { fn(snapshot); } catch (_) {}
  }
}

export function getOrCreate(convId) {
  if (actors.has(convId)) return actors.get(convId);
  const actor = createActor(machine);
  actor.subscribe(snapshot => notifyListeners(convId, snapshot));
  actor.start();
  actors.set(convId, actor);
  return actor;
}

export function get(convId) {
  return actors.get(convId) || null;
}

export function remove(convId) {
  const actor = actors.get(convId);
  if (actor) { actor.stop(); actors.delete(convId); }
  listeners.delete(convId);
}

export function snapshot(convId) {
  const actor = actors.get(convId);
  return actor ? actor.getSnapshot() : null;
}

export function getContext(convId) {
  const s = snapshot(convId);
  return s ? s.context : null;
}

export function getQueue(convId) {
  const ctx = getContext(convId);
  return ctx ? ctx.queue : [];
}

export function send(convId, event) {
  const actor = getOrCreate(convId);
  actor.send(event);
  return actor.getSnapshot();
}

// Subscribe to state transitions for a conversation.
// Returns an unsubscribe function.
export function subscribe(convId, fn) {
  if (!listeners.has(convId)) listeners.set(convId, new Set());
  listeners.get(convId).add(fn);
  return () => listeners.get(convId)?.delete(fn);
}

export function stopAll() {
  for (const [, actor] of actors) actor.stop();
  actors.clear();
  listeners.clear();
}
