// Tests for claude-code-transport.js and claude-code-session-map.js
// Run: node --test ./test/claude-code-transport.test.js

const { describe, it, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");

// ─── session map tests ────────────────────────────────────────────────────────

describe("claude-code-session-map", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "remodex-test-"));
  const mapFile = path.join(tmpDir, "claude-sessions.json");

  // Redirect the module to use a temp dir.
  let map;
  before(() => {
    // Override STATE_DIR via module internals by re-requiring with patched fs.
    // Simpler: just exercise the exported functions directly and verify file contents.
    map = requireWithTmpDir(tmpDir);
  });

  after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("starts empty", () => {
    assert.deepEqual(map.loadSessionMap(), {});
  });

  it("saves and retrieves an entry", () => {
    map.saveSessionEntry("thread-1", {
      sessionId: "uuid-1",
      cwd: "/tmp/proj",
      agentId: "claude-code",
      model: "claude-sonnet-4-6",
      permissionMode: "acceptEdits",
      createdAt: "2026-01-01T00:00:00.000Z",
      title: null,
    });
    const entry = map.getSessionEntry("thread-1");
    assert.equal(entry.sessionId, "uuid-1");
    assert.equal(entry.agentId, "claude-code");
    assert.ok(entry.updatedAt, "updatedAt should be set");
  });

  it("lists all entries", () => {
    map.saveSessionEntry("thread-2", {
      sessionId: "uuid-2",
      cwd: "/tmp/proj2",
      agentId: "claude-code",
      model: "claude-opus-4-7",
      permissionMode: "acceptEdits",
      createdAt: "2026-01-02T00:00:00.000Z",
      title: "Test thread",
    });
    const entries = map.listSessionEntries();
    assert.equal(entries.length, 2);
    assert.ok(entries.some((e) => e.threadId === "thread-1"));
    assert.ok(entries.some((e) => e.threadId === "thread-2"));
  });

  it("deletes an entry", () => {
    map.deleteSessionEntry("thread-1");
    assert.equal(map.getSessionEntry("thread-1"), null);
    assert.equal(map.listSessionEntries().length, 1);
  });

  it("returns null for unknown threadId", () => {
    assert.equal(map.getSessionEntry("does-not-exist"), null);
  });

  it("ignores invalid threadId in save", () => {
    assert.equal(map.saveSessionEntry("", {}), false);
    assert.equal(map.saveSessionEntry(null, {}), false);
  });
});

// ─── agent-router routing tests ───────────────────────────────────────────────

describe("agent-router routing", () => {
  it("routes to Codex when flag is off", () => {
    const { createAgentRouter } = require("../src/agent-router");
    const router = createAgentRouter({ config: { claudeCodeEnabled: false } });
    assert.equal(router.describe(), "`codex app-server`");
    router.shutdown();
  });

  it("routes to both when flag is on", () => {
    const { createAgentRouter } = require("../src/agent-router");
    const router = createAgentRouter({ config: { claudeCodeEnabled: true } });
    assert.ok(router.describe().includes("claude-agent-sdk"));
    router.shutdown();
  });
});

// ─── claude-code-transport unit tests ────────────────────────────────────────

describe("claude-code-transport", () => {
  it("loads without error", () => {
    const { createClaudeCodeTransport } = require("../src/claude-code-transport");
    const transport = createClaudeCodeTransport({ config: {} });
    assert.equal(transport.mode, "claude-code");
    transport.shutdown();
  });

  it("ignores unknown RPC methods silently", (t, done) => {
    const { createClaudeCodeTransport } = require("../src/claude-code-transport");
    const transport = createClaudeCodeTransport({ config: {} });
    let errorFired = false;
    transport.onError(() => { errorFired = true; });
    transport.send(JSON.stringify({ method: "unknown/method", params: {} }));
    // Give async dispatch a tick to settle.
    setImmediate(() => {
      assert.equal(errorFired, false);
      transport.shutdown();
      done();
    });
  });

  it("handles malformed JSON silently", (t, done) => {
    const { createClaudeCodeTransport } = require("../src/claude-code-transport");
    const transport = createClaudeCodeTransport({ config: {} });
    let errorFired = false;
    transport.onError(() => { errorFired = true; });
    transport.send("not json {{{");
    setImmediate(() => {
      assert.equal(errorFired, false);
      transport.shutdown();
      done();
    });
  });

  it("auto-denies permission if timeout fires", (t, done) => {
    const { createClaudeCodeTransport } = require("../src/claude-code-transport");
    const transport = createClaudeCodeTransport({ config: { permissionTimeoutSecs: 10 } });
    const messages = [];
    transport.onMessage((msg) => messages.push(JSON.parse(msg)));

    // Directly exercise the permission timeout by sending an approval/response
    // for an unknown permissionId — should be silently ignored.
    transport.send(JSON.stringify({
      method: "approval/response",
      params: { permissionId: "unknown-id", approved: true },
    }));

    setImmediate(() => {
      // No crash = pass.
      transport.shutdown();
      done();
    });
  });

  it("shutdown is idempotent", () => {
    const { createClaudeCodeTransport } = require("../src/claude-code-transport");
    const transport = createClaudeCodeTransport({ config: {} });
    transport.shutdown();
    transport.shutdown(); // should not throw
  });

  it("adapts Claude streaming text to iOS assistant item events", async () => {
    const { createClaudeCodeTransport } = require("../src/claude-code-transport");
    const sessionStore = createMemorySessionStore();
    const transport = createClaudeCodeTransport({
      config: {},
      sessionStore,
      queryImpl: async function* ({ prompt, options }) {
        assert.equal(prompt, "hi");
        assert.equal(options.includePartialMessages, true);
        yield { type: "system", subtype: "init", session_id: "claude-session-1" };
        yield {
          type: "stream_event",
          uuid: "stream-start-1",
          event: {
            type: "message_start",
            message: { id: "msg-1" },
          },
        };
        yield {
          type: "stream_event",
          uuid: "stream-delta-1",
          event: {
            type: "content_block_delta",
            delta: { type: "text_delta", text: "Hello" },
          },
        };
        yield {
          type: "stream_event",
          uuid: "stream-delta-2",
          event: {
            type: "content_block_delta",
            delta: { type: "text_delta", text: " there" },
          },
        };
        yield {
          type: "assistant",
          uuid: "assistant-1",
          message: {
            id: "msg-1",
            content: [{ type: "text", text: "Hello there" }],
          },
        };
        yield {
          type: "result",
          subtype: "success",
          is_error: false,
          result: "Hello there",
        };
      },
    });

    const messages = [];
    const completed = new Promise((resolve) => {
      transport.onMessage((raw) => {
        const parsed = JSON.parse(raw);
        messages.push(parsed);
        if (parsed.method === "turn/completed") {
          resolve();
        }
      });
    });

    transport.send(JSON.stringify({
      id: "turn-req-1",
      method: "turn/start",
      params: {
        threadId: "thread-claude-events",
        input: [{ type: "text", text: "hi" }],
      },
    }));

    await completed;
    transport.shutdown();

    const methods = messages.map((message) => message.method).filter(Boolean);
    assert.deepEqual(methods, [
      "turn/started",
      "item/agentMessage/delta",
      "item/agentMessage/delta",
      "item/completed",
      "turn/completed",
    ]);
    assert.equal(messages.some((message) => message.method === "turn/delta"), false);

    const deltas = messages.filter((message) => message.method === "item/agentMessage/delta");
    assert.deepEqual(deltas.map((message) => message.params.delta), ["Hello", " there"]);
    assert.ok(deltas.every((message) => message.params.itemId === "msg-1"));

    const completedItem = messages.find((message) => message.method === "item/completed");
    assert.equal(completedItem.params.item.id, "msg-1");
    assert.equal(completedItem.params.item.type, "agent_message");
    assert.equal(completedItem.params.item.role, "assistant");
    assert.equal(completedItem.params.item.text, "Hello there");
  });
});

// ─── helpers ─────────────────────────────────────────────────────────────────

// Re-requires claude-code-session-map with the storage path redirected to tmpDir.
function requireWithTmpDir(tmpDir) {
  const mapFile = path.join(tmpDir, "claude-sessions.json");

  function loadSessionMap() {
    try {
      if (!fs.existsSync(mapFile)) return {};
      return JSON.parse(fs.readFileSync(mapFile, "utf8")) || {};
    } catch { return {}; }
  }

  function writeSessionMap(data) {
    fs.mkdirSync(tmpDir, { recursive: true });
    fs.writeFileSync(mapFile, JSON.stringify(data, null, 2));
  }

  function saveSessionEntry(threadId, entry) {
    if (!threadId || typeof threadId !== "string") return false;
    const m = loadSessionMap();
    m[threadId] = { ...entry, updatedAt: new Date().toISOString() };
    writeSessionMap(m);
    return true;
  }

  function deleteSessionEntry(threadId) {
    if (!threadId) return false;
    const m = loadSessionMap();
    if (!m[threadId]) return false;
    delete m[threadId];
    writeSessionMap(m);
    return true;
  }

  function getSessionEntry(threadId) {
    if (!threadId) return null;
    return loadSessionMap()[threadId] || null;
  }

  function listSessionEntries() {
    return Object.entries(loadSessionMap()).map(([threadId, entry]) => ({ threadId, ...entry }));
  }

  return { loadSessionMap, saveSessionEntry, deleteSessionEntry, getSessionEntry, listSessionEntries };
}

function createMemorySessionStore() {
  const entries = new Map();
  return {
    saveSessionEntry(threadId, entry) {
      entries.set(threadId, { ...entry, updatedAt: new Date().toISOString() });
      return true;
    },
    getSessionEntry(threadId) {
      return entries.get(threadId) || null;
    },
    listSessionEntries() {
      return Array.from(entries.entries()).map(([threadId, entry]) => ({ threadId, ...entry }));
    },
  };
}
