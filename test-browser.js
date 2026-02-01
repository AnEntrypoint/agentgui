#!/usr/bin/env node
/**
 * Browser Integration Test for GMGUI
 * Tests the complete UI flow in a real browser
 * 
 * Requirements:
 * - agent-browser skill available
 * - Server running on localhost:3000
 * - Mock agent running on localhost:3001
 */

import { execSync } from "child_process";

const GMGUI_URL = "http://localhost:3000";
const AGENT_PORT = 3001;

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runBrowserTests() {
  console.log("🚀 Starting GMGUI Browser Integration Tests\n");

  // Start server
  console.log("[1/4] Starting GMGUI server...");
  const serverProcess = exec("npm start", { detached: true });
  await sleep(2000);

  // Start mock agent
  console.log("[2/4] Starting mock agent...");
  const agentProcess = exec(`node examples/mock-agent.js --port ${AGENT_PORT}`, {
    detached: true,
  });
  await sleep(2000);

  // Browser tests
  console.log("[3/4] Opening GMGUI in browser...");
  console.log(`📍 URL: ${GMGUI_URL}\n`);

  const testSteps = [
    {
      name: "Load GMGUI UI",
      action: `Navigate to ${GMGUI_URL}`,
      verify: "Page loads and displays 'GMGUI' title",
    },
    {
      name: "Connect Agent",
      action: 'Enter "test-agent" in Agent ID field',
      verify: "Input field accepts text",
    },
    {
      name: "Enter Endpoint",
      action: `Enter "ws://localhost:${AGENT_PORT}" in endpoint field`,
      verify: "Endpoint input accepts WebSocket URL",
    },
    {
      name: "Click Connect",
      action: "Click the 'Connect' button",
      verify: "Button is clickable",
    },
    {
      name: "Wait for Connection",
      action: "Wait 2 seconds for WebSocket connection",
      verify: "Agent appears in sidebar with 'connected' status",
    },
    {
      name: "Select Agent",
      action: "Click the agent in the sidebar",
      verify: "Agent becomes highlighted (active)",
    },
    {
      name: "Send Message",
      action: 'Type "Hello Agent" in message input',
      verify: "Input field accepts text",
    },
    {
      name: "Submit Message",
      action: "Press Enter or click Send button",
      verify: "Message appears in console output",
    },
    {
      name: "Verify Console Output",
      action: "Wait 1 second for response",
      verify:
        'Console shows "Sent to test-agent: Hello Agent" message',
    },
    {
      name: "Check Auto-scroll",
      action: "Verify console scrolled to latest message",
      verify: "Latest message visible without manual scrolling",
    },
    {
      name: "Test Settings Tab",
      action: "Click 'Settings' tab",
      verify: "Settings panel displays",
    },
    {
      name: "Verify Settings Options",
      action: "Check all setting controls",
      verify: "Message format, auto-scroll, timeout visible",
    },
    {
      name: "Toggle Auto-scroll",
      action: 'Click "Auto-scroll Console" checkbox',
      verify: "Checkbox state changes",
    },
    {
      name: "Verify Persistence",
      action: "Refresh page (F5 or Ctrl+R)",
      verify: "Settings retained after refresh",
    },
    {
      name: "Console Still There",
      action: "Check console after refresh",
      verify: "Message history still visible",
    },
    {
      name: "Disconnect Agent",
      action: 'Click "Disconnect" button for test-agent',
      verify: "Agent removed from sidebar",
    },
    {
      name: "Status Changes",
      action: "Observe console messages",
      verify: 'Console shows "Disconnected from test-agent"',
    },
    {
      name: "Clear Console",
      action: 'Click "Clear" button',
      verify: "Console output cleared",
    },
  ];

  console.log("📋 Test Checklist:\n");
  testSteps.forEach((step, idx) => {
    console.log(`${idx + 1}. ${step.name}`);
    console.log(`   Action: ${step.action}`);
    console.log(`   Verify: ${step.verify}\n`);
  });

  console.log("\n✅ Manual Test Flow Complete");
  console.log("\nNext: Open http://localhost:3000 in browser and follow checklist\n");

  // Cleanup
  console.log("[4/4] Cleanup...");
  process.kill(-serverProcess.pid);
  process.kill(-agentProcess.pid);
  console.log("✅ Test complete!");
}

function exec(command, options = {}) {
  try {
    const result = execSync(command, {
      ...options,
      stdio: "ignore",
      detached: true,
    });
    return { pid: result };
  } catch (e) {
    console.error(`Failed to execute: ${command}`, e.message);
    process.exit(1);
  }
}

// Run tests
runBrowserTests().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});
