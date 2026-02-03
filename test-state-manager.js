import { StateManager, SessionStateStore } from './state-manager.js';

console.log('Testing StateManager...\n');

// Create a session
const store = new SessionStateStore();
const session = store.create('sess-123', 'conv-456', 'msg-789', 5000);

console.log(`Initial state: ${session.getState()}`);

// Test transitions
try {
  session.transition(session.constructor.STATES.ACQUIRING_ACP, {
    reason: 'Starting ACP connection',
    data: {}
  });
  console.log(`After 1st transition: ${session.getState()}`);

  session.transition(session.constructor.STATES.ACP_ACQUIRED, {
    reason: 'ACP connected',
    data: { acpConnectionTime: Date.now() }
  });
  console.log(`After 2nd transition: ${session.getState()}`);

  session.transition(session.constructor.STATES.SENDING_PROMPT, {
    reason: 'Sending to ACP',
    data: {}
  });
  console.log(`After 3rd transition: ${session.getState()}`);

  session.transition(session.constructor.STATES.PROCESSING, {
    reason: 'Processing response',
    data: {}
  });
  console.log(`After 4th transition: ${session.getState()}`);

  session.transition(session.constructor.STATES.COMPLETED, {
    reason: 'Done!',
    data: { fullText: 'Hello world' }
  });
  console.log(`After final transition: ${session.getState()}`);

  console.log('\n✅ All transitions successful!\n');
  console.log('State history:');
  session.getHistory().forEach((h, i) => {
    console.log(`  ${i}: ${h.state} @ ${h.timestamp} - ${h.reason}`);
  });

  console.log('\nSummary:');
  console.log(JSON.stringify(session.getSummary(), null, 2));

} catch (err) {
  console.error(`❌ Error: ${err.message}`);
}

