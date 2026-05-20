// FILE: orchestration-handler.js
// Purpose: Handles orchestration/start RPC requests — runs a sequential chain of agent turns
//   (Opus plans, Codex implements, Sonnet reviews), threads each step's output into the next,
//   and emits progress notifications back to the caller via sendResponse.
// Layer: Bridge handler
// Exports: handleOrchestrationRequest
// Depends on: crypto

const { randomUUID } = require("crypto");

// ─── Default follow-up prompts per role ──────────────────────────────────────

function defaultRoleFollowupPrompt(role) {
  switch (role) {
    case "implementer":
      return "Implement the plan above.";
    case "reviewer":
      return "Review the implementation above and list issues.";
    default:
      return null;
  }
}

// ─── Prompt construction ──────────────────────────────────────────────────────

function buildStepPrompt(stepIndex, step, prevResult, prevRole) {
  if (stepIndex === 0) {
    // First step uses its own prompt as-is.
    if (!step.prompt) {
      throw new Error(`Step 0 must have a prompt (role: ${step.role})`);
    }
    return step.prompt;
  }

  // Build context prefix from previous step's result.
  const prefix = `# Previous step output (role: ${prevRole})\n\n${prevResult}\n\n---\n\n`;

  // Determine follow-up body.
  let body = step.prompt;
  if (!body || !body.trim()) {
    const fallback = defaultRoleFollowupPrompt(step.role);
    if (fallback == null) {
      throw new Error(
        `Step ${stepIndex} (role: ${step.role}) has no prompt and no default follow-up. ` +
        `Provide a prompt or use a role with a default (implementer, reviewer).`
      );
    }
    body = fallback;
  }

  return prefix + body;
}

// ─── Notification helpers ─────────────────────────────────────────────────────

function sendNotification(sendResponse, method, params) {
  sendResponse(JSON.stringify({ method, params }));
}

function buildOrchestrationParentThread(parentThreadId, { title, cwd, createdAt }) {
  const resolvedTitle = typeof title === "string" && title.trim()
    ? title.trim()
    : "Multi-agent orchestration";
  return {
    id: parentThreadId,
    threadId: parentThreadId,
    thread_id: parentThreadId,
    title: resolvedTitle,
    name: resolvedTitle,
    agentId: "orchestration",
    agent_id: "orchestration",
    model: null,
    modelProvider: "orchestration",
    model_provider: "orchestration",
    cwd,
    createdAt,
    updatedAt: createdAt,
  };
}

// ─── Main handler ─────────────────────────────────────────────────────────────

/**
 * Returns true if the message was an orchestration/start request and was handled
 * (or failed to handle). Returns false if this is not an orchestration request.
 *
 * @param {string} rawMessage  - raw JSON-RPC string from the phone
 * @param {Function} sendResponse  - sendApplicationResponse callback
 * @param {{ router: object }} context  - { router } where router has runDirectTurn()
 */
function handleOrchestrationRequest(rawMessage, sendResponse, context) {
  let parsed;
  try {
    parsed = JSON.parse(rawMessage);
  } catch {
    return false;
  }

  if (parsed?.method !== "orchestration/start") {
    return false;
  }

  const rpcId = parsed.id ?? null;
  const params = parsed.params || {};

  // Kick off asynchronously; return true immediately so bridge.js can return.
  runOrchestration(rpcId, params, sendResponse, context).catch((unexpectedErr) => {
    // Should not normally reach here — errors are caught per-step — but guard anyway.
    console.error("[remodex:orchestration] Unhandled orchestration error:", unexpectedErr);
  });

  return true;
}

async function runOrchestration(rpcId, params, sendResponse, { router }) {
  const {
    steps = [],
    cwd = process.cwd(),
    parentThreadId: callerParentThreadId = null,
    title = null,
  } = params;

  // Validate steps array upfront.
  if (!Array.isArray(steps) || steps.length === 0) {
    sendResponse(
      JSON.stringify({
        id: rpcId,
        error: { code: -32602, message: "orchestration/start requires at least one step in params.steps" },
      })
    );
    return;
  }

  const orchestrationId = randomUUID();
  const parentThreadId = callerParentThreadId || randomUUID();
  const createdAt = new Date().toISOString();
  const parentThread = buildOrchestrationParentThread(parentThreadId, { title, cwd, createdAt });

  // Acknowledge the RPC call immediately with a success result.
  if (rpcId != null) {
    sendResponse(JSON.stringify({ id: rpcId, result: { orchestrationId, parentThreadId, thread: parentThread } }));
  }

  sendNotification(sendResponse, "thread/started", {
    threadId: parentThreadId,
    thread_id: parentThreadId,
    thread: parentThread,
    ...parentThread,
  });

  // Emit orchestration/started notification.
  sendNotification(sendResponse, "orchestration/started", {
    orchestrationId,
    parentThreadId,
    steps: steps.map((s, i) => ({
      stepIndex: i,
      role: s.role,
      agentId: s.agentId,
      model: s.model,
    })),
  });

  let prevResult = null;
  let prevRole = null;
  let completedCount = 0;

  for (let stepIndex = 0; stepIndex < steps.length; stepIndex++) {
    const step = steps[stepIndex];
    const threadId = randomUUID();

    // Build effective prompt.
    let effectivePrompt;
    try {
      effectivePrompt = buildStepPrompt(stepIndex, step, prevResult, prevRole);
    } catch (promptErr) {
      sendNotification(sendResponse, "orchestration/failed", {
        orchestrationId,
        stepIndex,
        error: promptErr.message,
      });
      return;
    }

    // Emit step/started.
    sendNotification(sendResponse, "orchestration/step/started", {
      orchestrationId,
      stepIndex,
      role: step.role,
      agentId: step.agentId,
      model: step.model,
      threadId,
    });

    // Run the turn via the agent router.
    let turnResult;
    try {
      turnResult = await router.runDirectTurn({
        agentId: step.agentId,
        threadId,
        prompt: effectivePrompt,
        cwd,
        model: step.model,
        role: step.role,
        title: `${step.role || "agent"} step`,
        parentThreadId,
      });
    } catch (turnErr) {
      sendNotification(sendResponse, "orchestration/failed", {
        orchestrationId,
        stepIndex,
        error: turnErr?.message || String(turnErr),
      });
      return;
    }

    const result = turnResult?.result ?? "";
    const summary = result.slice(0, 200);

    // Emit step/completed.
    sendNotification(sendResponse, "orchestration/step/completed", {
      orchestrationId,
      stepIndex,
      role: step.role,
      threadId,
      result,
      summary,
    });

    prevResult = result;
    prevRole = step.role;
    completedCount++;
  }

  // All steps done.
  sendNotification(sendResponse, "orchestration/completed", {
    orchestrationId,
    parentThreadId,
    stepsCompleted: completedCount,
  });
}

module.exports = { handleOrchestrationRequest };
