import type { NotificationChannel } from "@pftypes/NotificationChannel.ts";
import type {
  OpenClawConfig,
  DiscordThreadId,
  DiscordMessageId,
  DiscordNotification,
  DiscordResponse,
} from "@pftypes/Discord.ts";
import { toThreadId, toMessageId } from "@pftypes/Discord.ts";
import type { PipelineLogger } from "@pftypes/Logger.ts";

// ── OpenClaw HTTP API Client ─────────────────────────────────────────
// Implements NotificationChannel using OpenClaw's /tools/invoke HTTP
// API to route notifications to Discord forum threads.
//
// API endpoint: POST http://<gateway>:<port>/tools/invoke
// Auth: Bearer token in Authorization header
// Payload: { tool, action?, args?, sessionKey? }
// Per docs: `action` is a top-level field, not inside `args`.
// See: https://docs.openclaw.ai/gateway/tools-invoke-http-api

export class OpenClawClient implements NotificationChannel {
  private readonly config: OpenClawConfig;
  private readonly logger: PipelineLogger;

  constructor(config: OpenClawConfig, logger: PipelineLogger) {
    this.config = config;
    this.logger = logger;
  }

  // ── NotificationChannel Implementation ───────────────────────────

  readonly createThread = async (
    pipelineId: string,
    feature: string,
  ): Promise<DiscordThreadId> => {
    // Per OpenClaw Discord docs: sending to a forum channel auto-creates a
    // thread. The first non-empty line of the message becomes the thread title.
    const threadTitle: string = `PipelineForge: ${feature} (${pipelineId})`;
    const body: string = `Pipeline **${pipelineId}** started.\nFeature: ${feature}\n\nUpdates and questions will be posted here.`;
    const message: string = `${threadTitle}\n${body}`;

    const result: ToolInvokeResult = await this.invokeMessageTool(
      "send",
      {
        channel: "discord",
        target: `channel:${this.config.forum_channel_id}`,
        message,
      },
    );

    const threadId: string = this.extractThreadId(result);
    this.logger.pipelineEvent(
      "info",
      `Discord thread created: ${threadId}`,
    );

    return toThreadId(threadId);
  };

  readonly sendNotification = async (
    notification: DiscordNotification,
  ): Promise<DiscordMessageId> => {
    const formatted: string = `**${notification.title}**\n\n${notification.body}`;

    const result: ToolInvokeResult = await this.invokeMessageTool(
      "send",
      {
        channel: "discord",
        target: `channel:${String(notification.threadId)}`,
        message: formatted,
      },
    );

    const messageId: string = this.extractMessageId(result);
    return toMessageId(messageId);
  };

  readonly waitForResponse = async (
    threadId: DiscordThreadId,
    afterMessageId: DiscordMessageId,
    timeoutMs: number,
  ): Promise<DiscordResponse> => {
    const deadline: number = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      const messages: ReadonlyArray<ThreadMessage> = await this.readThreadMessages(
        threadId,
      );

      // Find the first human message after our notification
      const response: ThreadMessage | undefined = this.findHumanReplyAfter(
        messages,
        afterMessageId,
      );

      if (response !== undefined) {
        return {
          messageId: toMessageId(response.id),
          action: "answer",
          content: response.content,
          respondedAt: response.timestamp,
        };
      }

      // Wait before polling again
      await this.sleep(this.config.poll_interval_ms);
    }

    throw new Error(
      `Timeout waiting for Discord response in thread ${String(threadId)} ` +
      `after ${String(timeoutMs)}ms`,
    );
  };

  readonly sendUpdate = async (
    threadId: DiscordThreadId,
    message: string,
  ): Promise<void> => {
    await this.invokeMessageTool(
      "send",
      {
        channel: "discord",
        target: `channel:${String(threadId)}`,
        message,
      },
    );
  };

  // ── HTTP API ─────────────────────────────────────────────────────

  private async invokeMessageTool(
    action: string,
    args: MessageToolArgs,
  ): Promise<ToolInvokeResult> {
    const url: string = `${this.config.gateway_url}/tools/invoke`;

    const requestBody: ToolInvokeRequest = {
      tool: "message",
      action,
      args,
    };

    const response: Response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${this.config.bearer_token}`,
      },
      body: JSON.stringify(requestBody),
    });

    if (!response.ok) {
      const errorText: string = await response.text();
      throw new Error(
        `OpenClaw API error (${String(response.status)}): ${errorText}`,
      );
    }

    const body: unknown = await response.json();
    const parsed: ToolInvokeResult = body as ToolInvokeResult;

    if (!parsed.ok) {
      throw new Error(
        `OpenClaw tool error: ${parsed.error?.message ?? "unknown"}`,
      );
    }

    return parsed;
  }

  private async readThreadMessages(
    threadId: DiscordThreadId,
  ): Promise<ReadonlyArray<ThreadMessage>> {
    const result: ToolInvokeResult = await this.invokeMessageTool(
      "read",
      {
        channel: "discord",
        target: `channel:${String(threadId)}`,
        limit: 10,
      },
    );

    const messages: unknown = result.result?.messages;
    if (!Array.isArray(messages)) {
      return [];
    }

    return messages as ReadonlyArray<ThreadMessage>;
  }

  // ── Helpers ──────────────────────────────────────────────────────

  private extractThreadId(result: ToolInvokeResult): string {
    const threadId: unknown = result.result?.threadId ?? result.result?.id;
    if (typeof threadId === "string") {
      return threadId;
    }
    throw new Error("Could not extract thread ID from OpenClaw response");
  }

  private extractMessageId(result: ToolInvokeResult): string {
    const messageId: unknown = result.result?.messageId ?? result.result?.id;
    if (typeof messageId === "string") {
      return messageId;
    }
    throw new Error("Could not extract message ID from OpenClaw response");
  }

  private findHumanReplyAfter(
    messages: ReadonlyArray<ThreadMessage>,
    afterMessageId: DiscordMessageId,
  ): ThreadMessage | undefined {
    let foundMarker: boolean = false;

    for (const msg of messages) {
      if (msg.id === afterMessageId) {
        foundMarker = true;
        continue;
      }
      if (foundMarker && !msg.isBot) {
        return msg;
      }
    }

    return undefined;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise<void>((resolve: () => void): void => {
      setTimeout(resolve, ms);
    });
  }
}

// ── Internal Types ───────────────────────────────────────────────────

/** Top-level request body for OpenClaw /tools/invoke endpoint. */
interface ToolInvokeRequest {
  readonly tool: string;
  readonly action: string;
  readonly args: MessageToolArgs;
}

/** Tool-specific arguments (everything except action, which is top-level). */
interface MessageToolArgs {
  readonly channel: string;
  readonly target: string;
  readonly message?: string;
  readonly threadName?: string;
  readonly limit?: number;
}

interface ToolInvokeResult {
  readonly ok: boolean;
  readonly result?: Record<string, unknown>;
  readonly error?: { readonly type: string; readonly message: string };
}

interface ThreadMessage {
  readonly id: string;
  readonly content: string;
  readonly timestamp: string;
  readonly isBot: boolean;
}
