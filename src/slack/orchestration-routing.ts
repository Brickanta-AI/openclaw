import type { WebClient } from "@slack/web-api";
import type { SlackOrchestrationConfig } from "../config/types.slack.js";
import { logVerbose } from "../globals.js";

const DEFAULT_DM_MAX_CHARS = 500;
const DEFAULT_DM_STUB_TEMPLATE = "Details → {link}";

export type OrchestrationRoutingResult =
  | { routed: false }
  | {
      routed: true;
      stubMessage: string;
      threadTs: string;
      threadChannelId: string;
    };

/**
 * Check if a message should be routed to the orchestration channel.
 * Returns routing info if the message should be routed, or { routed: false } if not.
 */
export async function routeToOrchestration(params: {
  client: WebClient;
  config: SlackOrchestrationConfig | undefined;
  targetChannelId: string;
  targetIsDm: boolean;
  message: string;
  threadTs?: string;
}): Promise<OrchestrationRoutingResult> {
  const { client, config, targetChannelId, targetIsDm, message, threadTs } = params;

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

  // Create thread in orchestration channel with full message
  try {
    const orchChannelId = config.channel;

    // Post the full message to orchestration channel as a new thread
    const threadResponse = await client.chat.postMessage({
      channel: orchChannelId,
      text: `📋 *Detailed Response*\n\n${message}`,
    });

    const newThreadTs = threadResponse.ts;
    if (!newThreadTs) {
      logVerbose("orchestration-routing: failed to create thread (no ts returned)");
      return { routed: false };
    }

    // Build permalink to the thread
    const permalinkResponse = await client.chat.getPermalink({
      channel: orchChannelId,
      message_ts: newThreadTs,
    });

    const permalink = permalinkResponse.permalink ?? `slack://channel?id=${orchChannelId}&message=${newThreadTs}`;

    // Build stub message for DM
    const stubTemplate = config.dmStubTemplate ?? DEFAULT_DM_STUB_TEMPLATE;
    const stubMessage = stubTemplate.replace("{link}", permalink);

    logVerbose(
      `orchestration-routing: routed ${message.length} char message to ${orchChannelId}`,
    );

    return {
      routed: true,
      stubMessage,
      threadTs: newThreadTs,
      threadChannelId: orchChannelId,
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
