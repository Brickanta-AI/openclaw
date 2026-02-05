import type { WebClient } from "@slack/web-api";
import type { SlackOrchestrationConfig } from "../config/types.slack.js";
import { logVerbose } from "../globals.js";
import {
  getSessionThread,
  setSessionThread,
  updateSessionThread,
  type SessionThreadMapping,
} from "./session-thread-store.js";

const DEFAULT_DM_MAX_CHARS = 500;
const DEFAULT_DM_STUB_TEMPLATE = "Details → {link}";

export type OrchestrationRoutingResult =
  | { routed: false }
  | {
      routed: true;
      stubMessage: string;
      threadTs: string;
      threadChannelId: string;
      /** Whether this created a new session thread */
      newThread: boolean;
    };

export interface SessionThreadInfo {
  threadTs: string;
  channelId: string;
  permalink?: string;
}

/**
 * Get or create the orchestration thread for a session.
 * Thread = Session: each session has exactly one orchestration thread.
 */
export async function getOrCreateSessionThread(params: {
  client: WebClient;
  config: SlackOrchestrationConfig;
  sessionKey: string;
  sessionLabel?: string;
}): Promise<SessionThreadInfo | undefined> {
  const { client, config, sessionKey, sessionLabel } = params;

  if (!config.enabled || !config.channel) {
    return undefined;
  }

  // Check for existing thread
  const existing = getSessionThread(sessionKey);
  if (existing) {
    return {
      threadTs: existing.threadTs,
      channelId: existing.channelId,
      permalink: existing.permalink,
    };
  }

  // Create new thread for this session
  try {
    const orchChannelId = config.channel;
    const displayLabel = sessionLabel ?? sessionKey;
    const timestamp = new Date().toISOString();

    // Create thread with session header
    const threadResponse = await client.chat.postMessage({
      channel: orchChannelId,
      text: `🧵 *Session Started*\n\n*Session:* \`${displayLabel}\`\n*Started:* ${timestamp}`,
    });

    const threadTs = threadResponse.ts;
    if (!threadTs) {
      logVerbose("orchestration-routing: failed to create session thread (no ts returned)");
      return undefined;
    }

    // Get permalink
    let permalink: string | undefined;
    try {
      const permalinkResponse = await client.chat.getPermalink({
        channel: orchChannelId,
        message_ts: threadTs,
      });
      permalink = permalinkResponse.permalink;
    } catch {
      permalink = `slack://channel?id=${orchChannelId}&message=${threadTs}`;
    }

    // Store the mapping
    const mapping: SessionThreadMapping = {
      sessionKey,
      threadTs,
      channelId: orchChannelId,
      createdAt: Date.now(),
      label: sessionLabel,
      permalink,
    };
    setSessionThread(mapping);

    logVerbose(`orchestration-routing: created session thread for ${sessionKey} at ${threadTs}`);

    return {
      threadTs,
      channelId: orchChannelId,
      permalink,
    };
  } catch (err) {
    logVerbose(`orchestration-routing: failed to create session thread: ${String(err)}`);
    return undefined;
  }
}

/**
 * Post a message to a session's orchestration thread.
 * Creates the thread if it doesn't exist.
 */
export async function postToSessionThread(params: {
  client: WebClient;
  config: SlackOrchestrationConfig;
  sessionKey: string;
  sessionLabel?: string;
  message: string;
  /** If true, this is a status update, not a full message */
  isStatusUpdate?: boolean;
}): Promise<{ success: boolean; threadTs?: string; permalink?: string }> {
  const { client, config, sessionKey, sessionLabel, message, isStatusUpdate } = params;

  const threadInfo = await getOrCreateSessionThread({
    client,
    config,
    sessionKey,
    sessionLabel,
  });

  if (!threadInfo) {
    return { success: false };
  }

  try {
    // Post as reply in the thread
    const prefix = isStatusUpdate ? "📊 " : "";
    await client.chat.postMessage({
      channel: threadInfo.channelId,
      thread_ts: threadInfo.threadTs,
      text: `${prefix}${message}`,
    });

    return {
      success: true,
      threadTs: threadInfo.threadTs,
      permalink: threadInfo.permalink,
    };
  } catch (err) {
    logVerbose(`orchestration-routing: failed to post to session thread: ${String(err)}`);
    return { success: false };
  }
}

/**
 * Route a long DM message to the session's orchestration thread.
 * Returns routing info if the message should be routed, or { routed: false } if not.
 */
export async function routeToOrchestration(params: {
  client: WebClient;
  config: SlackOrchestrationConfig | undefined;
  sessionKey?: string;
  sessionLabel?: string;
  targetIsDm: boolean;
  message: string;
}): Promise<OrchestrationRoutingResult> {
  const { client, config, sessionKey, sessionLabel, targetIsDm, message } = params;

  // Check if orchestration routing is enabled
  if (!config?.enabled || !config.channel) {
    return { routed: false };
  }

  // Only route DM messages (not channel/thread messages)
  if (!targetIsDm) {
    return { routed: false };
  }

  // Check if message exceeds threshold
  const maxChars = config.dmMaxChars ?? DEFAULT_DM_MAX_CHARS;
  if (message.length <= maxChars) {
    return { routed: false };
  }

  // Don't route if autoThread is disabled
  if (config.autoThread === false) {
    return { routed: false };
  }

  // Need a session key to create/use thread
  if (!sessionKey) {
    logVerbose("orchestration-routing: no session key provided, cannot route");
    return { routed: false };
  }

  // Get or create the session thread
  const existingThread = getSessionThread(sessionKey);
  const isNewThread = !existingThread;

  const threadInfo = await getOrCreateSessionThread({
    client,
    config,
    sessionKey,
    sessionLabel,
  });

  if (!threadInfo) {
    return { routed: false };
  }

  try {
    // Post the full message to the session's thread
    await client.chat.postMessage({
      channel: threadInfo.channelId,
      thread_ts: threadInfo.threadTs,
      text: `📋 *Agent Response*\n\n${message}`,
    });

    // Build permalink for stub message
    let permalink = threadInfo.permalink;
    if (!permalink) {
      try {
        const permalinkResponse = await client.chat.getPermalink({
          channel: threadInfo.channelId,
          message_ts: threadInfo.threadTs,
        });
        permalink = permalinkResponse.permalink;
        // Update stored permalink
        if (permalink) {
          updateSessionThread(sessionKey, { permalink });
        }
      } catch {
        permalink = `slack://channel?id=${threadInfo.channelId}&message=${threadInfo.threadTs}`;
      }
    }

    // Build stub message for DM
    const stubTemplate = config.dmStubTemplate ?? DEFAULT_DM_STUB_TEMPLATE;
    const stubMessage = stubTemplate.replace("{link}", permalink ?? "");

    logVerbose(
      `orchestration-routing: routed ${message.length} char message to session thread ${threadInfo.threadTs}`,
    );

    return {
      routed: true,
      stubMessage,
      threadTs: threadInfo.threadTs,
      threadChannelId: threadInfo.channelId,
      newThread: isNewThread,
    };
  } catch (err) {
    logVerbose(`orchestration-routing: failed to route message: ${String(err)}`);
    return { routed: false };
  }
}

/**
 * Check if a channel ID represents a DM (starts with 'D').
 */
export function isSlackDmChannel(channelId: string): boolean {
  return channelId.startsWith("D");
}

/**
 * Get the orchestration thread info for a session (if it exists).
 */
export function getSessionOrchestrationThread(sessionKey: string): SessionThreadInfo | undefined {
  const mapping = getSessionThread(sessionKey);
  if (mapping) {
    return {
      threadTs: mapping.threadTs,
      channelId: mapping.channelId,
      permalink: mapping.permalink,
    };
  }
  return undefined;
}
