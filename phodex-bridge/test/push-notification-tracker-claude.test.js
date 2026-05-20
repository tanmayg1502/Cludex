// FILE: push-notification-tracker-claude.test.js
// Purpose: Verifies that Claude-agent messages fire push notifications and carry correct agent labels.
// Layer: Unit test
// Exports: node:test suite
// Depends on: node:test, node:assert/strict, ../src/push-notification-tracker

const test = require("node:test");
const assert = require("node:assert/strict");

const { createPushNotificationTracker } = require("../src/push-notification-tracker");

function makeTracker(notifications) {
  return createPushNotificationTracker({
    sessionId: "session-claude-test",
    pushServiceClient: {
      hasConfiguredBaseUrl: true,
      async notifyCompletion(payload) {
        notifications.push(payload);
        return { ok: true };
      },
    },
    previewMaxChars: 80,
  });
}

// ─── Case 1: Claude turn/completed fires a push ──────────────────────────────

test("Claude turn completed fires a push notification", async () => {
  const notifications = [];
  const tracker = makeTracker(notifications);

  const threadId = "claude-thread-1";
  const turnId = "550e8400-e29b-41d4-a716-446655440000"; // UUIDv4

  tracker.handleOutbound(JSON.stringify({
    method: "thread/started",
    params: {
      thread: {
        id: threadId,
        title: "Refactor auth module",
      },
    },
  }));
  tracker.handleOutbound(JSON.stringify({
    method: "turn/started",
    params: {
      threadId,
      turnId,
      agentId: "claude-code",
    },
  }));
  tracker.handleOutbound(JSON.stringify({
    method: "turn/completed",
    params: {
      threadId,
      turnId,
      agentId: "claude-code",
    },
  }));

  await new Promise((resolve) => setTimeout(resolve, 10));

  assert.equal(notifications.length, 1, "expected exactly one push notification");
  assert.equal(notifications[0].threadId, threadId);
  assert.equal(notifications[0].turnId, turnId);
  assert.equal(notifications[0].result, "completed");
});

// ─── Case 2: Claude approval request fires a push ───────────────────────────

test("Claude approval request fires a push notification", async () => {
  const notifications = [];
  const tracker = makeTracker(notifications);

  const threadId = "claude-thread-2";
  const turnId = "660e8400-e29b-41d4-a716-446655440001";

  tracker.handleOutbound(JSON.stringify({
    method: "turn/started",
    params: {
      threadId,
      turnId,
      agentId: "claude-code",
    },
  }));
  tracker.handleOutbound(JSON.stringify({
    method: "item/commandExecution/requestApproval",
    params: {
      threadId,
      turnId,
      agentId: "claude-code",
      item: {
        command: "rm -rf /tmp/test",
      },
    },
  }));

  await new Promise((resolve) => setTimeout(resolve, 10));

  assert.equal(notifications.length, 1, "expected exactly one push for approval");
  assert.equal(notifications[0].result, "approval");
  assert.equal(notifications[0].body, "Claude needs approval");
});

// ─── Case 3: Codex turn/completed still fires (regression guard) ─────────────

test("Codex turn completed still fires a push notification", async () => {
  const notifications = [];
  const tracker = makeTracker(notifications);

  const threadId = "codex-thread-1";
  const turnId = "codex-turn-1";

  tracker.handleOutbound(JSON.stringify({
    method: "thread/started",
    params: {
      thread: {
        id: threadId,
        title: "Fix the flaky test",
      },
    },
  }));
  tracker.handleOutbound(JSON.stringify({
    method: "turn/started",
    params: {
      threadId,
      turnId,
    },
  }));
  tracker.handleOutbound(JSON.stringify({
    method: "turn/completed",
    params: {
      threadId,
      turnId,
    },
  }));

  await new Promise((resolve) => setTimeout(resolve, 10));

  assert.equal(notifications.length, 1, "Codex turn completion must still push");
  assert.equal(notifications[0].threadId, threadId);
  assert.equal(notifications[0].turnId, turnId);
  assert.equal(notifications[0].result, "completed");
});

// ─── Case 4: Push body identifies agent correctly ────────────────────────────

test("Push body says 'Claude finished a turn' for claude-code and 'Response ready' for Codex", async () => {
  const claudeNotifications = [];
  const claudeTracker = createPushNotificationTracker({
    sessionId: "session-claude-body",
    pushServiceClient: {
      hasConfiguredBaseUrl: true,
      async notifyCompletion(payload) {
        claudeNotifications.push(payload);
        return { ok: true };
      },
    },
  });

  const codexNotifications = [];
  const codexTracker = createPushNotificationTracker({
    sessionId: "session-codex-body",
    pushServiceClient: {
      hasConfiguredBaseUrl: true,
      async notifyCompletion(payload) {
        codexNotifications.push(payload);
        return { ok: true };
      },
    },
  });

  // Claude turn
  claudeTracker.handleOutbound(JSON.stringify({
    method: "turn/completed",
    params: {
      threadId: "thread-agent-body-a",
      turnId: "turn-agent-body-a",
      agentId: "claude-code",
    },
  }));

  // Codex turn (no agentId)
  codexTracker.handleOutbound(JSON.stringify({
    method: "turn/completed",
    params: {
      threadId: "thread-agent-body-b",
      turnId: "turn-agent-body-b",
    },
  }));

  await new Promise((resolve) => setTimeout(resolve, 10));

  assert.equal(claudeNotifications.length, 1);
  assert.equal(claudeNotifications[0].body, "Claude finished a turn", "Claude body should identify Claude");

  assert.equal(codexNotifications.length, 1);
  assert.equal(codexNotifications[0].body, "Response ready", "Codex body should use original label");
});

// ─── Case 5: Claude approval body says 'Codex needs approval' for codex ─────

test("Approval body uses correct agent label for Codex", async () => {
  const notifications = [];
  const tracker = makeTracker(notifications);

  tracker.handleOutbound(JSON.stringify({
    method: "turn/started",
    params: {
      threadId: "codex-approval-thread",
      turnId: "codex-approval-turn",
    },
  }));
  tracker.handleOutbound(JSON.stringify({
    method: "item/commandExecution/requestApproval",
    params: {
      threadId: "codex-approval-thread",
      turnId: "codex-approval-turn",
      item: {
        command: "npm run build",
      },
    },
  }));

  await new Promise((resolve) => setTimeout(resolve, 10));

  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].body, "Codex needs approval");
});
