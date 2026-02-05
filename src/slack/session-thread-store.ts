import fs from "node:fs";
import path from "node:path";
import { logVerbose } from "../globals.js";
import { CONFIG_DIR } from "../utils.js";

/**
 * Persistent store mapping session keys to orchestration thread timestamps.
 * Thread = Session: each session has exactly one orchestration thread.
 */

export interface SessionThreadMapping {
  sessionKey: string;
  threadTs: string;
  channelId: string;
  createdAt: number;
  /** Optional display label for the session */
  label?: string;
  /** Permalink to the thread */
  permalink?: string;
}

interface SessionThreadStoreData {
  version: 1;
  mappings: Record<string, SessionThreadMapping>;
}

const STORE_FILENAME = "session-threads.json";

function getStorePath(): string {
  return path.join(CONFIG_DIR, "slack", STORE_FILENAME);
}

function loadStore(): SessionThreadStoreData {
  const storePath = getStorePath();
  try {
    if (fs.existsSync(storePath)) {
      const raw = fs.readFileSync(storePath, "utf-8");
      const data = JSON.parse(raw) as SessionThreadStoreData;
      if (data.version === 1 && data.mappings) {
        return data;
      }
    }
  } catch (err) {
    logVerbose(`session-thread-store: failed to load store: ${String(err)}`);
  }
  return { version: 1, mappings: {} };
}

function saveStore(data: SessionThreadStoreData): void {
  const storePath = getStorePath();
  try {
    const dir = path.dirname(storePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(storePath, JSON.stringify(data, null, 2), "utf-8");
  } catch (err) {
    logVerbose(`session-thread-store: failed to save store: ${String(err)}`);
  }
}

/**
 * Get the orchestration thread for a session, if one exists.
 */
export function getSessionThread(sessionKey: string): SessionThreadMapping | undefined {
  const store = loadStore();
  return store.mappings[sessionKey];
}

/**
 * Get session key from a thread timestamp.
 */
export function getSessionByThread(threadTs: string): SessionThreadMapping | undefined {
  const store = loadStore();
  return Object.values(store.mappings).find((m) => m.threadTs === threadTs);
}

/**
 * Register a new session-thread mapping.
 */
export function setSessionThread(mapping: SessionThreadMapping): void {
  const store = loadStore();
  store.mappings[mapping.sessionKey] = mapping;
  saveStore(store);
  logVerbose(
    `session-thread-store: registered session=${mapping.sessionKey} thread=${mapping.threadTs}`,
  );
}

/**
 * Remove a session-thread mapping.
 */
export function removeSessionThread(sessionKey: string): boolean {
  const store = loadStore();
  if (store.mappings[sessionKey]) {
    delete store.mappings[sessionKey];
    saveStore(store);
    logVerbose(`session-thread-store: removed session=${sessionKey}`);
    return true;
  }
  return false;
}

/**
 * List all session-thread mappings.
 */
export function listSessionThreads(): SessionThreadMapping[] {
  const store = loadStore();
  return Object.values(store.mappings).toSorted((a, b) => b.createdAt - a.createdAt);
}

/**
 * Update an existing mapping (e.g., to add permalink).
 */
export function updateSessionThread(
  sessionKey: string,
  updates: Partial<Omit<SessionThreadMapping, "sessionKey">>,
): boolean {
  const store = loadStore();
  const existing = store.mappings[sessionKey];
  if (existing) {
    store.mappings[sessionKey] = { ...existing, ...updates };
    saveStore(store);
    return true;
  }
  return false;
}
