// FILE: agent-router.js
// Purpose: Routes incoming RPC messages to the correct agent transport (Codex or Claude Code)
//   based on agentId in the message params or the saved session map. Presents the same
//   5-method interface as codex-transport.js so bridge.js needs only minimal changes.
// Layer: CLI service
// Exports: createAgentRouter
// Depends on: ./codex-transport, ./claude-code-transport, ./claude-code-session-map

const { createCodexTransport } = require("./codex-transport");
const { createClaudeCodeTransport } = require("./claude-code-transport");
const { getSessionEntry, saveSessionEntry } = require("./claude-code-session-map");

const AGENT_CODEX = "codex";
const AGENT_CLAUDE = "claude-code";

// Methods that the Claude Code transport owns and handles itself. Everything else
// goes to Codex (which is the authoritative server for thread/list merging etc.).
const CLAUDE_OWNED_METHODS = new Set([
  "thread/start",
  "turn/start",
  "turn/interrupt",
  "thread/turns/list",
  "thread/read",
  "thread/update",
  "thread/rename",
  "approval/response",
]);

// Methods where agentId must be inferred from context rather than params.
const THREAD_SCOPED_METHODS = new Set([
  "turn/start",
  "turn/interrupt",
  "thread/turns/list",
  "thread/read",
  "thread/update",
  "thread/rename",
]);

function createAgentRouter({ config = {}, sessionMap: _unused } = {}) {
  const listeners = createListenerBag();

  // Always create the Codex transport — it handles all existing behavior.
  const codexTransport = createCodexTransport({
    endpoint: config.codexEndpoint,
    env: process.env,
    appPath: config.codexAppPath,
  });

  // Only create the Claude Code transport when the feature flag is on.
  const claudeEnabled = config.claudeCodeEnabled === true;
  const claudeTransport = claudeEnabled
    ? createClaudeCodeTransport({ config })
    : null;

  // Wire both transports' outbound messages into the unified listener.
  codexTransport.onMessage((msg) => listeners.emitMessage(msg));
  codexTransport.onClose((...args) => listeners.emitClose(...args));
  codexTransport.onError((err) => listeners.emitError(err));
  codexTransport.onStarted((info) => listeners.emitStarted(info));

  if (claudeTransport) {
    claudeTransport.onMessage((msg) => listeners.emitMessage(msg));
    // Claude transport errors are non-fatal to the bridge (Codex still runs).
    claudeTransport.onError((err) => {
      console.error("[remodex:router] Claude transport error:", err.message);
    });
  }

  // Intercepts model/list, fetches Codex models via a bridge-managed request, then appends
  // the hardcoded Claude model list before responding to the phone.
  function handleMergedModelList(rawMessage, parsed, requestId) {
    if (requestId == null) {
      // Notification — just forward to Codex.
      codexTransport.send(rawMessage);
      return;
    }

    // Use a synthetic request id so the bridge-managed waiter picks up the Codex response.
    const syntheticId = `router-model-list-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const syntheticRequest = JSON.stringify({
      id: syntheticId,
      method: "model/list",
      params: parsed?.params || {},
    });

    // Register a one-shot listener on the Codex transport for this synthetic id.
    const originalOnMessage = listeners.onMessage;
    const interceptedResponses = new Map();

    function tryResolveModelList(rawMsg) {
      if (!interceptedResponses.has(syntheticId)) return false;
      let p;
      try { p = JSON.parse(rawMsg); } catch { return false; }
      if (String(p?.id) !== syntheticId) return false;

      const codexResult = p.result || {};
      const codexItems =
        codexResult.items
        || codexResult.data
        || codexResult.models
        || [];

      const merged = {
        ...codexResult,
        items: [...codexItems, ...CLAUDE_MODELS],
        data: [...codexItems, ...CLAUDE_MODELS],
      };

      interceptedResponses.delete(syntheticId);
      listeners.emitMessage(JSON.stringify({ id: requestId, result: merged }));
      return true;
    }

    interceptedResponses.set(syntheticId, true);

    // Temporarily wrap the listener to intercept the Codex response.
    codexTransport.onMessage((msg) => {
      if (!tryResolveModelList(msg)) {
        listeners.emitMessage(msg);
      }
    });

    // Restore normal message listener once we're done (give it 10s).
    const restoreTimer = setTimeout(() => {
      interceptedResponses.delete(syntheticId);
      codexTransport.onMessage((msg) => listeners.emitMessage(msg));
    }, 10_000);
    restoreTimer.unref?.();

    codexTransport.send(syntheticRequest);
  }

  return {
    mode: "router",
    describe() {
      return claudeEnabled
        ? "`codex app-server` + `@anthropic-ai/claude-agent-sdk`"
        : "`codex app-server`";
    },
    send(rawMessage) {
      let parsed;
      try { parsed = JSON.parse(rawMessage); } catch { return; }

      const method = typeof parsed?.method === "string" ? parsed.method.trim() : null;
      const id = parsed?.id ?? null;

      // JSON-RPC response (no method, has id): route to Claude if it matches a pending permission,
      // otherwise route to Codex (bridge-managed request waiters live there).
      if (!method && id != null) {
        if (claudeTransport?.isKnownPermissionId(String(id))) {
          claudeTransport.send(rawMessage);
        } else {
          codexTransport.send(rawMessage);
        }
        return;
      }

      // model/list: intercept when Claude is enabled to merge both agent model lists.
      if (method === "model/list" && claudeTransport) {
        handleMergedModelList(rawMessage, parsed, id);
        return;
      }

      const agentId = resolveAgentId(rawMessage);
      if (agentId === AGENT_CLAUDE && claudeTransport) {
        claudeTransport.send(rawMessage);
      } else {
        codexTransport.send(rawMessage);
      }
    },
    onMessage(handler) { listeners.onMessage = handler; },
    onClose(handler)   { listeners.onClose = handler; },
    onError(handler)   { listeners.onError = handler; },
    onStarted(handler) { listeners.onStarted = handler; },
    shutdown() {
      codexTransport.shutdown?.();
      claudeTransport?.shutdown?.();
    },
  };
}

// ─── model/list merge ─────────────────────────────────────────────────────────

const CLAUDE_MODELS = [
  {
    id: "claude-opus-4-7",
    model: "claude-opus-4-7",
    displayName: "Claude Opus",
    description: "Most capable Claude model for complex tasks.",
    isDefault: false,
    modelProvider: "claude",
    model_provider: "claude",
    supportsFastMode: false,
    supportedReasoningEfforts: [],
    defaultReasoningEffort: null,
  },
  {
    id: "claude-sonnet-4-6",
    model: "claude-sonnet-4-6",
    displayName: "Claude Sonnet",
    description: "Balanced performance and speed.",
    isDefault: true,
    modelProvider: "claude",
    model_provider: "claude",
    supportsFastMode: false,
    supportedReasoningEfforts: [],
    defaultReasoningEffort: null,
  },
  {
    id: "claude-haiku-4-5-20251001",
    model: "claude-haiku-4-5-20251001",
    displayName: "Claude Haiku",
    description: "Fastest Claude model for lightweight tasks.",
    isDefault: false,
    modelProvider: "claude",
    model_provider: "claude",
    supportsFastMode: false,
    supportedReasoningEfforts: [],
    defaultReasoningEffort: null,
  },
];

// ─── Agent ID resolution ───────────────────────────────────────────────────────

function resolveAgentId(rawMessage) {
  let parsed;
  try {
    parsed = JSON.parse(rawMessage);
  } catch {
    return AGENT_CODEX;
  }

  const method = typeof parsed?.method === "string" ? parsed.method.trim() : "";
  const params = parsed?.params || {};

  // 1. Explicit agentId in params always wins.
  const explicitAgentId = normalizeAgentId(params.agentId || params.agent_id);
  if (explicitAgentId) return explicitAgentId;

  // 2. For thread-scoped methods, look up the saved session entry.
  if (THREAD_SCOPED_METHODS.has(method)) {
    const threadId = extractThreadId(params);
    if (threadId) {
      const entry = getSessionEntry(threadId);
      if (entry?.agentId) return normalizeAgentId(entry.agentId) || AGENT_CODEX;
    }
  }

  // 3. Default: Codex. Log fallthrough for turn/start and thread/start as a routing regression signal.
  if (method === "turn/start" || method === "thread/start") {
    const threadId = extractThreadId(params);
    console.warn(
      `[remodex:router] ${method} has no agentId and no session entry, routing to codex. threadId=${threadId || "(none)"}`
    );
  }
  return AGENT_CODEX;
}

function normalizeAgentId(value) {
  const s = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (s === AGENT_CLAUDE || s === "claude") return AGENT_CLAUDE;
  if (s === AGENT_CODEX) return AGENT_CODEX;
  return null;
}

function extractThreadId(params) {
  for (const key of ["threadId", "thread_id", "conversationId"]) {
    if (typeof params[key] === "string" && params[key].trim()) {
      return params[key].trim();
    }
  }
  return null;
}

function createListenerBag() {
  return {
    onMessage: null,
    onClose: null,
    onError: null,
    onStarted: null,
    emitMessage(msg) { this.onMessage?.(msg); },
    emitClose(...args) { this.onClose?.(...args); },
    emitError(err) { this.onError?.(err); },
    emitStarted(info) { this.onStarted?.(info); },
  };
}

module.exports = { createAgentRouter };
