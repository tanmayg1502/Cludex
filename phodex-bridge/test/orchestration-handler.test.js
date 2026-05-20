// FILE: orchestration-handler.test.js
// Purpose: Verifies orchestration/start RPC handling — multi-step chaining, progress notifications,
//   failure mid-chain, and default follow-up prompts.
// Layer: Unit test
// Exports: node:test suite
// Depends on: node:test, node:assert/strict, ../src/orchestration-handler

const test = require("node:test");
const assert = require("node:assert/strict");
const { handleOrchestrationRequest } = require("../src/orchestration-handler");

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Builds a mock router whose runDirectTurn calls the supplied resultFn(stepIndex)
 * to get the result string. Optionally throws on the step whose index matches `failOnStep`.
 */
function mockRouter({ resultFn, failOnStep = -1 } = {}) {
  let callIndex = 0;
  const calls = [];

  return {
    calls,
    runDirectTurn(opts) {
      const idx = callIndex++;
      calls.push({ idx, opts });
      if (idx === failOnStep) {
        return Promise.reject(new Error(`Simulated failure at step ${idx}`));
      }
      const result = resultFn ? resultFn(idx) : `result-${idx}`;
      return Promise.resolve({ result, threadId: opts.threadId });
    },
  };
}

/**
 * Sends an orchestration/start request and collects all notifications + the RPC reply.
 * Returns a Promise that resolves to the array of parsed messages once orchestration
 * completes or fails.
 */
function runOrchestration(params, router) {
  return new Promise((resolve) => {
    const messages = [];

    function sendResponse(raw) {
      messages.push(JSON.parse(raw));
      // Resolve after orchestration/completed or orchestration/failed arrives.
      const last = messages[messages.length - 1];
      const method = last?.method;
      if (method === "orchestration/completed" || method === "orchestration/failed") {
        // Give the current tick a beat to ensure no extra messages sneak in.
        setImmediate(() => resolve(messages));
      }
    }

    const rawMessage = JSON.stringify({
      id: "test-rpc-1",
      method: "orchestration/start",
      params,
    });

    const handled = handleOrchestrationRequest(rawMessage, sendResponse, { router });
    assert.equal(handled, true, "handleOrchestrationRequest should return true");
  });
}

// ─── Tests ────────────────────────────────────────────────────────────────────

test("happy path 3-step: correct notification sequence and prompt chaining", async () => {
  const results = ["done-1", "done-2", "done-3"];
  const router = mockRouter({ resultFn: (i) => results[i] });

  const messages = await runOrchestration(
    {
      steps: [
        { agentId: "claude-code", model: "claude-opus-4-7",   role: "planner",     prompt: "Make a plan." },
        { agentId: "codex",       model: "gpt-5",             role: "implementer", prompt: "" },
        { agentId: "claude-code", model: "claude-sonnet-4-6", role: "reviewer",    prompt: "" },
      ],
      cwd: "/tmp/test-project",
      parentThreadId: null,
      title: "Test orchestration",
    },
    router
  );

  // Extract notifications by method (skip the initial RPC result reply).
  const byMethod = (method) => messages.filter((m) => m.method === method);

  // 1a. Exactly one orchestration/started.
  const started = byMethod("orchestration/started");
  assert.equal(started.length, 1, "exactly one orchestration/started");

  // 1b. Exactly three orchestration/step/started.
  const stepStarted = byMethod("orchestration/step/started");
  assert.equal(stepStarted.length, 3, "three orchestration/step/started");

  // 1c. Exactly three orchestration/step/completed.
  const stepCompleted = byMethod("orchestration/step/completed");
  assert.equal(stepCompleted.length, 3, "three orchestration/step/completed");

  // 1d. Exactly one orchestration/completed.
  const completed = byMethod("orchestration/completed");
  assert.equal(completed.length, 1, "exactly one orchestration/completed");

  // 1e. No orchestration/failed.
  assert.equal(byMethod("orchestration/failed").length, 0, "no orchestration/failed");

  // 1f. All share the same orchestrationId.
  const oid = started[0].params.orchestrationId;
  assert.ok(typeof oid === "string" && oid.length > 0, "orchestrationId is a non-empty string");
  for (const m of messages) {
    if (m.params?.orchestrationId !== undefined) {
      assert.equal(m.params.orchestrationId, oid, `all messages share orchestrationId`);
    }
  }

  // 1g. Step 1 (implementer) prompt should contain done-1.
  const step1Prompt = router.calls[1].opts.prompt;
  assert.ok(
    step1Prompt.includes("done-1"),
    `Step 1 prompt must include the previous result "done-1". Got: ${step1Prompt}`
  );

  // 1h. Step 2 (reviewer) prompt should contain done-2.
  const step2Prompt = router.calls[2].opts.prompt;
  assert.ok(
    step2Prompt.includes("done-2"),
    `Step 2 prompt must include the previous result "done-2". Got: ${step2Prompt}`
  );

  // 1i. All step threadIds are unique.
  const threadIds = stepStarted.map((m) => m.params.threadId);
  const uniqueThreadIds = new Set(threadIds);
  assert.equal(uniqueThreadIds.size, 3, "all step threadIds must be unique");

  // 1j. Correct order: started, step/started(0), step/completed(0), step/started(1), ...
  const methodSequence = messages.map((m) => m.method ?? "(rpc-result)");
  const notifSequence = methodSequence.filter((m) => m !== "(rpc-result)");
  assert.deepEqual(notifSequence, [
    "thread/started",
    "orchestration/started",
    "orchestration/step/started",
    "orchestration/step/completed",
    "orchestration/step/started",
    "orchestration/step/completed",
    "orchestration/step/started",
    "orchestration/step/completed",
    "orchestration/completed",
  ], "notification order must match expected sequence");

  const parentStarted = byMethod("thread/started");
  assert.equal(parentStarted.length, 1, "orchestration should create one parent thread");
  assert.equal(parentStarted[0].params.thread.agentId, "orchestration");
  assert.equal(parentStarted[0].params.thread.id, started[0].params.parentThreadId);
  assert.equal(router.calls[0].opts.parentThreadId, started[0].params.parentThreadId);
  assert.equal(router.calls[0].opts.role, "planner");
  assert.equal(router.calls[1].opts.role, "implementer");
  assert.equal(router.calls[2].opts.role, "reviewer");
});

test("failure mid-chain: orchestration/failed emitted with correct stepIndex, no orchestration/completed", async () => {
  const router = mockRouter({ resultFn: (i) => `result-${i}`, failOnStep: 1 });

  const messages = await runOrchestration(
    {
      steps: [
        { agentId: "claude-code", model: "claude-opus-4-7",   role: "planner",     prompt: "Plan it." },
        { agentId: "codex",       model: "gpt-5",             role: "implementer", prompt: "" },
        { agentId: "claude-code", model: "claude-sonnet-4-6", role: "reviewer",    prompt: "" },
      ],
      cwd: "/tmp/test-project",
      parentThreadId: null,
    },
    router
  );

  const failed = messages.filter((m) => m.method === "orchestration/failed");
  assert.equal(failed.length, 1, "exactly one orchestration/failed");
  assert.equal(failed[0].params.stepIndex, 1, "failed at stepIndex 1");
  assert.ok(
    typeof failed[0].params.error === "string" && failed[0].params.error.length > 0,
    "error field is a non-empty string"
  );

  const completed = messages.filter((m) => m.method === "orchestration/completed");
  assert.equal(completed.length, 0, "orchestration/completed must not be emitted after failure");
});

test("default follow-up prompts: implementer gets 'Implement the plan above.' when prompt is omitted", async () => {
  const router = mockRouter({ resultFn: (i) => `plan-output-${i}` });

  await runOrchestration(
    {
      steps: [
        { agentId: "claude-code", model: "claude-opus-4-7",   role: "planner",     prompt: "Build a web app." },
        { agentId: "codex",       model: "gpt-5",             role: "implementer" /* no prompt */ },
      ],
      cwd: "/tmp/test-project",
      parentThreadId: null,
    },
    router
  );

  const implementerPrompt = router.calls[1].opts.prompt;
  assert.ok(
    implementerPrompt.includes("Implement the plan above."),
    `Implementer prompt must contain default text. Got: ${implementerPrompt}`
  );
});

test("handleOrchestrationRequest ignores non-orchestration messages", () => {
  let called = false;
  const handled = handleOrchestrationRequest(
    JSON.stringify({ id: "x", method: "turn/start", params: {} }),
    () => { called = true; },
    { router: mockRouter() }
  );
  assert.equal(handled, false);
  assert.equal(called, false);
});

test("handleOrchestrationRequest handles malformed JSON gracefully", () => {
  const handled = handleOrchestrationRequest(
    "not-json{{{",
    () => {},
    { router: mockRouter() }
  );
  assert.equal(handled, false);
});
