// FILE: agent-router.js
// Purpose: Routes incoming RPC messages to the correct agent transport (Codex or Claude Code)
//   based on agentId in the message params or the saved session map. Presents the same
//   5-method interface as codex-transport.js so bridge.js needs only minimal changes.
//   Also provides runDirectTurn() for internal bridge orchestration without JSON-RPC round-trips.
// Layer: CLI service
// Exports: createAgentRouter
// Depends on: ./codex-transport, ./claude-code-transport, ./claude-code-session-map, crypto

const { randomUUID } = require("crypto");
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
  "thread/fork",
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
  "thread/fork",
]);

function createAgentRouter({
  config = {},
  sessionMap: _unused,
  codexTransport: injectedCodexTransport = null,
  claudeTransport: injectedClaudeTransport = null,
} = {}) {
  const listeners = createListenerBag();
  const modelListWaiters = new Map();
  const directTurnWaiters = new Set();
  const directRpcResponseWaiters = new Map();

  // Always create the Codex transport — it handles all existing behavior.
  const codexTransport = injectedCodexTransport || createCodexTransport({
    endpoint: config.codexEndpoint,
    env: process.env,
    appPath: config.codexAppPath,
  });

  // Only create the Claude Code transport when the feature flag is on.
  const claudeEnabled = config.claudeCodeEnabled === true;
  const claudeTransport = claudeEnabled
    ? (injectedClaudeTransport || createClaudeCodeTransport({ config }))
    : null;

  // Wire both transports' outbound messages into one stable fan-out. Temporary
  // model-list/direct-turn waiters observe messages here without replacing the
  // transport-level listener, so concurrent runs cannot clobber each other.
  codexTransport.onMessage((msg) => dispatchTransportMessage("codex", msg));
  codexTransport.onClose((...args) => listeners.emitClose(...args));
  codexTransport.onError((err) => listeners.emitError(err));
  codexTransport.onStarted((info) => listeners.emitStarted(info));

  if (claudeTransport) {
    claudeTransport.onMessage((msg) => dispatchTransportMessage("claude-code", msg));
    // Claude transport errors are non-fatal to the bridge (Codex still runs).
    claudeTransport.onError((err) => {
      console.error("[remodex:router] Claude transport error:", err.message);
    });
  }

  function dispatchTransportMessage(transportName, rawMsg) {
    if (transportName === "codex" && resolveModelListWaiter(rawMsg)) {
      return;
    }
    if (resolveDirectRpcResponseWaiter(transportName, rawMsg)) {
      return;
    }

    listeners.emitMessage(rawMsg);

    for (const waiter of Array.from(directTurnWaiters)) {
      if (waiter.transportName === transportName) {
        waiter.handle(rawMsg);
      }
    }
  }

  function resolveDirectRpcResponseWaiter(transportName, rawMsg) {
    let parsed;
    try { parsed = JSON.parse(rawMsg); } catch { return false; }
    if (parsed?.method || parsed?.id == null) return false;

    const waiter = directRpcResponseWaiters.get(String(parsed.id));
    if (!waiter || waiter.transportName !== transportName) return false;

    directRpcResponseWaiters.delete(String(parsed.id));
    if (waiter.timeout) clearTimeout(waiter.timeout);

    if (parsed.error) {
      const error = new Error(parsed.error.message || "Direct Codex request failed");
      error.code = parsed.error.code;
      error.data = parsed.error.data;
      waiter.reject(error);
    } else {
      waiter.resolve(parsed.result ?? parsed.payload ?? null);
    }
    return true;
  }

  function sendDirectRpcRequest(transportName, transport, method, params, timeoutMs = 20_000) {
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        directRpcResponseWaiters.delete(requestId);
        reject(new Error(`Direct ${transportName} request timed out: ${method}`));
      }, timeoutMs);
      timeout.unref?.();

      directRpcResponseWaiters.set(requestId, {
        transportName,
        resolve,
        reject,
        timeout,
      });

      try {
        transport.send(JSON.stringify({ id: requestId, method, params }));
      } catch (error) {
        clearTimeout(timeout);
        directRpcResponseWaiters.delete(requestId);
        reject(error);
      }
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

    modelListWaiters.set(syntheticId, { requestId });
    const restoreTimer = setTimeout(() => {
      modelListWaiters.delete(syntheticId);
    }, 10_000);
    restoreTimer.unref?.();

    codexTransport.send(syntheticRequest);
  }

  function resolveModelListWaiter(rawMsg) {
    let p;
    try { p = JSON.parse(rawMsg); } catch { return false; }
    const waiter = modelListWaiters.get(String(p?.id));
    if (!waiter) return false;

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

    modelListWaiters.delete(String(p.id));
    listeners.emitMessage(JSON.stringify({ id: waiter.requestId, result: merged }));
    return true;
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

    /**
     * Dispatches a synthetic thread/start + turn/start to the appropriate transport
     * and waits for the turn to complete, returning { result, threadId }.
     *
     * @param {{ agentId: string, threadId: string, prompt: string, cwd: string, model: string, parentThreadId: string }} opts
     * @returns {Promise<{ result: string, threadId: string }>}
     */
    runDirectTurn({ agentId, threadId, prompt, cwd, model, parentThreadId, role, title }) {
      return new Promise((resolve, reject) => {
        const transport =
          agentId === AGENT_CLAUDE && claudeTransport ? claudeTransport : codexTransport;
        const transportName =
          agentId === AGENT_CLAUDE && claudeTransport ? AGENT_CLAUDE : AGENT_CODEX;

        // Mirrors the iOS thread/start + turn/start parameters: codex requires
        // sandboxPolicy + approvalPolicy on both calls. Orchestration runs
        // without a human reviewer, so we hard-set full-access + never.
        const codexUnattendedOverrides = {
          sandboxPolicy: { type: "dangerFullAccess" },
          approvalPolicy: "never",
        };

        let resolvedThreadId = threadId;
        let accumulatedText = "";
        let completedAssistantText = "";
        let settled = false;
        let timeout = null;

        function settle(err, value) {
          if (settled) return;
          settled = true;
          if (timeout) clearTimeout(timeout);
          directTurnWaiters.delete(waiter);
          if (err) reject(err);
          else resolve(value);
        }

        const waiter = {
          transportName,
          handle(rawMsg) {
            if (settled) return;
            let parsed;
            try { parsed = JSON.parse(rawMsg); } catch { return; }

            const method = parsed?.method;
            const params = parsed?.params || {};
            const matchesThread =
              params.threadId === resolvedThreadId ||
              params.thread_id === resolvedThreadId;

            // Surface fatal codex error notifications scoped to our thread.
            if (method === "error" && matchesThread) {
              const errMsg = params.error?.message || params.message || "codex error";
              console.error(`[remodex:orch] codex error notification: ${errMsg}`);
              settle(new Error(`codex error: ${errMsg}`));
              return;
            }

            // Accumulate streaming agent message deltas.
            if (
              (method === "item/agentMessage/delta" || method === "turn/delta") &&
              matchesThread
            ) {
              const delta = params.delta ?? params.text ?? params.content ?? "";
              if (typeof delta === "string") accumulatedText += delta;
              return;
            }

            // Capture the final assistant text on item/completed.
            if (
              method === "item/completed" &&
              matchesThread &&
              (params.item?.type === "agentMessage" || params.item?.type === "agent_message")
            ) {
              const text = params.item.text ?? params.item.content ?? "";
              if (typeof text === "string" && text.length > 0) completedAssistantText = text;
              return;
            }

            // turn/completed: fail loudly if the turn failed instead of returning empty.
            if (method === "turn/completed" && matchesThread) {
              const status = params.turn?.status || params.status;
              if (status === "failed") {
                const errMsg =
                  params.turn?.error?.message ||
                  params.error?.message ||
                  params.error ||
                  "turn failed";
                console.error(`[remodex:orch] codex turn/completed status=failed: ${errMsg}`);
                settle(new Error(`codex turn failed: ${errMsg}`));
                return;
              }
              const result = completedAssistantText || accumulatedText || "";
              console.error(`[remodex:orch] codex turn/completed OK thread=${resolvedThreadId} resultBytes=${result.length}`);
              settle(null, { result, threadId: resolvedThreadId });
              return;
            }
          },
        };
        directTurnWaiters.add(waiter);

        startDirectTurn().catch((error) => settle(error));

        async function startDirectTurn() {
          if (transportName === AGENT_CODEX) {
            console.error(`[remodex:orch] codex thread/start model=${model} cwd=${cwd} role=${role || "(none)"}`);
            try {
              const threadStartResult = await sendDirectRpcRequest(
                transportName,
                transport,
                "thread/start",
                {
                  cwd,
                  model,
                  ...codexUnattendedOverrides,
                }
              );
              resolvedThreadId = readThreadIdFromThreadStartResult(threadStartResult) || threadId;
              console.error(`[remodex:orch] codex thread/start OK thread=${resolvedThreadId}`);
            } catch (err) {
              console.error(`[remodex:orch] codex thread/start FAILED: ${err?.message || err}`);
              throw err;
            }

            console.error(`[remodex:orch] codex turn/start thread=${resolvedThreadId} promptBytes=${prompt.length}`);
            try {
              await sendDirectRpcRequest(transportName, transport, "turn/start", {
                threadId: resolvedThreadId,
                input: [{ type: "text", text: prompt }],
                ...codexUnattendedOverrides,
              });
              console.error(`[remodex:orch] codex turn/start ACK thread=${resolvedThreadId}`);
            } catch (err) {
              console.error(`[remodex:orch] codex turn/start FAILED: ${err?.message || err}`);
              throw err;
            }
          } else {
            transport.send(JSON.stringify({
              id: randomUUID(),
              method: "thread/start",
              params: {
                threadId,
                agentId,
                cwd,
                model,
                title: title || role || null,
                agentRole: role || null,
                agent_role: role || null,
                parentThreadId: parentThreadId || null,
                parent_thread_id: parentThreadId || null,
              },
            }));
            transport.send(JSON.stringify({
              id: randomUUID(),
              method: "turn/start",
              params: {
                threadId: resolvedThreadId,
                agentId,
                model,
                prompt,
                messages: [{ role: "user", content: prompt }],
              },
            }));
          }

          // Safety timeout: reject after 10 minutes to avoid leaked promises.
          timeout = setTimeout(() => {
            settle(new Error(`runDirectTurn timed out for threadId=${resolvedThreadId}`));
          }, 10 * 60 * 1000);
          timeout.unref?.();
        }
      });
    },

    shutdown() {
      codexTransport.shutdown?.();
      claudeTransport?.shutdown?.();
    },
  };
}

function readThreadIdFromThreadStartResult(result) {
  const candidates = [
    result?.thread?.id,
    result?.thread?.threadId,
    result?.thread?.thread_id,
    result?.id,
    result?.threadId,
    result?.thread_id,
  ];
  return candidates.find((value) => typeof value === "string" && value.trim()) || "";
}

// ─── model/list merge ─────────────────────────────────────────────────────────

const CLAUDE_REASONING_EFFORTS = [
  { reasoningEffort: "low", description: "Minimal thinking, fastest responses." },
  { reasoningEffort: "medium", description: "Moderate thinking." },
  { reasoningEffort: "high", description: "Deep reasoning." },
];

const CLAUDE_EXTENDED_REASONING_EFFORTS = [
  ...CLAUDE_REASONING_EFFORTS,
  { reasoningEffort: "xhigh", description: "Deeper than high." },
  { reasoningEffort: "max", description: "Maximum effort." },
];

const CLAUDE_SONNET_REASONING_EFFORTS = [
  ...CLAUDE_REASONING_EFFORTS,
  { reasoningEffort: "max", description: "Maximum effort." },
];

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
    supportsEffort: true,
    supportedReasoningEfforts: CLAUDE_EXTENDED_REASONING_EFFORTS,
    supported_reasoning_efforts: CLAUDE_EXTENDED_REASONING_EFFORTS,
    defaultReasoningEffort: "high",
    default_reasoning_effort: "high",
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
    supportsEffort: true,
    supportedReasoningEfforts: CLAUDE_SONNET_REASONING_EFFORTS,
    supported_reasoning_efforts: CLAUDE_SONNET_REASONING_EFFORTS,
    defaultReasoningEffort: "high",
    default_reasoning_effort: "high",
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
    supportsEffort: true,
    supportedReasoningEfforts: CLAUDE_REASONING_EFFORTS,
    supported_reasoning_efforts: CLAUDE_REASONING_EFFORTS,
    defaultReasoningEffort: "medium",
    default_reasoning_effort: "medium",
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
