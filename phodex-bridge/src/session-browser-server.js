// FILE: session-browser-server.js
// Purpose: Local HTTP server serving a unified Codex+Claude session browser for desktop handoff.
// Layer: Bridge service
// Exports: createSessionBrowserServer, getSessionBrowserServer
// Depends on: http, fs, path, os, ./claude-code-session-map

"use strict";

const http = require("http");
const { execFile } = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { promisify } = require("util");

const STATIC_DIR = path.join(__dirname, "session-browser-static");
const IDLE_TIMEOUT_DEFAULT_MS = 10 * 60 * 1000; // 10 minutes
const execFileAsync = promisify(execFile);

function createSessionBrowserServer({
  getCodexSessions,
  getClaudeSessions,
  logPrefix = "[remodex:browser]",
  idleTimeoutMs = IDLE_TIMEOUT_DEFAULT_MS,
} = {}) {
  let server = null;
  let port = null;
  let idleTimer = null;

  function resetIdleTimer() {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      if (server) {
        server.close();
        server = null;
        port = null;
      }
    }, idleTimeoutMs);
    // Don't hold the process open for the idle timer alone
    if (idleTimer.unref) {
      idleTimer.unref();
    }
  }

  async function handleRequest(req, res) {
    resetIdleTimer();

    const url = new URL(req.url, "http://127.0.0.1");
    const pathname = url.pathname;

    if (req.method !== "GET") {
      res.writeHead(405);
      res.end("Method Not Allowed");
      return;
    }

    if (pathname === "/sessions" || pathname === "/") {
      const filePath = path.join(STATIC_DIR, "index.html");
      fs.readFile(filePath, (err, data) => {
        if (err) {
          res.writeHead(500);
          res.end("Internal Server Error");
          return;
        }
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(data);
      });
      return;
    }

    if (pathname === "/style.css") {
      const filePath = path.join(STATIC_DIR, "style.css");
      fs.readFile(filePath, (err, data) => {
        if (err) {
          res.writeHead(500);
          res.end("Internal Server Error");
          return;
        }
        res.writeHead(200, { "Content-Type": "text/css; charset=utf-8" });
        res.end(data);
      });
      return;
    }

    if (pathname === "/api/sessions") {
      let codex = [];
      let claude = [];

      try {
        codex = await getCodexSessions();
      } catch (err) {
        console.error(`${logPrefix} getCodexSessions error:`, err.message);
      }

      try {
        claude = await getClaudeSessions();
      } catch (err) {
        console.error(`${logPrefix} getClaudeSessions error:`, err.message);
      }

      const body = JSON.stringify({ codex, claude });
      res.writeHead(200, {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
      });
      res.end(body);
      return;
    }

    if (pathname === "/api/open-terminal") {
      const id = url.searchParams.get("id") || "";
      const agent = url.searchParams.get("agent") || "";
      try {
        const session = await findSessionById({ id, agent, getCodexSessions, getClaudeSessions });
        if (!session?.cwd || !isSafeAbsolutePath(session.cwd)) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: "Session has no local working directory." }));
          return;
        }
        await openTerminalAt(session.cwd);
        res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
        res.end(JSON.stringify({ ok: true }));
      } catch (err) {
        console.error(`${logPrefix} open-terminal error:`, err.message);
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "Could not open terminal." }));
      }
      return;
    }

    res.writeHead(404);
    res.end("Not Found");
  }

  async function start() {
    if (server) {
      return { url: `http://127.0.0.1:${port}`, port };
    }

    return new Promise((resolve, reject) => {
      const s = http.createServer(handleRequest);
      s.on("error", reject);
      s.listen(0, "127.0.0.1", () => {
        server = s;
        port = s.address().port;
        resetIdleTimer();
        console.log(`${logPrefix} Session browser listening on http://127.0.0.1:${port}`);
        resolve({ url: `http://127.0.0.1:${port}`, port });
      });
    });
  }

  function stop() {
    clearTimeout(idleTimer);
    idleTimer = null;
    if (server) {
      server.close();
      server = null;
      port = null;
    }
  }

  function isRunning() {
    return server !== null && server.listening;
  }

  function focusUrl(threadId) {
    if (!server) {
      throw new Error("Session browser server is not running");
    }
    const encoded = encodeURIComponent(threadId);
    return `http://127.0.0.1:${port}/sessions?focus=${encoded}`;
  }

  function touch() {
    if (server) {
      resetIdleTimer();
    }
  }

  return { start, stop, isRunning, focusUrl, touch };
}

// ---------------------------------------------------------------------------
// Singleton helpers used by desktop-handler.js
// ---------------------------------------------------------------------------

const { listSessionEntries } = require("./claude-code-session-map");

async function defaultGetCodexSessions() {
  const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
  const sessionsDir = path.join(codexHome, "sessions");
  try {
    return collectCodexRolloutSessions(sessionsDir);
  } catch {
    return [];
  }
}

async function defaultGetClaudeSessions() {
  return listSessionEntries().map((entry) => ({
    id: entry.threadId,
    title: entry.title || null,
    model: entry.model || null,
    agentId: "claude-code",
    cwd: entry.cwd || null,
    updatedAt: entry.updatedAt || null,
  }));
}

let _singleton = null;

function getSessionBrowserServer() {
  if (!_singleton) {
    _singleton = createSessionBrowserServer({
      getCodexSessions: defaultGetCodexSessions,
      getClaudeSessions: defaultGetClaudeSessions,
    });
  }
  return _singleton;
}

module.exports = {
  createSessionBrowserServer,
  getSessionBrowserServer,
};

function collectCodexRolloutSessions(root) {
  const files = [];
  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
      } else if (entry.isFile() && entry.name.startsWith("rollout-") && entry.name.endsWith(".jsonl")) {
        const stat = fs.statSync(fullPath);
        files.push({ filePath: fullPath, mtimeMs: stat.mtimeMs });
      }
    }
  }

  return files
    .sort((lhs, rhs) => rhs.mtimeMs - lhs.mtimeMs)
    .slice(0, 100)
    .map(({ filePath, mtimeMs }) => codexSessionFromRollout(filePath, mtimeMs))
    .filter(Boolean);
}

function codexSessionFromRollout(filePath, mtimeMs) {
  const basename = path.basename(filePath, ".jsonl");
  const fallbackId = basename.replace(/^rollout-/, "");
  const sample = readTail(filePath, 128 * 1024);
  const lines = sample.split(/\r?\n/).filter(Boolean);
  const metadata = {};
  for (const line of lines) {
    const object = safeParseJSON(line);
    if (!object) continue;
    metadata.id ||= findFirstString(object, ["threadId", "thread_id", "conversationId", "conversation_id", "session_id"]);
    metadata.title ||= findFirstString(object, ["title", "name", "threadName", "thread_name"]);
    metadata.cwd ||= findFirstString(object, ["cwd", "workingDirectory", "working_directory", "gitWorkingDirectory", "git_working_directory"]);
  }

  const id = metadata.id || fallbackId;
  return {
    id,
    title: metadata.title || id,
    agentId: "codex",
    cwd: metadata.cwd || null,
    updatedAt: new Date(mtimeMs).toISOString(),
  };
}

function readTail(filePath, maxBytes) {
  const stat = fs.statSync(filePath);
  const start = Math.max(0, stat.size - maxBytes);
  const fd = fs.openSync(filePath, "r");
  try {
    const buffer = Buffer.alloc(stat.size - start);
    fs.readSync(fd, buffer, 0, buffer.length, start);
    return buffer.toString("utf8");
  } finally {
    fs.closeSync(fd);
  }
}

function findFirstString(value, keys) {
  const queue = [value];
  const seen = new Set();
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current || typeof current !== "object" || seen.has(current)) continue;
    seen.add(current);
    for (const key of keys) {
      if (typeof current[key] === "string" && current[key].trim()) {
        return current[key].trim();
      }
    }
    for (const child of Object.values(current)) {
      if (child && typeof child === "object") queue.push(child);
    }
  }
  return null;
}

async function findSessionById({ id, agent, getCodexSessions, getClaudeSessions }) {
  const normalizedId = typeof id === "string" ? id.trim() : "";
  if (!normalizedId) return null;
  const [codex, claude] = await Promise.all([
    agent === "claude-code" ? [] : getCodexSessions(),
    agent === "codex" ? [] : getClaudeSessions(),
  ]);
  return [...codex, ...claude].find((session) => session.id === normalizedId) || null;
}

function isSafeAbsolutePath(value) {
  return typeof value === "string"
    && path.isAbsolute(value)
    && !value.includes("\0")
    && fs.existsSync(value);
}

async function openTerminalAt(cwd) {
  if (process.platform === "darwin") {
    await execFileAsync("open", ["-a", "Terminal", cwd], { timeout: 20_000 });
    return;
  }
  if (process.platform === "win32") {
    await execFileAsync("cmd.exe", ["/c", "start", "", cwd], { timeout: 20_000, windowsHide: true });
    return;
  }
  await execFileAsync("x-terminal-emulator", [], { cwd, timeout: 20_000 });
}

function safeParseJSON(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}
