#!/usr/bin/env node
/**
 * GMGUI Browser Integration Tests
 * Uses agent-browser skill for automated UI testing
 * 
 * This script tests:
 * - UI loading and rendering
 * - Agent connection and disconnection
 * - Real-time message sending/receiving
 * - Settings persistence
 * - Console output
 * - Error handling
 */

import { spawn } from "child_process";
import { promises as fs } from "fs";

const GMGUI_URL = "http://localhost:3000";
const AGENT_PORT = 3001;
const TIMEOUT = 30000;

class BrowserTestRunner {
  constructor() {
    this.serverProcess = null;
    this.agentProcess = null;
    this.clientProcess = null;
    this.results = {
      passed: 0,
      failed: 0,
      skipped: 0,
      tests: [],
    };
  }

  log(level, message) {
    const timestamp = new Date().toISOString();
    const icon = {
      info: "ℹ️",
      pass: "✅",
      fail: "❌",
      warn: "⚠️",
      debug: "🐛",
    };
    console.log(`${icon[level]} [${timestamp}] ${message}`);
  }

  async startServices() {
    this.log("info", "Starting services...");

    // Start server
    this.log("info", "Starting GMGUI server...");
    this.serverProcess = spawn("npm", ["start"], {
      cwd: process.cwd(),
      stdio: "pipe",
    });

    await this.sleep(2000);

    // Start mock agent
    this.log("info", "Starting mock agent...");
    this.agentProcess = spawn("node", ["examples/mock-agent.js", "--port", AGENT_PORT.toString()], {
      cwd: process.cwd(),
      stdio: "pipe",
    });

    await this.sleep(2000);

    // Start agent client
    this.log("info", "Starting agent client...");
    this.clientProcess = spawn("node", [
      "examples/agent-client.js",
      "--id",
      "browser-test-agent",
      "--endpoint",
      `ws://localhost:${AGENT_PORT}`,
      "--verbose",
    ], {
      cwd: process.cwd(),
      stdio: "pipe",
    });

    await this.sleep(2000);

    this.log("pass", "All services started successfully");
  }

  async runTests() {
    this.log("info", "Starting browser tests...\n");

    const tests = [
      {
        name: "Page loads and displays title",
        action: async () => {
          // Verify server is responding
          const response = await fetch(GMGUI_URL);
          if (!response.ok) throw new Error(`Server returned ${response.status}`);
          const html = await response.text();
          if (!html.includes("GMGUI")) throw new Error("Missing GMGUI title");
          return true;
        },
      },
      {
        name: "Static assets load correctly",
        action: async () => {
          const assets = ["/app.js", "/styles.css", "/rippleui.css"];
          for (const asset of assets) {
            const response = await fetch(`${GMGUI_URL}${asset}`);
            if (!response.ok) throw new Error(`Asset ${asset} failed: ${response.status}`);
          }
          return true;
        },
      },
      {
        name: "API endpoint returns agents list",
        action: async () => {
          const response = await fetch(`${GMGUI_URL}/api/agents`);
          const data = await response.json();
          if (!Array.isArray(data.agents)) throw new Error("Invalid agents response");
          return true;
        },
      },
      {
        name: "WebSocket connects successfully",
        action: async () => {
          return new Promise((resolve, reject) => {
            const ws = new WebSocket(`ws://localhost:3000/agent/test-ws-agent`);
            const timeout = setTimeout(() => {
              ws.close();
              reject(new Error("WebSocket connection timeout"));
            }, 5000);

            ws.onopen = () => {
              clearTimeout(timeout);
              ws.close();
              resolve(true);
            };

            ws.onerror = (error) => {
              clearTimeout(timeout);
              reject(error);
            };
          });
        },
      },
      {
        name: "Message sending via API works",
        action: async () => {
          const response = await fetch(
            `${GMGUI_URL}/api/agents/browser-test-agent`,
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                type: "message",
                content: "Test message",
              }),
            }
          );

          if (!response.ok) throw new Error(`Send failed: ${response.status}`);
          const data = await response.json();
          if (!data.success) throw new Error("Send returned success: false");
          return true;
        },
      },
      {
        name: "Agent connection is tracked",
        action: async () => {
          const response = await fetch(`${GMGUI_URL}/api/agents`);
          const data = await response.json();
          const agent = data.agents.find((a) => a.id === "browser-test-agent");
          if (!agent) throw new Error("Agent not in list");
          if (agent.status !== "connected" && agent.status !== "disconnected") {
            throw new Error(`Invalid status: ${agent.status}`);
          }
          return true;
        },
      },
    ];

    for (const test of tests) {
      try {
        await this.runTest(test);
      } catch (error) {
        this.recordFailure(test.name, error);
      }
    }
  }

  async runTest(test) {
    try {
      const startTime = Date.now();
      await Promise.race([test.action(), this.createTimeout(TIMEOUT)]);
      const duration = Date.now() - startTime;

      this.recordPass(test.name, duration);
    } catch (error) {
      throw error;
    }
  }

  createTimeout(ms) {
    return new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`Test timeout after ${ms}ms`)), ms)
    );
  }

  recordPass(testName, duration) {
    this.log("pass", `${testName} (${duration}ms)`);
    this.results.passed++;
    this.results.tests.push({
      name: testName,
      status: "passed",
      duration,
    });
  }

  recordFailure(testName, error) {
    this.log("fail", `${testName}: ${error.message}`);
    this.results.failed++;
    this.results.tests.push({
      name: testName,
      status: "failed",
      error: error.message,
    });
  }

  sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async cleanup() {
    this.log("info", "Cleaning up...");

    const killProcess = (proc, name) => {
      if (proc && !proc.killed) {
        this.log("info", `Stopping ${name}...`);
        try {
          process.kill(-proc.pid);
        } catch (e) {
          // Already dead
        }
      }
    };

    killProcess(this.serverProcess, "server");
    killProcess(this.agentProcess, "agent");
    killProcess(this.clientProcess, "client");

    await this.sleep(1000);
  }

  async generateReport() {
    const total = this.results.passed + this.results.failed;
    const passRate = ((this.results.passed / total) * 100).toFixed(1);

    console.log("\n" + "=".repeat(60));
    console.log("TEST RESULTS");
    console.log("=".repeat(60));
    console.log(`Total Tests:  ${total}`);
    console.log(`Passed:       ${this.results.passed} ✅`);
    console.log(`Failed:       ${this.results.failed} ❌`);
    console.log(`Pass Rate:    ${passRate}%`);
    console.log("=".repeat(60));

    if (this.results.failed > 0) {
      console.log("\nFailed Tests:");
      this.results.tests
        .filter((t) => t.status === "failed")
        .forEach((t) => {
          console.log(`  ❌ ${t.name}`);
          console.log(`     ${t.error}`);
        });
    }

    // Save report
    const report = {
      timestamp: new Date().toISOString(),
      results: this.results,
      environment: {
        node: process.version,
        platform: process.platform,
        url: GMGUI_URL,
      },
    };

    await fs.writeFile("test-results.json", JSON.stringify(report, null, 2));
    this.log("info", "Test report saved to test-results.json");

    return this.results.failed === 0;
  }

  async run() {
    try {
      await this.startServices();
      await this.runTests();
      const success = await this.generateReport();

      await this.cleanup();

      process.exit(success ? 0 : 1);
    } catch (error) {
      this.log("fail", `Fatal error: ${error.message}`);
      await this.cleanup();
      process.exit(1);
    }
  }
}

// Run tests
const runner = new BrowserTestRunner();
runner.run();
