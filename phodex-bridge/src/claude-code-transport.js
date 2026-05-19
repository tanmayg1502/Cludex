// FILE: claude-code-transport.js
// Purpose: Drives Claude Code via the Agent SDK, presenting the same 5-method interface
//   as codex-transport.js so the bridge can treat both agents uniformly.
// Layer: CLI service
// Exports: createClaudeCodeTransport
// Depends on: @anthropic-ai/claude-agent-sdk, crypto, ./claude-code-session-map

const { randomUUID } = require("crypto");
const {
  query,
  startup,
  listSessions,
  getSessionMessages,
  getSessionInfo,
  renameSession,
} = require("@anthropic-ai/claude-agent-sdk");
const {
  saveSessionEntry,
  getSessionEntry,
  listSessionEntries,
} = require("./claude-code-session-map");

const DEFAULT_PERMISSION_TIMEOUT_SECS = 30;
const DEFAULT_WARM_IDLE_TIMEOUT_SECS = 300;
const DEFAULT_PERMISSION_MODE = "acceptEdits";
const DEFAULT_MODEL = "claude-sonnet-4-6";
const MIN_PERMISSION_TIMEOUT_SECS = 10;
const MAX_PERMISSION_TIMEOUT_SECS = 120;

function createClaudeCodeTransport({
  config = {},
  logPrefix = "[remodex:claude]",
  queryImpl = query,
  sessionStore = {
    saveSessionEntry,
    getSessionEntry,
    listSessionEntries,
  },
} = {}) {
  const permissionTimeoutMs = clampPermissionTimeout(config.permissionTimeoutSecs) * 1000;
  const warmIdleTimeoutMs = (config.warmIdleTimeoutSecs ?? DEFAULT_WARM_IDLE_TIMEOUT_SECS) * 1000;
  const defaultPermissionMode = config.claudeCodeDefaultPermissionMode ?? DEFAULT_PERMISSION_MODE;

  // threadId → { sessionId, activeQuery, idleTimer, warmQuery }
  const activeSessions = new Map();

  // permissionId → { resolve, timer }
  const pendingPermissions = new Map();

  const listeners = createListenerBag();

  // ─── Public interface (matches codex-transport.js) ──────────────────────────

  return {
    mode: "claude-code",
    describe() {
      return "`@anthropic-ai/claude-agent-sdk`";
    },
    send(rawMessage) {
      let parsed;
      try { parsed = JSON.parse(rawMessage); } catch { return; }

      // JSON-RPC response (has id, no method) — check if it resolves a pending permission.
      if (parsed?.id != null && !parsed?.method) {
        handleIncomingPermissionResponse(String(parsed.id), parsed.result);
        return;
      }

      handleIncomingMessage(rawMessage).catch((err) => {
        console.error(`${logPrefix} unhandled send error:`, err.message, err.stack);
      });
    },
    // Returns true if this id is a pending Claude Code permission waiting for a response.
    isKnownPermissionId(id) {
      return pendingPermissions.has(String(id));
    },
    onMessage(handler) { listeners.onMessage = handler; },
    onClose(handler)   { listeners.onClose = handler; },
    onError(handler)   { listeners.onError = handler; },
    onStarted(handler) { listeners.onStarted = handler; },
    shutdown() {
      for (const [threadId, session] of activeSessions.entries()) {
        cleanupSession(threadId, session);
      }
      activeSessions.clear();
      for (const pending of pendingPermissions.values()) {
        clearTimeout(pending.timer);
        pending.resolve({ behavior: "deny", message: "Bridge shutting down." });
      }
      pendingPermissions.clear();
    },
  };

  // ─── Incoming message dispatch ───────────────────────────────────────────────

  async function handleIncomingMessage(rawMessage) {
    let parsed;
    try {
      parsed = JSON.parse(rawMessage);
    } catch {
      return;
    }

    const method = typeof parsed?.method === "string" ? parsed.method.trim() : "";
    const params = parsed?.params || {};
    const id = parsed?.id ?? null;

    switch (method) {
      case "thread/start":
        return handleThreadStart(id, params);
      case "turn/start":
        return handleTurnStart(id, params);
      case "turn/interrupt":
        return handleTurnInterrupt(params);
      case "thread/list":
        return handleThreadList(id, params);
      case "thread/turns/list":
        return handleThreadTurnsList(id, params);
      case "thread/read":
        return handleThreadRead(id, params);
      case "thread/update":
        return handleThreadUpdate(id, params);
      case "approval/response":
        return handleApprovalResponse(params);
      case "thread/rename":
        return handleThreadRename(id, params);
      default:
        // Silently ignore methods not owned by Claude Code transport.
    }
  }

  // ─── thread/start ────────────────────────────────────────────────────────────

  async function handleThreadStart(requestId, params) {
    const threadId = normalizeString(params.threadId) || randomUUID();
    const cwd = normalizeString(params.cwd) || process.cwd();
    const model = resolveClaudeModel(params.model);
    const permissionMode = normalizeString(params.permissionMode) || defaultPermissionMode;
    const firstMessage = normalizeString(params.content || params.message || params.prompt)
      || extractTextFromInputItems(params.input)
      || "";

    // Pre-warm the subprocess for faster first turn.
    warmSubprocess(threadId, cwd, model, permissionMode);

    if (firstMessage) {
      return runTurn(threadId, firstMessage, { cwd, model, permissionMode, isFirstTurn: true });
    }

    // No first message: just emit thread/started so the phone knows the thread exists.
    const entry = {
      sessionId: null,
      cwd,
      agentId: "claude-code",
      model,
      permissionMode,
      createdAt: new Date().toISOString(),
      title: null,
    };
    sessionStore.saveSessionEntry(threadId, entry);

    emit(JSON.stringify({
      method: "thread/started",
      params: buildThreadStartedParams(threadId, entry),
    }));

    if (requestId != null) {
      emit(JSON.stringify({
        id: requestId,
        result: { thread: buildThreadObject(threadId, entry) },
      }));
    }
  }

  // ─── turn/start ──────────────────────────────────────────────────────────────

  async function handleTurnStart(requestId, params) {
    const threadId = normalizeString(params.threadId || params.thread_id);
    const content = normalizeString(params.content || params.message || params.prompt)
      || extractTextFromInputItems(params.input);
    if (!threadId || !content) {
      if (requestId != null) {
        emit(JSON.stringify({
          id: requestId,
          error: { code: -32602, message: "turn/start requires threadId and content." },
        }));
      }
      return;
    }

    const entry = sessionStore.getSessionEntry(threadId);
    const cwd = normalizeString(entry?.cwd || params.cwd) || process.cwd();
    const model = resolveClaudeModel(params.model || entry?.model);
    const permissionMode = normalizeString(params.permissionMode || entry?.permissionMode) || defaultPermissionMode;

    if (requestId != null) {
      emit(JSON.stringify({ id: requestId, result: { ok: true } }));
    }

    return runTurn(threadId, content, { cwd, model, permissionMode, isFirstTurn: false });
  }

  // ─── Core turn runner ─────────────────────────────────────────────────────────

  async function runTurn(threadId, prompt, { cwd, model, permissionMode, isFirstTurn }) {
    const entry = sessionStore.getSessionEntry(threadId);
    const sessionId = entry?.sessionId || null;
    const turnId = randomUUID();

    const session = activeSessions.get(threadId) || {};
    resetIdleTimer(threadId, session);

    const queryOptions = {
      cwd,
      model,
      permissionMode,
      allowedTools: ["Read", "Write", "Edit", "Bash", "Glob", "Grep", "WebSearch", "WebFetch", "Agent"],
      includePartialMessages: true,
      canUseTool: (toolName, input, { signal }) =>
        handlePermissionRequest(threadId, toolName, input, signal),
    };

    if (sessionId) {
      queryOptions.resume = sessionId;
    }

    let capturedSessionId = sessionId;
    let turnStarted = false;
    let assistantItemId = null;
    let assistantText = "";
    let didCompleteAssistantItem = false;

    const ensureTurnStarted = () => {
      if (!turnStarted) {
        turnStarted = true;
        emit(JSON.stringify({
          method: "turn/started",
          params: { threadId, turnId, agentId: "claude-code" },
        }));
      }
    };
    const ensureAssistantItemId = (...candidates) => {
      if (assistantItemId) return assistantItemId;
      assistantItemId = firstNonEmptyString(candidates) || `claude-message-${turnId}`;
      return assistantItemId;
    };
    const emitAssistantDelta = (delta, ...itemIdCandidates) => {
      const normalizedDelta = typeof delta === "string" ? delta : "";
      if (!normalizedDelta) return;
      ensureTurnStarted();
      const itemId = ensureAssistantItemId(...itemIdCandidates);
      assistantText += normalizedDelta;
      emit(JSON.stringify({
        method: "item/agentMessage/delta",
        params: {
          threadId,
          turnId,
          itemId,
          agentId: "claude-code",
          delta: normalizedDelta,
        },
      }));
    };
    const emitAssistantCompleted = (text, ...itemIdCandidates) => {
      const normalizedText = normalizeString(text);
      if (!normalizedText) return;
      ensureTurnStarted();
      const itemId = ensureAssistantItemId(...itemIdCandidates);
      assistantText = normalizedText;
      didCompleteAssistantItem = true;
      emit(JSON.stringify({
        method: "item/completed",
        params: {
          threadId,
          turnId,
          itemId,
          agentId: "claude-code",
          item: {
            id: itemId,
            type: "agent_message",
            role: "assistant",
            text: normalizedText,
          },
        },
      }));
    };

    const q = queryImpl({ prompt, options: queryOptions });
    session.activeQuery = q;
    activeSessions.set(threadId, session);

    try {
      for await (const message of q) {
        if (message.type === "system" && message.subtype === "init") {
          capturedSessionId = message.session_id;
          const updatedEntry = {
            sessionId: capturedSessionId,
            cwd,
            agentId: "claude-code",
            model,
            permissionMode,
            createdAt: entry?.createdAt || new Date().toISOString(),
            title: entry?.title || null,
          };
          sessionStore.saveSessionEntry(threadId, updatedEntry);

          if (isFirstTurn) {
            emit(JSON.stringify({
              method: "thread/started",
              params: buildThreadStartedParams(threadId, updatedEntry),
            }));
          }
          continue;
        }

        if (message.type === "assistant") {
          const text = extractMessageText(message.message);
          emitAssistantCompleted(text, message.message?.id, message.uuid);
          continue;
        }

        if (message.type === "stream_event") {
          if (message.event?.type === "message_start") {
            ensureAssistantItemId(message.event?.message?.id, message.uuid);
            continue;
          }
          const delta = extractStreamEventTextDelta(message);
          if (delta) {
            emitAssistantDelta(delta, message.event?.message?.id, message.uuid);
          }
          continue;
        }

        if (message.type === "result") {
          if (!didCompleteAssistantItem) {
            emitAssistantCompleted(message.result || assistantText);
          }
          const isError = message.is_error || message.subtype !== "success";
          emit(JSON.stringify({
            method: "turn/completed",
            params: {
              threadId,
              turnId,
              agentId: "claude-code",
              result: message.subtype === "success" ? message.result : null,
              error: isError ? (message.errors?.[0] || message.subtype) : null,
              usage: message.usage || null,
              totalCostUsd: message.total_cost_usd || null,
              stopReason: message.stop_reason || null,
            },
          }));
          // Mirror token counts into the existing iOS context-window progress ring.
          if (message.usage) {
            const inputTokens = (message.usage.input_tokens || 0)
              + (message.usage.cache_read_input_tokens || 0)
              + (message.usage.cache_creation_input_tokens || 0);
            const outputTokens = message.usage.output_tokens || 0;
            emit(JSON.stringify({
              method: "thread/tokenUsage/updated",
              params: {
                threadId,
                usage: {
                  tokenCount: inputTokens + outputTokens,
                  inputTokens,
                  outputTokens,
                  totalCostUsd: message.total_cost_usd || null,
                },
              },
            }));
          }
          continue;
        }
      }
    } catch (err) {
      if (!isInterruptError(err)) {
        console.error(`${logPrefix} turn error (thread=${threadId}):`, err.message);
        emit(JSON.stringify({
          method: "turn/completed",
          params: {
            threadId,
            turnId,
            agentId: "claude-code",
            result: null,
            error: err.message || "Unexpected error during Claude turn.",
          },
        }));
      }
    } finally {
      if (session.activeQuery === q) {
        session.activeQuery = null;
      }
    }
  }

  // ─── turn/interrupt ──────────────────────────────────────────────────────────

  async function handleTurnInterrupt(params) {
    const threadId = normalizeString(params.threadId || params.thread_id);
    if (!threadId) return;
    const session = activeSessions.get(threadId);
    if (session?.activeQuery) {
      try {
        await session.activeQuery.interrupt();
      } catch {
        // Ignore interrupt errors — turn/completed will be emitted by the runner.
      }
    }
  }

  // ─── thread/list ─────────────────────────────────────────────────────────────

  async function handleThreadList(requestId, params) {
    const entries = sessionStore.listSessionEntries();
    const threads = [];

    for (const entry of entries) {
      if (!entry.sessionId) continue;
      let info = null;
      try {
        info = await getSessionInfo(entry.sessionId, { cwd: entry.cwd });
      } catch {
        // Session file may have been deleted; skip.
      }

      threads.push({
        id: entry.threadId,
        title: entry.title || info?.customTitle || info?.summary || "Claude thread",
        name: entry.title || info?.customTitle || null,
        preview: info?.summary || null,
        createdAt: entry.createdAt,
        updatedAt: info?.lastModified ? new Date(info.lastModified).toISOString() : entry.updatedAt,
        cwd: entry.cwd,
        agentId: "claude-code",
        agent_id: "claude-code",
        model: entry.model,
        modelProvider: "claude",
        model_provider: "claude",
      });
    }

    if (requestId != null) {
      emit(JSON.stringify({ id: requestId, result: { data: threads } }));
    }
  }

  // ─── thread/turns/list ────────────────────────────────────────────────────────

  async function handleThreadTurnsList(requestId, params) {
    const threadId = normalizeString(params.threadId || params.thread_id);
    if (!threadId) {
      if (requestId != null) emit(JSON.stringify({ id: requestId, result: { data: [] } }));
      return;
    }

    const entry = sessionStore.getSessionEntry(threadId);
    if (!entry?.sessionId) {
      if (requestId != null) emit(JSON.stringify({ id: requestId, result: { data: [] } }));
      return;
    }

    try {
      const messages = await getSessionMessages(entry.sessionId, { cwd: entry.cwd });
      const turns = adaptSessionMessagesToPaginatedTurns(messages, threadId);
      if (requestId != null) {
        emit(JSON.stringify({ id: requestId, result: { data: turns, hasMore: false } }));
      }
    } catch (err) {
      if (requestId != null) {
        emit(JSON.stringify({
          id: requestId,
          error: { code: -32000, message: err.message || "Failed to read thread history." },
        }));
      }
    }
  }

  // ─── thread/read ──────────────────────────────────────────────────────────────

  async function handleThreadRead(requestId, params) {
    const threadId = normalizeString(params.threadId || params.thread_id);
    if (!threadId) return;

    const entry = sessionStore.getSessionEntry(threadId);
    if (!entry?.sessionId) {
      if (requestId != null) emit(JSON.stringify({ id: requestId, result: null }));
      return;
    }

    try {
      const info = await getSessionInfo(entry.sessionId, { cwd: entry.cwd });
      const thread = {
        id: threadId,
        title: entry.title || info?.customTitle || info?.summary || "Claude thread",
        name: entry.title || info?.customTitle || null,
        cwd: entry.cwd,
        agentId: "claude-code",
        model: entry.model,
        modelProvider: "claude",
        createdAt: entry.createdAt,
        updatedAt: info?.lastModified ? new Date(info.lastModified).toISOString() : entry.updatedAt,
      };
      if (requestId != null) {
        emit(JSON.stringify({ id: requestId, result: thread }));
      }
    } catch (err) {
      if (requestId != null) {
        emit(JSON.stringify({
          id: requestId,
          error: { code: -32000, message: err.message || "Failed to read thread." },
        }));
      }
    }
  }

  // ─── thread/update (agent switching + field updates) ─────────────────────────

  async function handleThreadUpdate(requestId, params) {
    const threadId = normalizeString(params.threadId || params.thread_id);
    if (!threadId) return;

    const entry = sessionStore.getSessionEntry(threadId) || {};
    const updated = {
      ...entry,
      agentId: normalizeString(params.agentId) || entry.agentId || "claude-code",
      model: normalizeString(params.model) || entry.model || DEFAULT_MODEL,
      permissionMode: normalizeString(params.permissionMode) || entry.permissionMode || defaultPermissionMode,
      title: params.title !== undefined ? normalizeString(params.title) : entry.title,
    };
    sessionStore.saveSessionEntry(threadId, updated);

    if (requestId != null) {
      emit(JSON.stringify({ id: requestId, result: { ok: true } }));
    }
  }

  // ─── thread/rename ────────────────────────────────────────────────────────────

  async function handleThreadRename(requestId, params) {
    const threadId = normalizeString(params.threadId || params.thread_id);
    const name = normalizeString(params.name || params.title);
    if (!threadId || !name) return;

    const entry = sessionStore.getSessionEntry(threadId);
    if (entry) {
      sessionStore.saveSessionEntry(threadId, { ...entry, title: name });
      if (entry.sessionId) {
        try {
          await renameSession(entry.sessionId, name, { cwd: entry.cwd });
        } catch {
          // Best-effort — map already updated.
        }
      }
    }

    emit(JSON.stringify({
      method: "thread/name/updated",
      params: { threadId, thread_id: threadId, name, title: name },
    }));

    if (requestId != null) {
      emit(JSON.stringify({ id: requestId, result: { ok: true } }));
    }
  }

  // ─── approval/response (legacy notification path, kept for forward compat) ────

  function handleApprovalResponse(params) {
    const permissionId = normalizeString(params.permissionId);
    if (!permissionId) return;
    const approved = params.approved === true || params.approved === "true";
    resolvePermission(permissionId, approved ? { behavior: "allow" } : { behavior: "deny", message: "Denied by user." });
  }

  // ─── JSON-RPC response path (iOS sends sendResponse(id: permissionId, result: ...) ) ──

  function handleIncomingPermissionResponse(id, result) {
    // iOS encodes the decision as { "decision": "accept" | "decline" }
    const decision = typeof result?.decision === "string" ? result.decision.trim() : "";
    const approved = decision === "accept" || decision === "acceptForSession";
    resolvePermission(id, approved ? { behavior: "allow" } : { behavior: "deny", message: "Denied by user." });
  }

  function resolvePermission(permissionId, resolution) {
    const pending = pendingPermissions.get(permissionId);
    if (!pending) return;
    clearTimeout(pending.timer);
    pendingPermissions.delete(permissionId);
    pending.resolve(resolution);
  }

  // ─── Permission request (canUseTool callback) ─────────────────────────────────
  // Emits as a server-initiated RPC using the existing iOS-compatible method so no iOS
  // approval UI changes are needed. The bridge uses permissionId as the JSON-RPC id.

  function handlePermissionRequest(threadId, toolName, input, signal) {
    return new Promise((resolve) => {
      const permissionId = randomUUID();

      const timer = setTimeout(() => {
        if (!pendingPermissions.has(permissionId)) return;
        pendingPermissions.delete(permissionId);
        resolve({ behavior: "deny", message: "Auto-denied: no response within timeout." });
        emit(JSON.stringify({
          method: "approval/timeout",
          params: { permissionId, threadId, toolName, timeoutSecs: permissionTimeoutMs / 1000 },
        }));
      }, permissionTimeoutMs);

      pendingPermissions.set(permissionId, { resolve, timer });

      // Use the iOS-compatible method name so the existing approval card shows up.
      emit(JSON.stringify({
        id: permissionId,
        method: "item/commandExecution/requestApproval",
        params: {
          permissionId,
          threadId,
          thread_id: threadId,
          command: sanitizeToolInput(toolName, input) || toolName,
          tool: toolName,
          agentId: "claude-code",
          autoDecideSecs: permissionTimeoutMs / 1000,
        },
      }));

      signal?.addEventListener("abort", () => {
        resolvePermission(permissionId, { behavior: "deny", message: "Turn interrupted." });
      }, { once: true });
    });
  }

  // ─── Warm process lifecycle ──────────────────────────────────────────────────

  function warmSubprocess(threadId, cwd, model, permissionMode) {
    const session = activeSessions.get(threadId) || {};
    if (session.warmQuery) return; // Already warm.

    try {
      const warm = startup({
        options: { cwd, model, permissionMode },
      });
      session.warmQuery = warm;
      activeSessions.set(threadId, session);
    } catch {
      // Warm startup is best-effort; cold start still works.
    }
  }

  function resetIdleTimer(threadId, session) {
    if (session.idleTimer) {
      clearTimeout(session.idleTimer);
    }
    session.idleTimer = setTimeout(() => {
      const s = activeSessions.get(threadId);
      if (s) {
        if (s.warmQuery) {
          try { s.warmQuery.close?.(); } catch {}
          s.warmQuery = null;
        }
        s.idleTimer = null;
      }
    }, warmIdleTimeoutMs);
    session.idleTimer.unref?.();
  }

  function cleanupSession(threadId, session) {
    if (session.idleTimer) clearTimeout(session.idleTimer);
    if (session.warmQuery) {
      try { session.warmQuery.close?.(); } catch {}
    }
    if (session.activeQuery) {
      try { session.activeQuery.interrupt?.(); } catch {}
    }
  }

  // ─── Helpers ─────────────────────────────────────────────────────────────────

  function emit(rawMessage) {
    listeners.emitMessage(rawMessage);
  }

  function buildThreadObject(threadId, entry) {
    return {
      id: threadId,
      title: entry.title || null,
      agentId: "claude-code",
      agent_id: "claude-code",
      model: entry.model,
      modelProvider: "claude",
      model_provider: "claude",
      cwd: entry.cwd,
      createdAt: entry.createdAt,
      updatedAt: entry.updatedAt || entry.createdAt,
    };
  }

  function buildThreadStartedParams(threadId, entry) {
    const threadObj = buildThreadObject(threadId, entry);
    return {
      threadId,
      thread_id: threadId,
      thread: threadObj,  // iOS handleThreadStarted expects params["thread"]
      ...threadObj,       // also spread flat for any other consumers
    };
  }

  function extractStreamEventTextDelta(message) {
    const event = message.event;
    if (!event) return null;
    if (event.type === "content_block_delta" && event.delta?.type === "text_delta") {
      return event.delta.text;
    }
    return null;
  }

  function adaptSessionMessagesToPaginatedTurns(messages, threadId) {
    // Pair user + assistant messages into turn-like objects for the phone's history view.
    const turns = [];
    let i = 0;
    while (i < messages.length) {
      const msg = messages[i];
      if (msg.type === "user") {
        const next = messages[i + 1];
        const userContent = extractMessageText(msg.message);
        const assistantContent = next?.type === "assistant" ? extractMessageText(next.message) : null;
        turns.push({
          id: msg.uuid || randomUUID(),
          threadId,
          userMessage: userContent,
          assistantMessage: assistantContent,
          createdAt: msg.timestamp || null,
          agentId: "claude-code",
        });
        i += next?.type === "assistant" ? 2 : 1;
      } else {
        i += 1;
      }
    }
    return turns;
  }

  function extractMessageText(message) {
    if (!message) return null;
    if (typeof message.content === "string") return message.content;
    if (Array.isArray(message.content)) {
      return message.content.filter((b) => b.type === "text").map((b) => b.text).join("") || null;
    }
    return null;
  }

  function sanitizeToolInput(toolName, input) {
    // Surface just enough for the approval UI without leaking potentially sensitive data.
    if (!input || typeof input !== "object") return null;
    if (toolName === "Bash") return input.command || null;
    if (toolName === "Edit" || toolName === "Write" || toolName === "Read") return input.file_path || null;
    return null;
  }

  function isInterruptError(err) {
    const msg = String(err?.message || "").toLowerCase();
    return msg.includes("interrupt") || msg.includes("aborted") || msg.includes("cancel");
  }
}

// Ensures the model is a valid Claude model — ignores Codex/OpenAI models sent by the phone.
function resolveClaudeModel(value) {
  const s = typeof value === "string" ? value.trim() : "";
  return s.startsWith("claude-") ? s : DEFAULT_MODEL;
}

function clampPermissionTimeout(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return DEFAULT_PERMISSION_TIMEOUT_SECS;
  return Math.max(MIN_PERMISSION_TIMEOUT_SECS, Math.min(MAX_PERMISSION_TIMEOUT_SECS, n));
}

function normalizeString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function firstNonEmptyString(values) {
  for (const value of values) {
    const normalized = normalizeString(value);
    if (normalized) return normalized;
  }
  return null;
}

// Extracts concatenated text from the iOS `input` array format:
// [{ type: "text", text: "..." }, { type: "image", ... }, ...]
function extractTextFromInputItems(input) {
  if (!Array.isArray(input)) return null;
  const text = input
    .filter((item) => item?.type === "text" && typeof item.text === "string")
    .map((item) => item.text)
    .join("\n")
    .trim();
  return text || null;
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

module.exports = { createClaudeCodeTransport };
