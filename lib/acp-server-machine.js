import { createMachine, createActor, assign } from 'xstate';

const MAX_RESTARTS = 10;
const RESTART_WINDOW_MS = 300000;

function calcBackoff(restarts) {
  return Math.min(1000 * Math.pow(2, restarts.length), 30000);
}

function purgeOldRestarts(restarts) {
  const window = Date.now() - RESTART_WINDOW_MS;
  return restarts.filter(t => t > window);
}

const machine = createMachine({
  id: 'acp-server',
  initial: 'stopped',
  context: {
    process: null,
    pid: null,
    healthy: false,
    restarts: [],
    lastHealthCheck: 0,
    providerInfo: null,
    startedAt: null,
    lastUsed: null,
    idleDeadline: null,
  },
  states: {
    stopped: {
      entry: assign({ process: null, pid: null, healthy: false }),
      on: {
        START: 'starting',
      },
    },
    starting: {
      entry: assign(({ event }) => ({
        process: event.process || null,
        pid: event.pid || null,
        startedAt: Date.now(),
        lastUsed: Date.now(),
        healthy: false,
      })),
      on: {
        HEALTHY: {
          target: 'running',
          actions: assign(({ event }) => ({
            healthy: true,
            lastHealthCheck: Date.now(),
            providerInfo: event.providerInfo || null,
          })),
        },
        CRASHED: 'crashed',
        STOP: 'idle_stopping',
      },
    },
    running: {
      entry: assign({ healthy: true }),
      on: {
        UNHEALTHY: {
          actions: assign(() => ({ healthy: false, lastHealthCheck: Date.now() })),
        },
        HEALTHY: {
          actions: assign(({ event }) => ({
            healthy: true,
            lastHealthCheck: Date.now(),
            providerInfo: event.providerInfo || null,
          })),
        },
        TOUCH: {
          actions: assign(() => ({ lastUsed: Date.now() })),
        },
        CRASHED: 'crashed',
        STOP: 'idle_stopping',
        IDLE_TIMEOUT: 'idle_stopping',
      },
    },
    crashed: {
      entry: assign({ healthy: false }),
      always: [
        {
          guard: ({ context }) => {
            const recent = purgeOldRestarts(context.restarts);
            return recent.length >= MAX_RESTARTS;
          },
          target: 'stopped',
        },
        { target: 'restarting' },
      ],
    },
    restarting: {
      entry: assign(({ context }) => ({
        restarts: [...purgeOldRestarts(context.restarts), Date.now()],
        process: null,
        pid: null,
        healthy: false,
      })),
      on: {
        STARTED: {
          target: 'starting',
          actions: assign(({ event }) => ({
            process: event.process,
            pid: event.pid,
            startedAt: Date.now(),
          })),
        },
        STOP: 'stopped',
      },
    },
    idle_stopping: {
      entry: assign({ healthy: false }),
      on: {
        STOPPED: {
          target: 'stopped',
          actions: assign({ process: null, pid: null }),
        },
      },
    },
  },
});

const actors = new Map();

export function getOrCreate(toolId) {
  if (actors.has(toolId)) return actors.get(toolId);
  const actor = createActor(machine);
  actor.start();
  actors.set(toolId, actor);
  return actor;
}

export function get(toolId) {
  return actors.get(toolId) || null;
}

export function send(toolId, event) {
  const actor = getOrCreate(toolId);
  actor.send(event);
  return actor.getSnapshot();
}

export function snapshot(toolId) {
  const actor = actors.get(toolId);
  return actor ? actor.getSnapshot() : null;
}

export function isRunning(toolId) {
  const s = snapshot(toolId);
  return s ? s.value === 'running' : false;
}

export function isHealthy(toolId) {
  const s = snapshot(toolId);
  return s ? (s.value === 'running' && s.context.healthy) : false;
}

export function getBackoffDelay(toolId) {
  const s = snapshot(toolId);
  if (!s) return 1000;
  return calcBackoff(purgeOldRestarts(s.context.restarts));
}

export function stopAll() {
  for (const [, actor] of actors) actor.stop();
  actors.clear();
}
