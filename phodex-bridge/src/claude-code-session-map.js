// FILE: claude-code-session-map.js
// Purpose: Persists the Remodex threadId <-> Claude Code sessionId mapping to disk.
// Layer: CLI helper
// Exports: loadSessionMap, saveSessionEntry, deleteSessionEntry, getSessionEntry, listSessionEntries
// Depends on: fs, os, path

const fs = require("fs");
const os = require("os");
const path = require("path");

const STATE_DIR = path.join(os.homedir(), ".remodex");
const SESSION_MAP_FILE = path.join(STATE_DIR, "claude-sessions.json");

// Entry schema:
// {
//   sessionId: string,        // Claude Code UUID
//   cwd: string,              // absolute project path
//   agentId: "claude-code",
//   model: string,
//   permissionMode: string,
//   createdAt: string,        // ISO8601
//   updatedAt: string,
//   title: string | null,
// }

function loadSessionMap() {
  try {
    if (!fs.existsSync(SESSION_MAP_FILE)) {
      return {};
    }
    const raw = fs.readFileSync(SESSION_MAP_FILE, "utf8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function writeSessionMap(map) {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.writeFileSync(SESSION_MAP_FILE, JSON.stringify(map, null, 2));
}

function saveSessionEntry(threadId, entry) {
  if (!threadId || typeof threadId !== "string") {
    return false;
  }
  const map = loadSessionMap();
  map[threadId] = {
    ...entry,
    updatedAt: new Date().toISOString(),
  };
  writeSessionMap(map);
  return true;
}

function deleteSessionEntry(threadId) {
  if (!threadId || typeof threadId !== "string") {
    return false;
  }
  const map = loadSessionMap();
  if (!map[threadId]) {
    return false;
  }
  delete map[threadId];
  writeSessionMap(map);
  return true;
}

function getSessionEntry(threadId) {
  if (!threadId || typeof threadId !== "string") {
    return null;
  }
  const map = loadSessionMap();
  return map[threadId] || null;
}

function listSessionEntries() {
  const map = loadSessionMap();
  return Object.entries(map).map(([threadId, entry]) => ({
    threadId,
    ...entry,
  }));
}

module.exports = {
  loadSessionMap,
  saveSessionEntry,
  deleteSessionEntry,
  getSessionEntry,
  listSessionEntries,
};
