import type { WebClient } from "@slack/web-api";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SlackOrchestrationConfig } from "../config/types.slack.js";
import {
  getOrCreateSessionThread,
  getSessionOrchestrationThread,
  isSlackDmChannel,
  postToSessionThread,
  routeToOrchestration,
} from "./orchestration-routing.js";
import * as sessionThreadStore from "./session-thread-store.js";

// Mock the session thread store
vi.mock("./session-thread-store.js", () => ({
  getSessionThread: vi.fn(),
  setSessionThread: vi.fn(),
  updateSessionThread: vi.fn(),
}));

describe("isSlackDmChannel", () => {
  it("should return true for DM channels (starting with D)", () => {
    expect(isSlackDmChannel("D0ACVR82QNA")).toBe(true);
    expect(isSlackDmChannel("D123456789")).toBe(true);
  });

  it("should return false for non-DM channels", () => {
    expect(isSlackDmChannel("C0ACVR82QNA")).toBe(false);
    expect(isSlackDmChannel("G123456789")).toBe(false);
    expect(isSlackDmChannel("")).toBe(false);
  });
});

describe("getOrCreateSessionThread", () => {
  const createMockClient = (postMessageResult: { ts?: string } = { ts: "1234567890.123456" }) =>
    ({
      chat: {
        postMessage: vi.fn().mockResolvedValue(postMessageResult),
        getPermalink: vi.fn().mockResolvedValue({
          permalink: "https://slack.com/archives/C0ACM1FTBT9/p1234567890123456",
        }),
      },
    }) as unknown as WebClient;

  const defaultConfig: SlackOrchestrationConfig = {
    enabled: true,
    channel: "C0ACM1FTBT9",
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should return undefined when config is disabled", async () => {
    const client = createMockClient();
    const result = await getOrCreateSessionThread({
      client,
      config: { ...defaultConfig, enabled: false },
      sessionKey: "session-123",
    });
    expect(result).toBeUndefined();
  });

  it("should return existing thread if one exists", async () => {
    const client = createMockClient();
    vi.mocked(sessionThreadStore.getSessionThread).mockReturnValue({
      sessionKey: "session-123",
      threadTs: "existing-thread-ts",
      channelId: "C0ACM1FTBT9",
      createdAt: Date.now(),
      permalink: "https://slack.com/existing",
    });

    const result = await getOrCreateSessionThread({
      client,
      config: defaultConfig,
      sessionKey: "session-123",
    });

    expect(result).toEqual({
      threadTs: "existing-thread-ts",
      channelId: "C0ACM1FTBT9",
      permalink: "https://slack.com/existing",
    });
    expect(client.chat.postMessage).not.toHaveBeenCalled();
  });

  it("should create new thread if none exists", async () => {
    const client = createMockClient();
    vi.mocked(sessionThreadStore.getSessionThread).mockReturnValue(undefined);

    const result = await getOrCreateSessionThread({
      client,
      config: defaultConfig,
      sessionKey: "session-123",
      sessionLabel: "My Session",
    });

    expect(result).toEqual({
      threadTs: "1234567890.123456",
      channelId: "C0ACM1FTBT9",
      permalink: "https://slack.com/archives/C0ACM1FTBT9/p1234567890123456",
    });
    expect(client.chat.postMessage).toHaveBeenCalledWith({
      channel: "C0ACM1FTBT9",
      text: expect.stringContaining("Session Started"),
    });
    expect(sessionThreadStore.setSessionThread).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionKey: "session-123",
        threadTs: "1234567890.123456",
        channelId: "C0ACM1FTBT9",
        label: "My Session",
      }),
    );
  });
});

describe("postToSessionThread", () => {
  const createMockClient = () =>
    ({
      chat: {
        postMessage: vi.fn().mockResolvedValue({ ts: "1234567890.123456" }),
        getPermalink: vi.fn().mockResolvedValue({
          permalink: "https://slack.com/archives/C0ACM1FTBT9/p1234567890123456",
        }),
      },
    }) as unknown as WebClient;

  const defaultConfig: SlackOrchestrationConfig = {
    enabled: true,
    channel: "C0ACM1FTBT9",
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(sessionThreadStore.getSessionThread).mockReturnValue({
      sessionKey: "session-123",
      threadTs: "thread-ts",
      channelId: "C0ACM1FTBT9",
      createdAt: Date.now(),
      permalink: "https://slack.com/thread",
    });
  });

  it("should post message to existing session thread", async () => {
    const client = createMockClient();

    const result = await postToSessionThread({
      client,
      config: defaultConfig,
      sessionKey: "session-123",
      message: "Status update",
      isStatusUpdate: true,
    });

    expect(result.success).toBe(true);
    expect(client.chat.postMessage).toHaveBeenCalledWith({
      channel: "C0ACM1FTBT9",
      thread_ts: "thread-ts",
      text: "📊 Status update",
    });
  });

  it("should post without status prefix for non-status messages", async () => {
    const client = createMockClient();

    await postToSessionThread({
      client,
      config: defaultConfig,
      sessionKey: "session-123",
      message: "Regular message",
      isStatusUpdate: false,
    });

    expect(client.chat.postMessage).toHaveBeenCalledWith({
      channel: "C0ACM1FTBT9",
      thread_ts: "thread-ts",
      text: "Regular message",
    });
  });
});

describe("routeToOrchestration", () => {
  const createMockClient = (postMessageResult: { ts?: string } = { ts: "1234567890.123456" }) =>
    ({
      chat: {
        postMessage: vi.fn().mockResolvedValue(postMessageResult),
        getPermalink: vi.fn().mockResolvedValue({
          permalink: "https://slack.com/archives/C0ACM1FTBT9/p1234567890123456",
        }),
      },
    }) as unknown as WebClient;

  const defaultConfig: SlackOrchestrationConfig = {
    enabled: true,
    channel: "C0ACM1FTBT9",
    dmMaxChars: 100,
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should not route when config is undefined", async () => {
    const client = createMockClient();
    const result = await routeToOrchestration({
      client,
      config: undefined,
      sessionKey: "session-123",
      targetIsDm: true,
      message: "A".repeat(200),
    });
    expect(result.routed).toBe(false);
  });

  it("should not route when orchestration is disabled", async () => {
    const client = createMockClient();
    const result = await routeToOrchestration({
      client,
      config: { ...defaultConfig, enabled: false },
      sessionKey: "session-123",
      targetIsDm: true,
      message: "A".repeat(200),
    });
    expect(result.routed).toBe(false);
  });

  it("should not route when target is not a DM", async () => {
    const client = createMockClient();
    const result = await routeToOrchestration({
      client,
      config: defaultConfig,
      sessionKey: "session-123",
      targetIsDm: false,
      message: "A".repeat(200),
    });
    expect(result.routed).toBe(false);
  });

  it("should not route when message is under threshold", async () => {
    const client = createMockClient();
    const result = await routeToOrchestration({
      client,
      config: defaultConfig,
      sessionKey: "session-123",
      targetIsDm: true,
      message: "A".repeat(50),
    });
    expect(result.routed).toBe(false);
  });

  it("should not route when no session key provided", async () => {
    const client = createMockClient();
    const result = await routeToOrchestration({
      client,
      config: defaultConfig,
      targetIsDm: true,
      message: "A".repeat(200),
    });
    expect(result.routed).toBe(false);
  });

  it("should route message to session thread when threshold exceeded", async () => {
    const client = createMockClient();
    vi.mocked(sessionThreadStore.getSessionThread).mockReturnValue({
      sessionKey: "session-123",
      threadTs: "existing-thread",
      channelId: "C0ACM1FTBT9",
      createdAt: Date.now(),
      permalink: "https://slack.com/thread",
    });

    const result = await routeToOrchestration({
      client,
      config: defaultConfig,
      sessionKey: "session-123",
      targetIsDm: true,
      message: "A".repeat(200),
    });

    expect(result.routed).toBe(true);
    if (result.routed) {
      expect(result.threadTs).toBe("existing-thread");
      expect(result.threadChannelId).toBe("C0ACM1FTBT9");
      expect(result.newThread).toBe(false);
      expect(result.stubMessage).toContain("https://slack.com/thread");
    }
  });

  it("should create new thread for new session", async () => {
    const client = createMockClient();
    vi.mocked(sessionThreadStore.getSessionThread).mockReturnValue(undefined);

    const result = await routeToOrchestration({
      client,
      config: defaultConfig,
      sessionKey: "new-session",
      sessionLabel: "New Session Label",
      targetIsDm: true,
      message: "A".repeat(200),
    });

    expect(result.routed).toBe(true);
    if (result.routed) {
      expect(result.newThread).toBe(true);
      expect(result.threadTs).toBe("1234567890.123456");
    }
    expect(sessionThreadStore.setSessionThread).toHaveBeenCalled();
  });

  it("should use custom stub template", async () => {
    const client = createMockClient();
    vi.mocked(sessionThreadStore.getSessionThread).mockReturnValue({
      sessionKey: "session-123",
      threadTs: "thread-ts",
      channelId: "C0ACM1FTBT9",
      createdAt: Date.now(),
      permalink: "https://slack.com/custom",
    });

    const result = await routeToOrchestration({
      client,
      config: {
        ...defaultConfig,
        dmStubTemplate: "See thread: {link}",
      },
      sessionKey: "session-123",
      targetIsDm: true,
      message: "A".repeat(200),
    });

    expect(result.routed).toBe(true);
    if (result.routed) {
      expect(result.stubMessage).toBe("See thread: https://slack.com/custom");
    }
  });
});

describe("getSessionOrchestrationThread", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should return thread info for existing session", () => {
    vi.mocked(sessionThreadStore.getSessionThread).mockReturnValue({
      sessionKey: "session-123",
      threadTs: "thread-ts",
      channelId: "C0ACM1FTBT9",
      createdAt: Date.now(),
      permalink: "https://slack.com/thread",
    });

    const result = getSessionOrchestrationThread("session-123");

    expect(result).toEqual({
      threadTs: "thread-ts",
      channelId: "C0ACM1FTBT9",
      permalink: "https://slack.com/thread",
    });
  });

  it("should return undefined for non-existent session", () => {
    vi.mocked(sessionThreadStore.getSessionThread).mockReturnValue(undefined);

    const result = getSessionOrchestrationThread("non-existent");

    expect(result).toBeUndefined();
  });
});
