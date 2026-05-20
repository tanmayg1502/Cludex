// FILE: claude-code-transport-thinking.test.js
// Purpose: Verifies that Claude thinking-blocks (extended thinking) are forwarded
//   to iOS as item/reasoning/textDelta and item/completed(reasoning) events.
// Layer: Unit test
// Exports: node:test suite
// Run: node --test ./test/claude-code-transport-thinking.test.js

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
 * Runs a fake turn through the transport using the provided async-generator factory
 * as the SDK query implementation. Resolves with all emitted messages once
 * turn/completed is received.
 */
function runFakeTurn(queryImpl, { threadId = "thread-thinking-test" } = {}) {
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
        input: [{ type: "text", text: "think hard" }],
      },
    }));
  });
}

// ─── Tests ────────────────────────────────────────────────────────────────────

test("streaming thinking deltas produce item/reasoning/textDelta and item/completed(reasoning)", async () => {
  const messages = await runFakeTurn(async function* () {
    yield { type: "system", subtype: "init", session_id: "sess-1" };
    yield {
      type: "stream_event",
      event: {
        type: "content_block_delta",
        delta: { type: "thinking_delta", thinking: "Let me think..." },
      },
    };
    yield {
      type: "stream_event",
      event: {
        type: "content_block_delta",
        delta: { type: "thinking_delta", thinking: " more thinking." },
      },
    };
    yield {
      type: "assistant",
      message: {
        id: "msg-streaming-thinking",
        content: [{ type: "text", text: "Here's the answer." }],
      },
    };
    yield {
      type: "result",
      subtype: "success",
      is_error: false,
      result: "Here's the answer.",
    };
  });

  const methods = messages.map((m) => m.method).filter(Boolean);

  // At least one reasoning delta must be emitted.
  const reasoningDeltas = messages.filter((m) => m.method === "item/reasoning/textDelta");
  assert.ok(reasoningDeltas.length >= 1, "should emit at least one item/reasoning/textDelta");

  // All reasoning deltas must carry non-empty delta strings.
  for (const rd of reasoningDeltas) {
    assert.ok(typeof rd.params.delta === "string" && rd.params.delta.length > 0,
      "each reasoning delta must carry a non-empty delta string");
    assert.ok(rd.params.threadId, "reasoning delta must have threadId");
    assert.ok(rd.params.turnId, "reasoning delta must have turnId");
    assert.ok(rd.params.itemId, "reasoning delta must have itemId");
    assert.equal(rd.params.agentId, "claude-code");
  }

  // All reasoning deltas should share the same stable itemId.
  const reasoningItemIds = [...new Set(reasoningDeltas.map((m) => m.params.itemId))];
  assert.equal(reasoningItemIds.length, 1, "all reasoning deltas should share the same itemId");

  // Exactly one item/completed with type "reasoning" must be emitted.
  const reasoningCompleted = messages.filter(
    (m) => m.method === "item/completed" && m.params?.item?.type === "reasoning"
  );
  assert.equal(reasoningCompleted.length, 1, "exactly one item/completed with type=reasoning");

  const rc = reasoningCompleted[0];
  assert.equal(rc.params.item.role, "assistant");
  // Full accumulated text must contain both deltas.
  assert.ok(rc.params.item.content.includes("Let me think..."), "content should include first delta");
  assert.ok(rc.params.item.content.includes(" more thinking."), "content should include second delta");
  assert.equal(rc.params.item.content, "Let me think... more thinking.");
  // itemId in completed must match the delta itemId.
  assert.equal(rc.params.itemId, reasoningItemIds[0]);
  assert.equal(rc.params.item.id, reasoningItemIds[0]);

  // turn/completed must come last.
  assert.equal(methods[methods.length - 1], "turn/completed");

  // The reasoning item/completed must precede the agent_message item/completed.
  const completedItems = messages.filter((m) => m.method === "item/completed");
  const reasoningIdx = completedItems.findIndex((m) => m.params?.item?.type === "reasoning");
  const agentMsgIdx = completedItems.findIndex((m) => m.params?.item?.type === "agent_message");
  assert.ok(reasoningIdx < agentMsgIdx, "reasoning item/completed should precede agent_message item/completed");
});

test("inline thinking block in assistant message produces reasoning events", async () => {
  const messages = await runFakeTurn(async function* () {
    yield { type: "system", subtype: "init", session_id: "sess-2" };
    yield {
      type: "assistant",
      message: {
        id: "msg-inline",
        content: [
          { type: "thinking", thinking: "Hidden reasoning." },
          { type: "text", text: "Visible answer." },
        ],
      },
    };
    yield {
      type: "result",
      subtype: "success",
      is_error: false,
      result: "Visible answer.",
    };
  });

  // Must emit at least one reasoning delta for the thinking block.
  const reasoningDeltas = messages.filter((m) => m.method === "item/reasoning/textDelta");
  assert.ok(reasoningDeltas.length >= 1, "inline thinking block should emit item/reasoning/textDelta");
  assert.equal(reasoningDeltas[0].params.delta, "Hidden reasoning.");

  // Must emit a completed reasoning item.
  const reasoningCompleted = messages.filter(
    (m) => m.method === "item/completed" && m.params?.item?.type === "reasoning"
  );
  assert.equal(reasoningCompleted.length, 1, "exactly one reasoning item/completed for inline thinking block");
  assert.equal(reasoningCompleted[0].params.item.content, "Hidden reasoning.");
  assert.equal(reasoningCompleted[0].params.item.role, "assistant");

  // Must also emit the agent_message item/completed for the text block.
  const agentMsgCompleted = messages.filter(
    (m) => m.method === "item/completed" && m.params?.item?.type === "agent_message"
  );
  assert.ok(agentMsgCompleted.length >= 1, "should emit agent_message item/completed");
  assert.ok(agentMsgCompleted[0].params.item.text.includes("Visible answer."));
});

test("text-only turn emits no reasoning events (regression guard)", async () => {
  const messages = await runFakeTurn(async function* () {
    yield { type: "system", subtype: "init", session_id: "sess-3" };
    yield {
      type: "stream_event",
      event: {
        type: "content_block_delta",
        delta: { type: "text_delta", text: "Plain text." },
      },
    };
    yield {
      type: "assistant",
      message: {
        id: "msg-text-only",
        content: [{ type: "text", text: "Plain text." }],
      },
    };
    yield {
      type: "result",
      subtype: "success",
      is_error: false,
      result: "Plain text.",
    };
  });

  const reasoningMessages = messages.filter(
    (m) => m.method === "item/reasoning/textDelta"
      || (m.method === "item/completed" && m.params?.item?.type === "reasoning")
  );
  assert.equal(reasoningMessages.length, 0,
    "text-only turn must not emit any item/reasoning/* messages");

  // Normal assistant text flow must still work.
  const agentMsgCompleted = messages.filter(
    (m) => m.method === "item/completed" && m.params?.item?.type === "agent_message"
  );
  assert.ok(agentMsgCompleted.length >= 1, "should still emit agent_message item/completed");
  assert.equal(agentMsgCompleted[0].params.item.text, "Plain text.");
});
