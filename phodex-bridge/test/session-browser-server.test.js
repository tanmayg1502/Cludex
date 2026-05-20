// FILE: session-browser-server.test.js
// Purpose: Tests for the local session browser server and desktop-handler Claude branching.
// Layer: Unit test
// Exports: node:test suite
// Depends on: node:test, node:assert/strict, ../src/session-browser-server, ../src/desktop-handler

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { createSessionBrowserServer } = require("../src/session-browser-server");
const { handleDesktopRequest } = require("../src/desktop-handler");

// ---------------------------------------------------------------------------
// 1. Claude-thread branching: executor called with "open" + browser URL
// ---------------------------------------------------------------------------
test("desktop/continueOnDesktop opens session browser for Claude threads", async () => {
  const execCalls = [];
  const responses = [];

  // A minimal browser server stub that is already "started"
  const stubBrowserServer = {
    async start() { return { url: "http://127.0.0.1:9999", port: 9999 }; },
    focusUrl(threadId) { return `http://127.0.0.1:9999/sessions?focus=${encodeURIComponent(threadId)}`; },
    stop() {},
    isRunning() { return true; },
    touch() {},
  };

  // Stubs are injected via options (not params) because params is JSON-serialized
  // and functions are stripped. Options is passed in-memory by the caller.
  handleDesktopRequest(JSON.stringify({
    id: "claude-branch-1",
    method: "desktop/continueOnDesktop",
    params: { threadId: "claude-thread-abc" },
  }), (response) => {
    responses.push(JSON.parse(response));
  }, {
    platform: "darwin",
    executor: async (...args) => {
      execCalls.push(args);
      return { stdout: "", stderr: "" };
    },
    isAppRunning: async () => false,
    sleepFn: async () => {},
    // Inject stubs for the Claude branch
    getSessionEntry: (id) => id === "claude-thread-abc" ? { agentId: "claude-code", sessionId: "sess-1" } : null,
    getBrowserServer: () => stubBrowserServer,
  });

  await new Promise((resolve) => setTimeout(resolve, 50));

  assert.equal(responses.length, 1, "should have one response");
  assert.ok(!responses[0].error, `unexpected error: ${JSON.stringify(responses[0].error)}`);
  assert.equal(responses[0].result?.target, "session-browser");
  const url = responses[0].result?.url;
  assert.ok(typeof url === "string" && url.startsWith("http://127.0.0.1:"), `URL should be loopback, got: ${url}`);

  // The executor (open) should have been called once with the browser URL
  assert.ok(execCalls.length >= 1, "open should have been called at least once");
  const openCall = execCalls.find((c) => c[0] === "open");
  assert.ok(openCall, "open was not called");
  assert.ok(openCall[1][0].startsWith("http://127.0.0.1:"), `open arg should be loopback URL, got: ${openCall[1][0]}`);
});

// ---------------------------------------------------------------------------
// 2. Codex fallback: null session entry → existing Codex deep-link path
// ---------------------------------------------------------------------------
test("desktop/continueOnDesktop falls back to Codex path when session entry is null", async () => {
  const execCalls = [];
  const responses = [];

  handleDesktopRequest(JSON.stringify({
    id: "codex-fallback-1",
    method: "desktop/continueOnDesktop",
    params: { threadId: "codex-thread-xyz" },
  }), (response) => {
    responses.push(JSON.parse(response));
  }, {
    platform: "darwin",
    executor: async (...args) => {
      execCalls.push(args);
      return { stdout: "", stderr: "" };
    },
    isAppRunning: async () => false,
    sleepFn: async () => {},
    threadMaterializeWaitMs: 0,
    getSessionEntry: () => null,
  });

  await new Promise((resolve) => setTimeout(resolve, 50));

  assert.equal(responses.length, 1, "should have one response");
  assert.ok(!responses[0].error, `unexpected error: ${JSON.stringify(responses[0].error)}`);

  // Should NOT have opened a browser URL
  const browserCall = execCalls.find((c) => c[1]?.[0]?.startsWith("http://"));
  assert.equal(browserCall, undefined, "should not open browser URL for Codex threads");

  // Should have called open with a codex:// URL
  const codexOpen = execCalls.find((c) => c[0] === "open" && c[1]?.some((a) => a.startsWith("codex://")));
  assert.ok(codexOpen, "should have opened a codex:// deep link");
});

// ---------------------------------------------------------------------------
// 3. Server health: start → /api/sessions → 200 + JSON shape
// ---------------------------------------------------------------------------
test("createSessionBrowserServer: /api/sessions returns expected JSON shape", async () => {
  const server = createSessionBrowserServer({
    getCodexSessions: async () => [{ id: "codex-1", agentId: "codex" }],
    getClaudeSessions: async () => [{ id: "claude-1", agentId: "claude-code", title: "My session", cwd: "/tmp", model: "claude-3-5-sonnet" }],
    idleTimeoutMs: 5000, // short for test
  });

  const { url, port } = await server.start();
  assert.ok(typeof port === "number" && port > 0, `port should be a positive number, got: ${port}`);
  assert.ok(url.startsWith("http://127.0.0.1:"), `URL should be loopback, got: ${url}`);

  // Hit the API
  const { default: http } = await import("node:http");
  const data = await new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${port}/api/sessions`, (res) => {
      assert.equal(res.statusCode, 200);
      let body = "";
      res.on("data", (chunk) => { body += chunk; });
      res.on("end", () => {
        try { resolve(JSON.parse(body)); }
        catch (e) { reject(e); }
      });
    }).on("error", reject);
  });

  assert.ok(Array.isArray(data.codex), "codex should be an array");
  assert.ok(Array.isArray(data.claude), "claude should be an array");
  assert.equal(data.claude[0].id, "claude-1");
  assert.equal(data.claude[0].agentId, "claude-code");
  assert.equal(data.codex[0].id, "codex-1");

  server.stop();
});

// ---------------------------------------------------------------------------
// 4. focusUrl includes the threadId in the query string
// ---------------------------------------------------------------------------
test("createSessionBrowserServer: focusUrl returns correct URL", async () => {
  const server = createSessionBrowserServer({
    getCodexSessions: async () => [],
    getClaudeSessions: async () => [],
    idleTimeoutMs: 5000,
  });

  await server.start();
  const url = server.focusUrl("my-thread-id");
  assert.ok(url.includes("focus=my-thread-id"), `focusUrl should include focus param, got: ${url}`);
  assert.ok(url.startsWith("http://127.0.0.1:"), `focusUrl should be loopback, got: ${url}`);
  server.stop();
});

// ---------------------------------------------------------------------------
// 5. /api/sessions returns [] for each agent on error, still 200
// ---------------------------------------------------------------------------
test("createSessionBrowserServer: /api/sessions returns [] on callback error", async () => {
  const server = createSessionBrowserServer({
    getCodexSessions: async () => { throw new Error("codex boom"); },
    getClaudeSessions: async () => { throw new Error("claude boom"); },
    idleTimeoutMs: 5000,
  });

  const { port } = await server.start();
  const { default: http } = await import("node:http");
  const data = await new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${port}/api/sessions`, (res) => {
      assert.equal(res.statusCode, 200);
      let body = "";
      res.on("data", (c) => { body += c; });
      res.on("end", () => {
        try { resolve(JSON.parse(body)); }
        catch (e) { reject(e); }
      });
    }).on("error", reject);
  });

  assert.deepEqual(data.codex, []);
  assert.deepEqual(data.claude, []);
  server.stop();
});
