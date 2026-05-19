// Quick manual test for the Claude Code transport.
// Run from phodex-bridge/: REMODEX_CLAUDE_CODE_ENABLED=1 node test-claude-code.js
//
// What it does:
//   1. Creates the Claude Code transport directly (no relay, no bridge overhead)
//   2. Sends thread/start with a first message
//   3. Prints every event that comes back
//   4. Waits for turn/completed, then exits

const { createClaudeCodeTransport } = require("./src/claude-code-transport");

const THREAD_ID = "test-thread-" + Date.now();
const CWD = process.cwd(); // phodex-bridge/
const FIRST_MESSAGE = "What files are in the current directory? List them briefly.";

const transport = createClaudeCodeTransport({
  config: {
    claudeCodeEnabled: true,
    permissionTimeoutSecs: 30,
    warmIdleTimeoutSecs: 300,
    claudeCodeDefaultPermissionMode: "acceptEdits",
  },
});

transport.onMessage((rawMsg) => {
  const msg = JSON.parse(rawMsg);
  const method = msg.method || (msg.id != null ? `response#${msg.id}` : "?");
  console.log(`\n← [${method}]`, JSON.stringify(msg.params || msg.result || msg.error, null, 2));

  if (method === "turn/completed") {
    console.log("\n✅ Turn complete. Shutting down.");
    transport.shutdown();
    process.exit(0);
  }

  // Auto-approve any tool permission requests.
  if (method === "approval/request") {
    const { permissionId, tool, command } = msg.params;
    console.log(`\n🔑 Auto-approving: ${tool} ${command || ""}`);
    transport.send(JSON.stringify({
      method: "approval/response",
      params: { permissionId, approved: true },
    }));
  }
});

transport.onError((err) => {
  console.error("Transport error:", err.message);
  process.exit(1);
});

console.log(`→ thread/start  threadId=${THREAD_ID}  cwd=${CWD}`);
console.log(`→ prompt: "${FIRST_MESSAGE}"\n`);

transport.send(JSON.stringify({
  method: "thread/start",
  params: {
    agentId: "claude-code",
    threadId: THREAD_ID,
    cwd: CWD,
    model: "claude-sonnet-4-6",
    permissionMode: "acceptEdits",
    content: FIRST_MESSAGE,
  },
}));

// Safety exit after 2 minutes.
setTimeout(() => {
  console.error("Timed out after 2 minutes.");
  transport.shutdown();
  process.exit(1);
}, 2 * 60 * 1000).unref();
