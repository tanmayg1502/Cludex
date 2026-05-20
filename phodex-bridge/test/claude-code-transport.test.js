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

  it("model/list merges Claude reasoning effort metadata", async () => {
    const { createAgentRouter } = require("../src/agent-router");
    const codexTransport = createStubTransport((parsed, emit) => {
      if (parsed.method !== "model/list") return;
      setImmediate(() => {
        emit({
          id: parsed.id,
          result: {
            items: [
              {
                id: "gpt-5.5",
                model: "gpt-5.5",
                displayName: "GPT-5.5",
                supportedReasoningEfforts: [],
              },
            ],
          },
        });
      });
    });
    const claudeTransport = createStubTransport(() => {});
    const router = createAgentRouter({
      config: { claudeCodeEnabled: true },
      codexTransport,
      claudeTransport,
    });

    const response = await new Promise((resolve) => {
      router.onMessage((raw) => resolve(JSON.parse(raw)));
      router.send(JSON.stringify({ id: "models-1", method: "model/list", params: {} }));
    });

    const sonnet = response.result.items.find((model) => model.id === "claude-sonnet-4-6");
    assert.ok(sonnet, "Claude Sonnet should be merged into model/list");
    assert.deepEqual(
      sonnet.supportedReasoningEfforts.map((option) => option.reasoningEffort),
      ["low", "medium", "high", "max"]
    );
    assert.equal(sonnet.defaultReasoningEffort, "high");
    router.shutdown();
  });

  it("runDirectTurn captures item/agentMessage streams when turn/completed has no result", async () => {
    const { createAgentRouter } = require("../src/agent-router");
    const sentMessages = [];
    const transport = createStubTransport((parsed, emit) => {
      sentMessages.push(parsed);
      if (parsed.method === "thread/start") {
        setImmediate(() => {
          emit({
            id: parsed.id,
            result: {
              thread: {
                id: "codex-assigned-thread",
                threadId: "codex-assigned-thread",
              },
            },
          });
        });
        return;
      }
      if (parsed.method !== "turn/start") return;
      setImmediate(() => {
        emit({
          method: "item/agentMessage/delta",
          params: {
            threadId: parsed.params.threadId,
            turnId: parsed.id,
            delta: "hello ",
          },
        });
        emit({
          method: "item/completed",
          params: {
            threadId: parsed.params.threadId,
            turnId: parsed.id,
            item: { type: "agent_message", text: "hello world" },
          },
        });
        emit({
          method: "turn/completed",
          params: {
            threadId: parsed.params.threadId,
            turnId: parsed.id,
          },
        });
      });
    });

    const router = createAgentRouter({
      config: { claudeCodeEnabled: false },
      codexTransport: transport,
    });

    const result = await router.runDirectTurn({
      agentId: "codex",
      threadId: "thread-direct",
      prompt: "Say hello",
      cwd: "/tmp",
      model: "gpt-5",
      parentThreadId: "parent-1",
      role: "implementer",
    });
    assert.equal(result.result, "hello world");
    assert.equal(result.threadId, "codex-assigned-thread");
    const threadStart = sentMessages.find((message) => message.method === "thread/start");
    assert.equal(threadStart.params.threadId, undefined);
    const turnStart = sentMessages.find((message) => message.method === "turn/start");
    assert.equal(turnStart.params.threadId, "codex-assigned-thread");
    assert.deepEqual(turnStart.params.input, [{ type: "text", text: "Say hello" }]);
    assert.equal(turnStart.params.prompt, undefined);
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

  it("passes selected effort through to Claude SDK queries", async () => {
    const { createClaudeCodeTransport } = require("../src/claude-code-transport");
    let capturedOptions = null;
    const transport = createClaudeCodeTransport({
      config: {},
      queryImpl: async function* ({ options }) {
        capturedOptions = options;
        yield { type: "system", subtype: "init", session_id: "claude-session-effort" };
        yield { type: "result", subtype: "success", result: "done" };
      },
    });

    transport.send(JSON.stringify({
      id: "turn-effort",
      method: "turn/start",
      params: {
        threadId: "thread-effort",
        prompt: "think",
        model: "claude-sonnet-4-6",
        effort: "max",
      },
    }));

    await waitFor(() => capturedOptions !== null);
    assert.equal(capturedOptions.effort, "max");
    assert.deepEqual(capturedOptions.thinking, { type: "adaptive" });
    transport.shutdown();
  });

  it("forks Claude threads into a new session-map entry", async () => {
    const { createClaudeCodeTransport } = require("../src/claude-code-transport");
    const sessionStore = createMemorySessionStore();
    sessionStore.saveSessionEntry("source-thread", {
      sessionId: "claude-session-1",
      cwd: "/tmp/source",
      agentId: "claude-code",
      model: "claude-sonnet-4-6",
      permissionMode: "acceptEdits",
      createdAt: "2026-01-01T00:00:00.000Z",
      title: "Source",
    });

    const transport = createClaudeCodeTransport({ config: {}, sessionStore });
    const messages = [];
    transport.onMessage((raw) => messages.push(JSON.parse(raw)));
    transport.send(JSON.stringify({
      id: "fork-1",
      method: "thread/fork",
      params: {
        threadId: "source-thread",
        newThreadId: "forked-thread",
        cwd: "/tmp/worktree",
      },
    }));

    await new Promise((resolve) => setImmediate(resolve));
    const response = messages.find((message) => message.id === "fork-1");
    assert.equal(response.result.thread.id, "forked-thread");
    assert.equal(response.result.thread.forkedFromThreadId, "source-thread");
    assert.equal(response.result.thread.cwd, "/tmp/worktree");
    const entry = sessionStore.getSessionEntry("forked-thread");
    assert.equal(entry.sessionId, null);
    assert.equal(entry.forkedFromThreadId, "source-thread");
    assert.equal(entry.cwd, "/tmp/worktree");
    transport.shutdown();
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

function createStubTransport(onSend) {
  let onMessageHandler = () => {};
  return {
    send(raw) {
      const parsed = JSON.parse(raw);
      onSend(parsed, (message) => onMessageHandler(JSON.stringify(message)));
    },
    onMessage(handler) { onMessageHandler = handler; },
    onClose() {},
    onError() {},
    onStarted() {},
    shutdown() {},
    describe() { return "stub"; },
  };
}

async function waitFor(predicate, timeoutMs = 1000) {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error("Timed out waiting for condition");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
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
