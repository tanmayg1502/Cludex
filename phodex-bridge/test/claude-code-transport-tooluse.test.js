// FILE: claude-code-transport-tooluse.test.js
// Purpose: Verifies that Claude tool calls (Bash, Edit, Write, Read, Glob, Grep)
//   are forwarded to iOS as item/started and item/completed events with the correct
//   item types: commandExecution and fileChange.
// Layer: Unit test
// Run: node --test ./test/claude-code-transport-tooluse.test.js

const test = require("node:test");
const assert = require("node:assert/strict");
const { createClaudeCodeTransport } = require("../src/claude-code-transport");

// ─── Helpers ─────────────────────────────────────────────────────────────────

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
      return Array.from(entries.entries()).map(([threadId, e]) => ({ threadId, ...e }));
    },
  };
}

/**
 * Runs a fake turn through the transport. Resolves with all emitted messages
 * once turn/completed is received.
 */
function runFakeTurn(queryImpl, { threadId = "thread-tooluse-test" } = {}) {
  return new Promise((resolve, reject) => {
    const sessionStore = createMemorySessionStore();
    const transport = createClaudeCodeTransport({ config: {}, sessionStore, queryImpl });

    const messages = [];
    transport.onMessage((raw) => {
      const parsed = JSON.parse(raw);
      messages.push(parsed);
      if (parsed.method === "turn/completed") {
        transport.shutdown();
        resolve(messages);
      }
    });
    transport.onError((err) => {
      transport.shutdown();
      reject(err);
    });

    transport.send(JSON.stringify({
      id: "req-1",
      method: "turn/start",
      params: {
        threadId,
        input: [{ type: "text", text: "do something" }],
      },
    }));
  });
}

// ─── Tests ────────────────────────────────────────────────────────────────────

test("Bash tool call emits item/started(commandExecution) and item/completed with output", async () => {
  const messages = await runFakeTurn(async function* () {
    yield { type: "system", subtype: "init", session_id: "sess-bash" };
    yield {
      type: "assistant",
      message: {
        id: "msg-bash",
        content: [
          { type: "tool_use", id: "tu_1", name: "Bash", input: { command: "ls" } },
        ],
      },
    };
    yield {
      type: "user",
      message: {
        content: [
          { type: "tool_result", tool_use_id: "tu_1", content: "file1.txt", is_error: false },
        ],
      },
    };
    yield { type: "result", subtype: "success", is_error: false, result: "done" };
  });

  // item/started must be emitted with correct shape.
  const started = messages.filter(
    (m) => m.method === "item/started" && m.params?.item?.type === "commandExecution"
  );
  assert.equal(started.length, 1, "should emit exactly one item/started(commandExecution)");

  const startedParams = started[0].params;
  assert.ok(startedParams.threadId, "started must have threadId");
  assert.ok(startedParams.turnId, "started must have turnId");
  assert.ok(startedParams.itemId, "started must have itemId");
  assert.equal(startedParams.agentId, "claude-code");
  assert.equal(startedParams.item.command, "ls", "item.command must be the Bash command");
  assert.equal(startedParams.item.status, "running");

  // item/completed must be emitted with matching itemId.
  const completed = messages.filter(
    (m) => m.method === "item/completed" && m.params?.item?.type === "commandExecution"
  );
  assert.equal(completed.length, 1, "should emit exactly one item/completed(commandExecution)");

  const completedParams = completed[0].params;
  assert.equal(completedParams.itemId, startedParams.itemId, "itemId must match started");
  assert.equal(completedParams.item.output, "file1.txt", "output must be the tool result text");
  assert.equal(completedParams.item.status, "completed");

  // turn/completed must come last.
  const methods = messages.map((m) => m.method).filter(Boolean);
  assert.equal(methods[methods.length - 1], "turn/completed");
});

test("Edit tool call emits item/started(fileChange, changeType=modify) and item/completed", async () => {
  const messages = await runFakeTurn(async function* () {
    yield { type: "system", subtype: "init", session_id: "sess-edit" };
    yield {
      type: "assistant",
      message: {
        id: "msg-edit",
        content: [
          {
            type: "tool_use",
            id: "tu_2",
            name: "Edit",
            input: { file_path: "/tmp/x.txt", old_string: "a", new_string: "b" },
          },
        ],
      },
    };
    yield {
      type: "user",
      message: {
        content: [
          { type: "tool_result", tool_use_id: "tu_2", content: "edit applied", is_error: false },
        ],
      },
    };
    yield { type: "result", subtype: "success", is_error: false, result: "done" };
  });

  const started = messages.filter(
    (m) => m.method === "item/started" && m.params?.item?.type === "fileChange"
  );
  assert.equal(started.length, 1, "should emit exactly one item/started(fileChange)");

  const startedParams = started[0].params;
  assert.ok(startedParams.itemId, "started must have itemId");
  assert.equal(startedParams.item.changes[0].path, "/tmp/x.txt", "changes[0].path must match file_path");
  assert.equal(startedParams.item.changes[0].kind, "modify", "Edit produces changeType=modify");
  assert.equal(startedParams.item.status, "inProgress");

  const completed = messages.filter(
    (m) => m.method === "item/completed" && m.params?.item?.type === "fileChange"
  );
  assert.equal(completed.length, 1, "should emit exactly one item/completed(fileChange)");

  const completedParams = completed[0].params;
  assert.equal(completedParams.itemId, startedParams.itemId, "itemId must match started");
  assert.equal(completedParams.item.status, "completed");
  assert.ok(!completedParams.item.status.includes("fail"), "non-error result must show completed status");
});

test("Write tool call emits item/started(fileChange, changeType=create) and item/completed", async () => {
  const messages = await runFakeTurn(async function* () {
    yield { type: "system", subtype: "init", session_id: "sess-write" };
    yield {
      type: "assistant",
      message: {
        id: "msg-write",
        content: [
          {
            type: "tool_use",
            id: "tu_3",
            name: "Write",
            input: { file_path: "/tmp/new.txt", content: "hello world" },
          },
        ],
      },
    };
    yield {
      type: "user",
      message: {
        content: [
          { type: "tool_result", tool_use_id: "tu_3", content: "file written", is_error: false },
        ],
      },
    };
    yield { type: "result", subtype: "success", is_error: false, result: "done" };
  });

  const started = messages.filter(
    (m) => m.method === "item/started" && m.params?.item?.type === "fileChange"
  );
  assert.equal(started.length, 1, "Write should emit item/started(fileChange)");
  assert.equal(started[0].params.item.changes[0].kind, "create", "Write produces changeType=create");
  assert.equal(started[0].params.item.changes[0].path, "/tmp/new.txt");

  const completed = messages.filter(
    (m) => m.method === "item/completed" && m.params?.item?.type === "fileChange"
  );
  assert.equal(completed.length, 1, "Write should emit item/completed(fileChange)");
  assert.equal(completed[0].params.itemId, started[0].params.itemId, "itemId must match");
});

test("Tool error sets status=failed on item/completed", async () => {
  const messages = await runFakeTurn(async function* () {
    yield { type: "system", subtype: "init", session_id: "sess-error" };
    yield {
      type: "assistant",
      message: {
        id: "msg-error",
        content: [
          { type: "tool_use", id: "tu_4", name: "Bash", input: { command: "rm -rf /" } },
        ],
      },
    };
    yield {
      type: "user",
      message: {
        content: [
          { type: "tool_result", tool_use_id: "tu_4", content: "permission denied", is_error: true },
        ],
      },
    };
    yield { type: "result", subtype: "success", is_error: false, result: "done" };
  });

  const completed = messages.filter(
    (m) => m.method === "item/completed" && m.params?.item?.type === "commandExecution"
  );
  assert.equal(completed.length, 1, "should emit item/completed for error case");
  assert.equal(completed[0].params.item.status, "failed", "is_error=true must produce status=failed");
  assert.equal(completed[0].params.item.output, "permission denied");
});

test("text-only turn emits zero item/started and zero commandExecution/fileChange item/completed events", async () => {
  const messages = await runFakeTurn(async function* () {
    yield { type: "system", subtype: "init", session_id: "sess-text" };
    yield {
      type: "stream_event",
      event: {
        type: "content_block_delta",
        delta: { type: "text_delta", text: "Hello!" },
      },
    };
    yield {
      type: "assistant",
      message: {
        id: "msg-text",
        content: [{ type: "text", text: "Hello!" }],
      },
    };
    yield { type: "result", subtype: "success", is_error: false, result: "Hello!" };
  });

  const toolStarted = messages.filter((m) => m.method === "item/started");
  assert.equal(toolStarted.length, 0, "text-only turn must emit no item/started events");

  const toolCompleted = messages.filter(
    (m) => m.method === "item/completed"
      && (m.params?.item?.type === "commandExecution" || m.params?.item?.type === "fileChange")
  );
  assert.equal(toolCompleted.length, 0, "text-only turn must emit no commandExecution/fileChange item/completed events");

  // Normal agent message flow must still work.
  const agentMsg = messages.filter(
    (m) => m.method === "item/completed" && m.params?.item?.type === "agent_message"
  );
  assert.ok(agentMsg.length >= 1, "text-only turn must still emit agent_message item/completed");
});

test("Read tool call emits commandExecution with synthesized command", async () => {
  const messages = await runFakeTurn(async function* () {
    yield { type: "system", subtype: "init", session_id: "sess-read" };
    yield {
      type: "assistant",
      message: {
        id: "msg-read",
        content: [
          { type: "tool_use", id: "tu_5", name: "Read", input: { file_path: "/etc/hosts" } },
        ],
      },
    };
    yield {
      type: "user",
      message: {
        content: [
          { type: "tool_result", tool_use_id: "tu_5", content: "127.0.0.1 localhost", is_error: false },
        ],
      },
    };
    yield { type: "result", subtype: "success", is_error: false, result: "done" };
  });

  const started = messages.filter(
    (m) => m.method === "item/started" && m.params?.item?.type === "commandExecution"
  );
  assert.equal(started.length, 1, "Read should emit item/started(commandExecution)");
  assert.ok(
    started[0].params.item.command.includes("/etc/hosts"),
    "synthesized command should include the file_path"
  );
  assert.ok(
    started[0].params.item.command.startsWith("Read"),
    "synthesized command should start with the tool name"
  );
});

test("out-of-order tool_result (no matching id) logs warning and emits nothing", async () => {
  const warnLogs = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnLogs.push(args.join(" "));

  try {
    const messages = await runFakeTurn(async function* () {
      yield { type: "system", subtype: "init", session_id: "sess-orphan" };
      // tool_result with no matching tool_use — simulates out-of-order delivery.
      yield {
        type: "user",
        message: {
          content: [
            { type: "tool_result", tool_use_id: "tu_unknown", content: "stale result", is_error: false },
          ],
        },
      };
      yield {
        type: "assistant",
        message: {
          id: "msg-orphan",
          content: [{ type: "text", text: "Recovered." }],
        },
      };
      yield { type: "result", subtype: "success", is_error: false, result: "Recovered." };
    });

    // No spurious tool events should appear.
    const toolEvents = messages.filter(
      (m) => m.method === "item/started" || (
        m.method === "item/completed"
          && (m.params?.item?.type === "commandExecution" || m.params?.item?.type === "fileChange")
      )
    );
    assert.equal(toolEvents.length, 0, "orphaned tool_result must not produce any tool events");

    // A warning must have been logged.
    assert.ok(warnLogs.some((l) => l.includes("tool_result")), "should log a warning for unknown tool_use_id");
  } finally {
    console.warn = originalWarn;
  }
});
