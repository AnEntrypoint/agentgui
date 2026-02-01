#!/usr/bin/env node

import http from 'http';
import { spawn } from 'child_process';
import fs from 'fs';

const PORT = 4001;
const BASE_URL = `http://localhost:${PORT}`;

let serverProcess;

// Color codes for terminal output
const colors = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  blue: '\x1b[34m',
  yellow: '\x1b[33m'
};

function log(color, message) {
  console.log(`${color}${message}${colors.reset}`);
}

function request(method, path, body = null) {
  return new Promise((resolve, reject) => {
    const url = new URL(BASE_URL + path);
    const options = {
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      method: method,
      headers: {
        'Content-Type': 'application/json'
      }
    };

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve({
            status: res.statusCode,
            data: data ? JSON.parse(data) : null
          });
        } catch (e) {
          resolve({
            status: res.statusCode,
            data: data
          });
        }
      });
    });

    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

async function startServer() {
  return new Promise((resolve) => {
    log(colors.blue, '\n Starting server...');
    serverProcess = spawn('node', ['server.js'], {
      cwd: process.cwd(),
      env: { ...process.env, PORT }
    });

    serverProcess.stderr.on('data', (data) => {
      const output = data.toString();
      if (output.includes('running on')) {
        log(colors.green, '✓ Server started');
        setTimeout(resolve, 500);
      }
    });

    serverProcess.stdout.on('data', (data) => {
      if (data.toString().includes('running on')) {
        log(colors.green, '✓ Server started');
        setTimeout(resolve, 500);
      }
    });
  });
}

async function stopServer() {
  return new Promise((resolve) => {
    if (serverProcess) {
      serverProcess.kill();
      setTimeout(resolve, 500);
    } else {
      resolve();
    }
  });
}

async function test(name, fn) {
  try {
    await fn();
    log(colors.green, `✓ ${name}`);
    return true;
  } catch (e) {
    log(colors.red, `✗ ${name}`);
    log(colors.red, `  Error: ${e.message}`);
    return false;
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function runTests() {
  let passed = 0;
  let failed = 0;

  log(colors.blue, '\n=== SQL Integration Tests ===\n');

  // Test 1: Create conversation
  let conversationId;
  if (await test('Create conversation', async () => {
    const res = await request('POST', '/api/conversations', {
      agentId: 'test-agent',
      title: 'Test Conversation'
    });
    assert(res.status === 201, `Expected 201, got ${res.status}`);
    assert(res.data.conversation, 'No conversation in response');
    assert(res.data.conversation.id, 'No id in conversation');
    conversationId = res.data.conversation.id;
  })) {
    passed++;
  } else {
    failed++;
  }

  // Test 2: Get conversations
  if (await test('List conversations', async () => {
    const res = await request('GET', '/api/conversations');
    assert(res.status === 200, `Expected 200, got ${res.status}`);
    assert(Array.isArray(res.data.conversations), 'Conversations should be an array');
    assert(res.data.conversations.length > 0, 'Should have at least one conversation');
  })) {
    passed++;
  } else {
    failed++;
  }

  // Test 3: Get specific conversation
  if (await test('Get specific conversation', async () => {
    const res = await request('GET', `/api/conversations/${conversationId}`);
    assert(res.status === 200, `Expected 200, got ${res.status}`);
    assert(res.data.conversation.id === conversationId, 'Wrong conversation returned');
    assert(res.data.conversation.agentId === 'test-agent', 'Wrong agentId');
  })) {
    passed++;
  } else {
    failed++;
  }

  // Test 4: Create message
  let messageId;
  if (await test('Create message', async () => {
    const res = await request('POST', `/api/conversations/${conversationId}/messages`, {
      content: 'Hello, test message',
      agentId: 'test-agent'
    });
    assert(res.status === 201, `Expected 201, got ${res.status}`);
    assert(res.data.message, 'No message in response');
    assert(res.data.message.id, 'No id in message');
    assert(res.data.session, 'No session in response');
    messageId = res.data.message.id;
  })) {
    passed++;
  } else {
    failed++;
  }

  // Test 5: Get conversation messages
  if (await test('Get conversation messages', async () => {
    const res = await request('GET', `/api/conversations/${conversationId}/messages`);
    assert(res.status === 200, `Expected 200, got ${res.status}`);
    assert(Array.isArray(res.data.messages), 'Messages should be an array');
    assert(res.data.messages.length > 0, 'Should have at least one message');
    assert(res.data.messages[0].role === 'user', 'First message should be from user');
  })) {
    passed++;
  } else {
    failed++;
  }

  // Test 6: Get specific message
  if (await test('Get specific message', async () => {
    const res = await request('GET', `/api/conversations/${conversationId}/messages/${messageId}`);
    assert(res.status === 200, `Expected 200, got ${res.status}`);
    assert(res.data.message.id === messageId, 'Wrong message returned');
    assert(res.data.message.role === 'user', 'Wrong role for message');
  })) {
    passed++;
  } else {
    failed++;
  }

  // Test 7: Get session
  if (await test('Get session', async () => {
    // First get the messages to find a session
    const msgRes = await request('GET', `/api/conversations/${conversationId}/messages`);
    assert(msgRes.data.messages.length > 0, 'No messages found');

    // The session should have been created with the message
    // We'll get it from the specific message response
    const msgDetailRes = await request('GET', `/api/conversations/${conversationId}/messages/${messageId}`);
    const sessionId = msgDetailRes.data.session?.id;
    assert(sessionId, 'No session found');

    const res = await request('GET', `/api/sessions/${sessionId}`);
    assert(res.status === 200, `Expected 200, got ${res.status}`);
    assert(res.data.session.id === sessionId, 'Wrong session returned');
    assert(res.data.session.conversationId === conversationId, 'Session belongs to wrong conversation');
  })) {
    passed++;
  } else {
    failed++;
  }

  // Test 8: Update conversation
  if (await test('Update conversation', async () => {
    const res = await request('POST', `/api/conversations/${conversationId}`, {
      title: 'Updated Title'
    });
    assert(res.status === 200, `Expected 200, got ${res.status}`);
    assert(res.data.conversation.title === 'Updated Title', 'Title not updated');
  })) {
    passed++;
  } else {
    failed++;
  }

  // Test 9: Database persistence
  if (await test('Database persistence', async () => {
    // Check that the database file was created
    const dbFile = `${process.env.HOME || '/root'}/.gmgui/data.json`;
    assert(fs.existsSync(dbFile), 'Database file not found');

    // Read and verify data
    const data = JSON.parse(fs.readFileSync(dbFile, 'utf-8'));
    assert(data.conversations, 'No conversations in database');
    assert(data.messages, 'No messages in database');
    assert(data.sessions, 'No sessions in database');
    assert(data.events, 'No events in database');
  })) {
    passed++;
  } else {
    failed++;
  }

  // Test 10: Event sourcing
  if (await test('Event sourcing', async () => {
    const res = await request('GET', `/api/conversations/${conversationId}`);
    assert(res.status === 200, 'Failed to get conversation');

    // Verify the database has events
    const dbFile = `${process.env.HOME || '/root'}/.gmgui/data.json`;
    const data = JSON.parse(fs.readFileSync(dbFile, 'utf-8'));
    const events = Object.values(data.events).filter(e => e.conversationId === conversationId);
    assert(events.length > 0, 'No events found for conversation');
  })) {
    passed++;
  } else {
    failed++;
  }

  log(colors.blue, `\n=== Test Results ===\n`);
  log(colors.green, `Passed: ${passed}`);
  log(colors.red, `Failed: ${failed}`);
  log(colors.blue, `Total: ${passed + failed}\n`);

  return failed === 0;
}

async function main() {
  try {
    await startServer();
    const success = await runTests();
    await stopServer();
    process.exit(success ? 0 : 1);
  } catch (e) {
    log(colors.red, `Fatal error: ${e.message}`);
    await stopServer();
    process.exit(1);
  }
}

main();
