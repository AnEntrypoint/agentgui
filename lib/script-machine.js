import { createMachine, createActor, assign } from 'xstate';

const machine = createMachine({
  id: 'script',
  initial: 'idle',
  context: {
    process: null,
    script: null,
    startTime: null,
    pid: null,
  },
  states: {
    idle: {
      entry: assign({ process: null, script: null, startTime: null, pid: null }),
      on: {
        START: {
          target: 'running',
          actions: assign(({ event }) => ({
            process: event.process,
            script: event.script,
            startTime: Date.now(),
            pid: event.pid || null,
          })),
        },
      },
    },
    running: {
      on: {
        STOP: { target: 'stopping' },
        CLOSE: { target: 'idle' },
        ERROR: { target: 'idle' },
      },
    },
    stopping: {
      on: {
        CLOSE: { target: 'idle' },
        ERROR: { target: 'idle' },
      },
    },
  },
});

const actors = new Map();

export function getOrCreate(convId) {
  if (actors.has(convId)) return actors.get(convId);
  const actor = createActor(machine);
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
}

export function snapshot(convId) {
  const actor = actors.get(convId);
  return actor ? actor.getSnapshot() : null;
}

export function send(convId, event) {
  const actor = getOrCreate(convId);
  actor.send(event);
  return actor.getSnapshot();
}

export function isRunning(convId) {
  const s = snapshot(convId);
  return s ? s.value === 'running' || s.value === 'stopping' : false;
}

export function getContext(convId) {
  const s = snapshot(convId);
  return s ? s.context : null;
}
