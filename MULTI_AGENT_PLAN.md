# Multi-Agent Remodex — Implementation Spec

> All design decisions are locked. This document is the source of truth for implementation order and scope.

---

## Locked decisions

| # | Decision |
|---|----------|
| 1 | Threads are switchable — `agentId` can be changed on an existing thread |
| 2 | Claude auth via Claude.ai OAuth (subscription), same pattern as existing OpenAI pairing |
| 3 | Orchestration is bridge-autonomous — phone defines the chain once, bridge runs all steps |
| 4 | Desktop handoff opens a unified session browser (both Codex + Claude sessions) |
| 5 | Warm process: starts on first use, shuts down after 5 min idle |
| 6 | Default permission mode: `acceptEdits`; `bypassPermissions` available per-thread in Settings |
| 7 | Agent called "Claude" in UI (never "Claude Code"), sub-labeled by model name |
| 8 | Permission timeout is user-configurable (10 / 30 / 60 / 120 s, default 30 s) |

---

## How Remodex works today (the baseline)

```
[iPhone] ←──WebSocket──→ [Local Relay] ←──WebSocket──→ [bridge.js] ←──stdin/stdout──→ [codex app-server]
```

- **Relay** (`relay/relay.js`): dumb forwarder. Knows nothing about agents. **No changes ever.**
- **Bridge** (`phodex-bridge/src/bridge.js`): the intelligence. Runs as a Node.js process (`npm start`). Owns the relay connection, owns the Codex subprocess, intercepts certain RPC methods, forwards the rest.
- **Codex transport** (`codex-transport.js`): spawns `codex app-server` and wraps it in a 5-method interface: `send`, `onMessage`, `onClose`, `onError`, `onStarted`. **This interface is the contract we'll match.**
- **iOS app**: sends and receives JSON-RPC messages. Already has `agentId`, `modelProvider`, `parentThreadId`, `isSubagent` on every thread model. No structural Swift changes needed for Phase 1–2.

---

## New files to create (all inside `phodex-bridge/src/`)

### `claude-code-session-map.js`

Persists the mapping between Remodex thread IDs and Claude Code session UUIDs.

**Storage**: `~/.remodex/claude-sessions.json`

**Schema**:
```json
{
  "<remodex-thread-id>": {
    "sessionId": "<claude-uuid>",
    "cwd": "/absolute/path/to/project",
    "agentId": "claude-code",
    "model": "claude-sonnet-4-6",
    "permissionMode": "acceptEdits",
    "createdAt": "2026-05-18T00:00:00.000Z",
    "updatedAt": "2026-05-18T00:00:00.000Z",
    "title": "optional thread title"
  }
}
```

**Exports**:
```javascript
loadSessionMap()           // returns the full map object, or {}
saveSessionEntry(threadId, entry)  // upserts one entry, writes file
deleteSessionEntry(threadId)       // removes entry, writes file
getSessionEntry(threadId)          // returns one entry or null
listSessionEntries()               // returns array of { threadId, ...entry }
```

---

### `claude-code-transport.js`

The main new file. Implements the same 5-method interface as `codex-transport.js` but drives the Agent SDK instead of `codex app-server`.

**Install first**: `npm install @anthropic-ai/claude-agent-sdk` in `phodex-bridge/`.

**Internal state**:
```javascript
// One entry per active Claude Code thread
const activeSessions = new Map();
// activeSessions.get(threadId) = {
//   sessionId: string,
//   activeQuery: Query | null,     // the live async generator
//   idleTimer: NodeJS.Timeout | null,
//   warmProcess: WarmQuery | null,
// }

// Pending permission approvals waiting for phone response
const pendingPermissions = new Map();
// pendingPermissions.get(permissionId) = {
//   resolve: (PermissionResult) => void,
//   timer: NodeJS.Timeout,
// }
```

**Exports**:
```javascript
createClaudeCodeTransport({ config, sessionMap })
// Returns: { send, onMessage, onClose, onError, onStarted, shutdown }
```

**`send(rawMessage)` dispatch table**:

| Incoming RPC method | Action |
|---------------------|--------|
| `thread/start` | Call `startup()` to warm the process, then begin `query()`. Emit `thread/started`. |
| `turn/start` | If session warm: resume via `query({ resume: sessionId })`. If cold: cold-start. Stream all events back. |
| `turn/interrupt` | Call `activeQuery.interrupt()`. Emit `turn/completed` with interrupt flag. |
| `thread/list` | Call `listSessions({ cwd })` + merge with `sessionMap`. Return synthesized thread list. |
| `thread/turns/list` | Call `getSessionMessages(sessionId)`. Adapt to existing pagination shape. |
| `thread/read` | Call `getSessionInfo(sessionId)`. Return thread metadata. |
| `thread/update` | Update `sessionMap` entry (used for agent switching). |
| `approval/response` | Resolve the pending permission in `pendingPermissions`. |

**Streaming event mapping** (Claude SDK → synthesized RPC pushed to phone):

| SDK message | Synthesized RPC `method` | Notes |
|-------------|--------------------------|-------|
| `system.init` | `thread/started` | Include `agentId: "claude-code"`, `model`, `sessionId` as `threadId` |
| First `assistant` message | `turn/started` | Generate a stable `turnId` |
| `assistant` content | `turn/delta` | Forward text blocks and tool_use blocks |
| `stream_event` | `turn/delta` | When `includePartialMessages: true` |
| `result` (success) | `turn/completed` | Include `usage`, `total_cost_usd`, `stop_reason` |
| `result` (error) | `turn/completed` | Include `error` field |
| `system.permission_denied` | `approval/request` | See permission flow below |

**Permission flow** (end-to-end):

```
1. Agent SDK fires canUseTool(toolName, input, { signal }) callback
2. Bridge generates permissionId = randomUUID()
3. Stores { resolve, timer } in pendingPermissions
4. Emits to phone:
     { method: "approval/request", params: {
         permissionId,
         threadId,
         tool: toolName,
         input,           // sanitized — no secrets
         autoDecideSecs: config.permissionTimeoutSecs
     }}
5. Starts timer for config.permissionTimeoutSecs
6a. Phone sends approval/response { permissionId, approved: true }
    → resolve({ behavior: "allow" })
    → clear timer
6b. Timer fires first
    → resolve({ behavior: "deny", message: "Auto-denied: no response" })
    → emit to phone: { method: "approval/timeout", params: { permissionId } }
```

**Warm process lifecycle**:

```
turn/start received for a Claude Code thread:
  → if warmProcess exists: reuse it for query()
  → if no warmProcess: call startup() to pre-warm, then query()
  → reset idleTimer to config.warmIdleTimeoutSecs (default 300s)

idleTimer fires:
  → warmProcess.close()
  → warmProcess = null
  → idleTimer = null

shutdown() called (bridge exit):
  → interrupt all activeQuery instances
  → close all warmProcess instances
```

---

### `agent-router.js`

Routes incoming messages to the right transport. Replaces the direct `createCodexTransport()` call in `bridge.js`.

**Exports**:
```javascript
createAgentRouter({ config, sessionMap })
// Returns the same 5-method interface: { send, onMessage, onClose, onError, onStarted, shutdown }
```

**Routing logic inside `send(rawMessage)`**:

```javascript
function resolveAgentId(parsed, sessionMap) {
  // 1. Explicit agentId in params
  if (parsed?.params?.agentId) return parsed.params.agentId;
  // 2. Look up existing thread
  const threadId = extractThreadId(parsed);
  if (threadId) {
    const entry = sessionMap.getSessionEntry(threadId);
    if (entry) return entry.agentId;
  }
  // 3. Default: Codex (backward compatible)
  return "codex";
}
```

- `agentId === "codex"` → `codexTransport.send(rawMessage)`
- `agentId === "claude-code"` → `claudeCodeTransport.send(rawMessage)`
- Unknown agentId → log warning, route to Codex

**Thread mutation** (when phone sends `thread/update { threadId, agentId: "claude-code" }`):
- Router updates `sessionMap` entry.
- Future messages for that `threadId` route to the new transport.
- Past history stays in the old transport (phone fetches it per-turn, not live).

**Unified `onMessage`**: messages from both transports funnel through the same `listeners.emitMessage()` so `bridge.js` sees one stream.

---

### `orchestration-handler.js` *(Phase 4)*

Handles `orchestration/start` RPC. Runs a chain of agent steps autonomously.

```javascript
// Incoming RPC shape:
{
  method: "orchestration/start",
  params: {
    steps: [
      { agentId: "claude-code", model: "claude-opus-4-7", role: "planner",     prompt: "..." },
      { agentId: "codex",       model: "gpt-5",           role: "implementer"               },
      { agentId: "claude-code", model: "claude-sonnet-4-6", role: "reviewer"                }
    ],
    cwd: "/path/to/project",
    parentThreadId: "<optional existing thread to post progress to>"
  }
}
```

Internal flow:
1. Create a parent thread (or use `parentThreadId`). Emit `thread/started` with `agentId: "orchestration"`.
2. For each step:
   a. Run the step's agent via `agentRouter.send(turn/start { ... })`.
   b. Collect the `turn/completed` result.
   c. Prepend result as context into the next step's first message.
   d. Emit progress: `{ method: "orchestration/step/completed", params: { stepIndex, role, threadId } }`.
3. On full completion: emit `orchestration/completed`.
4. All child threads have `parentThreadId` set so iOS sidebar groups them.

---

## Existing files to modify

### `phodex-bridge/src/bridge.js` — minimal changes only

**Change 1** — import:
```javascript
// Remove:
const { createCodexTransport } = require("./codex-transport");
// Add:
const { createAgentRouter } = require("./agent-router");
const { loadSessionMap } = require("./claude-code-session-map");
```

**Change 2** — instantiation (one line):
```javascript
// Remove:
const codex = createCodexTransport({ endpoint: config.codexEndpoint, env: process.env, appPath: config.codexAppPath });
// Add:
const sessionMap = loadSessionMap();
const codex = createAgentRouter({ config, sessionMap });
```

**Change 3** — `handleApplicationMessage`: add one handler at the top for orchestration (Phase 4):
```javascript
if (handleOrchestrationRequest(rawMessage, sendApplicationResponse)) return;
```

Everything else in `bridge.js` — relay reconnect, secure transport, desktop/git/workspace handlers, push notifications — is **untouched**.

---

### `phodex-bridge/src/codex-desktop-refresher.js` — new config fields only

Add to `readBridgeConfig()` return value:
```javascript
claudeCodeEnabled: readOptionalBooleanEnv(["REMODEX_CLAUDE_CODE_ENABLED"], env) ?? false,
permissionTimeoutSecs: parseIntegerEnv(
  readFirstDefinedEnv(["REMODEX_PERMISSION_TIMEOUT_SECS"], "30", env), 30
),
warmIdleTimeoutSecs: parseIntegerEnv(
  readFirstDefinedEnv(["REMODEX_WARM_IDLE_TIMEOUT_SECS"], "300", env), 300
),
claudeCodeDefaultPermissionMode: readFirstDefinedEnv(
  ["REMODEX_DEFAULT_PERMISSION_MODE"], "acceptEdits", env
),
```

Valid values for `REMODEX_PERMISSION_TIMEOUT_SECS`: 10, 30, 60, 120. Bridge clamps to this range.

---

### `phodex-bridge/src/account-status.js` — composite auth status

Extend `composeSanitizedAuthStatusFromSettledResults` (or add a parallel function) to include Claude auth status:

```javascript
// New field in the result sent to phone:
{
  openai: { authenticated: bool, email: string | null },
  claude: { authenticated: bool, email: string | null },  // NEW
  bridge: { ... }
}
```

Getting Claude auth status: call `accountInfo()` on a pre-warmed Query object, or read `~/.claude/` auth state directly. If the user isn't logged in, include a `loginRequired: true` flag.

---

### iOS — `CodexService.swift` / `CodexService+Incoming.swift`

**Phase 1**: no changes. Existing `agentDisplayLabel` and thread badges work automatically once the bridge sets `agentId: "claude-code"` on threads.

**Phase 2** additions:
- Handle `approval/request` with new `permissionId` field (existing `CodexApprovalRequest` struct gets one new optional field).
- Send `approval/response { permissionId, approved }` back.
- Handle `approval/timeout` notification (show a brief toast).

---

### iOS — Settings UI *(Phase 2)*

**File**: `SettingsView.swift` (or a new `SettingsClaudeDefaultsCard.swift`)

New card: **Claude defaults**
- Model picker (populated from `model/list` where `modelProvider == "claude"`)
- Permission mode: segmented control (`acceptEdits` / `bypassPermissions`)
- Permission timeout: segmented control (10s / 30s / 60s / 120s) — sends `desktop/preferences/update` with the new values

---

### iOS — New thread flow *(Phase 2)*

**File**: `SidebarNewChatButton.swift` or `SidebarNewChatProjectPickerSheet.swift`

Add an agent picker step before project selection:
- "Codex" (default, existing behavior)
- "Claude" (new)

Selected `agentId` is included in the `thread/start` params. No other changes to the thread creation flow.

---

### iOS — Thread settings *(Phase 2, thread mutation)*

**File**: `SettingsView.swift` or a new per-thread settings sheet

Add an "Agent" row that shows the current `agentId` and allows switching. On change, the phone sends:
```json
{ "method": "thread/update", "params": { "threadId": "...", "agentId": "claude-code" } }
```

---

## `thread/list` merge logic (in `claude-code-transport.js`)

When phone calls `thread/list`:
1. Agent router sends it to Codex transport → gets Codex threads as usual.
2. Agent router also calls `claudeCodeTransport.handleThreadList()`:
   - Reads `sessionMap.listSessionEntries()`
   - Optionally calls `listSessions({ cwd })` to pick up orphaned sessions not in the map
   - Maps each entry to `CodexThread`-compatible shape:
     ```javascript
     {
       id: entry.threadId,
       title: entry.title || session.summary,
       createdAt: entry.createdAt,
       updatedAt: entry.updatedAt,
       agentId: "claude-code",
       model: entry.model,
       modelProvider: "claude",
       cwd: entry.cwd,
     }
     ```
3. Router merges the two arrays and returns a single `thread/list` response to the phone.

---

## `model/list` extension (in `claude-code-transport.js`)

When phone calls `model/list`:
- Codex handles it as normal → returns OpenAI models.
- Claude Code transport appends Claude models:
  ```javascript
  [
    { id: "claude-opus-4-7",    model: "claude-opus-4-7",    displayName: "Claude Opus",   modelProvider: "claude", isDefault: false },
    { id: "claude-sonnet-4-6",  model: "claude-sonnet-4-6",  displayName: "Claude Sonnet", modelProvider: "claude", isDefault: true  },
    { id: "claude-haiku-4-5",   model: "claude-haiku-4-5-20251001", displayName: "Claude Haiku",  modelProvider: "claude", isDefault: false },
  ]
  ```
- Combined list returned to phone. iOS already renders `modelProvider` as a badge.

---

## Claude auth flow (Phase 2)

Claude Code stores auth at `~/.claude/`. The Agent SDK picks it up automatically when the process starts — no env var needed if the user ran `claude auth login` once.

**Bridge-side**:
1. On `account/status/read`: check Claude auth by calling `accountInfo()` on a warm Query, or reading `~/.claude/auth.json` directly.
2. If not authenticated: include `claude: { authenticated: false, loginRequired: true }` in the status response.
3. New RPC `claude/login/start`: bridge spawns `claude auth login` in a subprocess that opens the browser on Mac. Returns `{ ok: true }`.
4. New RPC `claude/login/status`: polls auth state, returns `{ authenticated: bool }`.
5. Phone polls `claude/login/status` every 3s until `authenticated: true`.

No phone-side token handling — auth lives entirely on the Mac, same as Codex OAuth.

---

## Desktop handoff (Phase 3)

`desktop/continueOnDesktop` currently deep-links `codex://threads/<id>` to Codex.app.

New behavior for Phase 3:
- Detect `agentId` of the thread.
- If `"codex"`: existing behavior unchanged.
- If `"claude-code"`: open a local HTML session browser (served by the bridge on `localhost:PORT`) that lists both Codex and Claude sessions side-by-side, clickable to open in terminal/editor.
- The session browser is a minimal static HTML file the bridge serves — no framework needed.

---

## Phase-by-phase build order

### Phase 1 — Bridge: Claude Code transport *(no iOS changes)*

Deliverable: phone can start a Claude Code thread and have a conversation. No picker; test by sending `agentId: "claude-code"` in thread/start from a test script.

Checklist:
- [ ] `npm install @anthropic-ai/claude-agent-sdk` in `phodex-bridge/`
- [ ] Create `claude-code-session-map.js` (load/save/get/list/delete)
- [ ] Create `claude-code-transport.js`:
  - [ ] `thread/start` → `query()` → emit `thread/started`
  - [ ] `turn/start` → `query({ resume })` → stream deltas → emit `turn/completed`
  - [ ] `turn/interrupt` → `activeQuery.interrupt()`
  - [ ] `thread/list` → `listSessions()` merge
  - [ ] `thread/turns/list` → `getSessionMessages()` adapted
  - [ ] `thread/read` → `getSessionInfo()`
  - [ ] Permission prompt flow with configurable timeout
  - [ ] Warm process: startup on first use, idle shutdown
- [ ] Create `agent-router.js` (routes by `agentId`, unified emitters)
- [ ] Modify `bridge.js` (3 surgical changes — see above)
- [ ] Modify `codex-desktop-refresher.js` (4 new config fields)
- [ ] Add `REMODEX_CLAUDE_CODE_ENABLED=1` guard — if not set, router only creates Codex transport (zero behavior change for existing users)

### Phase 2 — Full phone UI + auth + parity

Deliverable: user can create Claude threads from the phone picker; Claude auth works; settings card is live.

Checklist:
- [ ] `model/list` extended with Claude models
- [ ] Claude auth flow (`claude/login/start`, `claude/login/status`)
- [ ] `account/status/read` returns composite Claude + OpenAI status
- [ ] Token/usage forwarding (`thread/tokenUsage/updated` from result message)
- [ ] `approval/request` shape updated with `permissionId` (backward compat: optional field)
- [ ] `approval/timeout` notification
- [ ] iOS: agent picker in new-chat flow
- [ ] iOS: Settings card (model, permission mode, timeout)
- [ ] iOS: thread-level agent switcher
- [ ] iOS: approval/response includes `permissionId`
- [ ] Thread rename (`renameSession()`)

### Phase 3 — Protocol parity + desktop browser

Deliverable: Claude threads feel identical to Codex threads; desktop handoff works.

Checklist:
- [ ] Partial streaming (`stream_event` → `turn/delta`)
- [ ] Thinking blocks forwarded to iOS renderer
- [ ] File change events (PostToolUse hook → synthetic events)
- [ ] Push notifications for Claude turn completion
- [ ] Session fork (expose as worktree/fork flow)
- [ ] Desktop session browser (minimal HTML, served locally)
- [ ] `desktop/continueOnDesktop` branches on `agentId`

### Phase 4 — Cross-agent orchestration

Deliverable: user builds a Planner → Implementer → Reviewer chain from the phone.

Checklist:
- [ ] Create `orchestration-handler.js`
- [ ] `orchestration/start` RPC in bridge
- [ ] Step sequencing with context injection
- [ ] `parentThreadId` set on all child threads
- [ ] Progress events (`orchestration/step/completed`)
- [ ] iOS: orchestration composer UI
- [ ] iOS: grouped sub-thread view in sidebar

### Phase 5 — MCP orchestration layer

Deliverable: Claude sessions can call tools that reach back into Codex or external services.

Checklist:
- [ ] Local MCP server started by bridge per session
- [ ] MCP tools: `write_plan`, `read_plan`, `list_agent_sessions`, `get_agent_result`, `start_codex_turn`
- [ ] Per-thread MCP server config in Settings
- [ ] External MCP server attachment UI

---

## What never changes

| File | Reason |
|------|--------|
| `relay/relay.js` | Dumb forwarder, agent-agnostic |
| `relay/server.js` | HTTP server for relay |
| `secure-transport.js` | Encrypts all wire messages regardless of origin |
| `bridge.js` relay/reconnect loop | All the WebSocket + heartbeat logic stays |
| All `desktop-handler.js` Codex paths | Untouched for Codex threads |
| `rollout-watch.js` | Codex session file watcher, stays Codex-only |
| `codex-cli-bootstrap.js` | Codex CLI installer, stays Codex-only |
| `CodexThread.swift` | All required fields already present |
| `CodexApprovalRequest` (iOS) | Reused as-is, one new optional field in Phase 2 |
| All existing pairing / QR / secure transport | Untouched |

---

## Environment variables reference

| Variable | Default | Valid values | Effect |
|----------|---------|--------------|--------|
| `REMODEX_CLAUDE_CODE_ENABLED` | `0` | `0`, `1` | Enable Claude Code transport |
| `REMODEX_PERMISSION_TIMEOUT_SECS` | `30` | `10`–`120` | Auto-deny timeout for tool approvals |
| `REMODEX_WARM_IDLE_TIMEOUT_SECS` | `300` | any positive int | How long to keep Claude process warm |
| `REMODEX_DEFAULT_PERMISSION_MODE` | `acceptEdits` | `acceptEdits`, `bypassPermissions` | Default Claude permission mode |
| `REMODEX_RELAY` | *(existing)* | URL | Relay URL (unchanged) |
| `REMODEX_CODEX_ENDPOINT` | *(existing)* | URL | Direct Codex WebSocket (unchanged) |
