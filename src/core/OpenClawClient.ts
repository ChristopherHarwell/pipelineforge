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
import { execFileAsync } from "@utils/process.ts";
import { sleep } from "@utils/process.ts";
import { OPENCLAW_CLI } from "@utils/openclaw-constants.ts";
import { isJsonObject, getStringField, getNestedObject } from "@utils/json-guards.ts";

// ── OpenClaw CLI Client ──────────────────────────────────────────────
// Implements NotificationChannel using the `openclaw message` CLI
// commands to route notifications to Discord forum threads.
//
// Commands used:
//   openclaw message thread create --channel discord --target <channelId> --thread-name <name> -m <text> --json
//   openclaw message thread reply --channel discord --target <threadId> -m <text> --json
//   openclaw message read --channel discord --target <threadId> --after <msgId> --json
//   openclaw message send --channel discord --target <threadId> -m <text> --json

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
    const threadName: string = `PipelineForge: ${feature} (${pipelineId})`;
    const body: string =
      `Pipeline **${pipelineId}** started.\n` +
      `Feature: ${feature}\n\n` +
      `Updates and questions will be posted here.`;

    const { stdout } = await execFileAsync(OPENCLAW_CLI, [
      "message",
      "thread",
      "create",
      "--channel",
      "discord",
      "--target",
      `channel:${this.config.forum_channel_id}`,
      "--thread-name",
      threadName,
      "-m",
      body,
      "--json",
    ]);

    const threadId: string = this.extractField(stdout, "threadId", "id");

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

    const { stdout } = await execFileAsync(OPENCLAW_CLI, [
      "message",
      "send",
      "--channel",
      "discord",
      "--target",
      String(notification.threadId),
      "-m",
      formatted,
      "--json",
    ]);

    const messageId: string = this.extractField(stdout, "messageId", "id");
    return toMessageId(messageId);
  };

  readonly waitForResponse = async (
    threadId: DiscordThreadId,
    afterMessageId: DiscordMessageId,
    timeoutMs: number,
  ): Promise<DiscordResponse> => {
    const deadline: number = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      const messages: ReadonlyArray<ThreadMessage> =
        await this.readThreadMessages(threadId, afterMessageId);

      // Find the first human (non-bot) message
      const response: ThreadMessage | undefined = messages.find(
        (msg: ThreadMessage): boolean => !msg.isBot,
      );

      if (response !== undefined) {
        return {
          messageId: toMessageId(response.id),
          action: "answer",
          content: response.content,
          respondedAt: response.timestamp,
        };
      }

      await sleep(this.config.poll_interval_ms);
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
    await execFileAsync(OPENCLAW_CLI, [
      "message",
      "send",
      "--channel",
      "discord",
      "--target",
      String(threadId),
      "-m",
      message,
      "--json",
    ]);
  };

  // ── CLI Helpers ───────────────────────────────────────────────────

  /**
   * Read messages from a Discord thread after a given message ID.
   *
   * @param threadId - The thread to read from
   * @param afterMessageId - Only read messages after this ID
   * @returns Array of thread messages
   */
  private async readThreadMessages(
    threadId: DiscordThreadId,
    afterMessageId: DiscordMessageId,
  ): Promise<ReadonlyArray<ThreadMessage>> {
    try {
      const { stdout } = await execFileAsync(OPENCLAW_CLI, [
        "message",
        "read",
        "--channel",
        "discord",
        "--target",
        String(threadId),
        "--after",
        String(afterMessageId),
        "--limit",
        "10",
        "--json",
      ]);

      return this.parseMessages(stdout);
    } catch {
      // Read failure — return empty (will retry on next poll)
      return [];
    }
  }

  /**
   * Parse JSON output from `openclaw message read` into ThreadMessages.
   *
   * @param stdout - Raw JSON CLI output
   * @returns Parsed message array
   */
  private parseMessages(stdout: string): ReadonlyArray<ThreadMessage> {
    const trimmed: string = stdout.trim();
    if (trimmed.length === 0) {
      return [];
    }

    const parsed: unknown = JSON.parse(trimmed);

    // Could be { messages: [...] } or a direct array
    const rawMessages: unknown = Array.isArray(parsed)
      ? parsed
      : (isJsonObject(parsed) && "messages" in parsed)
        ? parsed["messages"]
        : null;

    if (!Array.isArray(rawMessages)) {
      return [];
    }

    const messages: ThreadMessage[] = [];

    for (const msg of rawMessages) {
      if (!isJsonObject(msg)) {
        continue;
      }

      const id: string | undefined = getStringField(msg, "id") ?? getStringField(msg, "messageId");
      const content: string | undefined = getStringField(msg, "content") ?? getStringField(msg, "text") ?? getStringField(msg, "body");
      const timestamp: string | undefined = getStringField(msg, "timestamp") ?? getStringField(msg, "createdAt") ?? getStringField(msg, "date");
      const isBot: unknown = msg["isBot"] ?? msg["bot"] ?? msg["fromBot"];

      if (id !== undefined && content !== undefined) {
        messages.push({
          id,
          content,
          timestamp: timestamp ?? new Date().toISOString(),
          isBot: isBot === true,
        });
      }
    }

    return messages;
  }

  /**
   * Extract a named field from JSON CLI output.
   * Tries multiple field names in order.
   *
   * @param stdout - Raw JSON CLI output
   * @param fields - Field names to try, in priority order
   * @returns The extracted string value
   * @throws Error if no field found
   */
  private extractField(stdout: string, ...fields: ReadonlyArray<string>): string {
    const trimmed: string = stdout.trim();

    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (isJsonObject(parsed)) {
        for (const field of fields) {
          const val: string | undefined = getStringField(parsed, field);
          if (val !== undefined) {
            return val;
          }
        }

        // Check nested result object
        const resultObj: Record<string, unknown> | undefined = getNestedObject(parsed, "result");
        if (resultObj !== undefined) {
          for (const field of fields) {
            const val: string | undefined = getStringField(resultObj, field);
            if (val !== undefined) {
              return val;
            }
          }
        }
      }
    } catch {
      // Not JSON — fall through
    }

    throw new Error(
      `Could not extract ${fields.join("/")} from openclaw output: ${trimmed.slice(0, 200)}`,
    );
  }

}

// ── Internal Types ───────────────────────────────────────────────────

interface ThreadMessage {
  readonly id: string;
  readonly content: string;
  readonly timestamp: string;
  readonly isBot: boolean;
}
