import type { WebClient } from "@slack/web-api";
import { describe, expect, it, vi } from "vitest";
import type { SlackOrchestrationConfig } from "../config/types.slack.js";
import { isSlackDmChannel, routeToOrchestration } from "./orchestration-routing.js";

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

  it("should not route when config is undefined", async () => {
    const client = createMockClient();
    const result = await routeToOrchestration({
      client,
      config: undefined,
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
      targetIsDm: true,
      message: "A".repeat(200),
    });
    expect(result.routed).toBe(false);
  });

  it("should not route when channel is not configured", async () => {
    const client = createMockClient();
    const result = await routeToOrchestration({
      client,
      config: { ...defaultConfig, channel: "" },
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
      targetIsDm: true,
      message: "A".repeat(50), // Under 100 char limit
    });
    expect(result.routed).toBe(false);
  });

  it("should not route when autoThread is disabled", async () => {
    const client = createMockClient();
    const result = await routeToOrchestration({
      client,
      config: { ...defaultConfig, autoThread: false },
      targetIsDm: true,
      message: "A".repeat(200),
    });
    expect(result.routed).toBe(false);
  });

  it("should route message exceeding threshold to orchestration channel", async () => {
    const client = createMockClient();
    const result = await routeToOrchestration({
      client,
      config: defaultConfig,
      targetIsDm: true,
      message: "A".repeat(200),
    });

    expect(result.routed).toBe(true);
    if (result.routed) {
      expect(result.threadTs).toBe("1234567890.123456");
      expect(result.threadChannelId).toBe("C0ACM1FTBT9");
      expect(result.stubMessage).toContain("https://slack.com/archives/C0ACM1FTBT9");
    }
    expect(client.chat.postMessage).toHaveBeenCalledWith({
      channel: "C0ACM1FTBT9",
      text: expect.stringContaining("📋 *Detailed Response*"),
    });
  });

  it("should use custom stub template", async () => {
    const client = createMockClient();
    const result = await routeToOrchestration({
      client,
      config: {
        ...defaultConfig,
        dmStubTemplate: "See full response: {link}",
      },
      targetIsDm: true,
      message: "A".repeat(200),
    });

    expect(result.routed).toBe(true);
    if (result.routed) {
      expect(result.stubMessage).toBe(
        "See full response: https://slack.com/archives/C0ACM1FTBT9/p1234567890123456",
      );
    }
  });

  it("should use default dmMaxChars (500) when not specified", async () => {
    const client = createMockClient();
    const config: SlackOrchestrationConfig = {
      enabled: true,
      channel: "C0ACM1FTBT9",
      // dmMaxChars not specified - should default to 500
    };

    // Message under 500 should not route
    const resultUnder = await routeToOrchestration({
      client,
      config,
      targetIsDm: true,
      message: "A".repeat(400),
    });
    expect(resultUnder.routed).toBe(false);

    // Message over 500 should route
    const resultOver = await routeToOrchestration({
      client,
      config,
      targetIsDm: true,
      message: "A".repeat(600),
    });
    expect(resultOver.routed).toBe(true);
  });

  it("should handle postMessage failure gracefully", async () => {
    const client = {
      chat: {
        postMessage: vi.fn().mockRejectedValue(new Error("API error")),
      },
    } as unknown as WebClient;

    const result = await routeToOrchestration({
      client,
      config: defaultConfig,
      targetIsDm: true,
      message: "A".repeat(200),
    });

    expect(result.routed).toBe(false);
  });

  it("should handle missing thread ts gracefully", async () => {
    const client = createMockClient({ ts: undefined });
    const result = await routeToOrchestration({
      client,
      config: defaultConfig,
      targetIsDm: true,
      message: "A".repeat(200),
    });

    expect(result.routed).toBe(false);
  });
});
