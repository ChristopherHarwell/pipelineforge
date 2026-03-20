import { execFile } from "node:child_process";
import { promisify } from "node:util";
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

const execFileAsync: typeof execFile.__promisify__ = promisify(execFile);

// ── Constants ────────────────────────────────────────────────────────

const OPENCLAW_CLI: string = "openclaw";

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
      : (parsed !== null && typeof parsed === "object" && "messages" in parsed)
        ? (parsed as Record<string, unknown>)["messages"]
        : null;

    if (!Array.isArray(rawMessages)) {
      return [];
    }

    const messages: ThreadMessage[] = [];

    for (const msg of rawMessages) {
      if (msg === null || typeof msg !== "object") {
        continue;
      }

      const obj: Record<string, unknown> = msg as Record<string, unknown>;

      const id: unknown = obj["id"] ?? obj["messageId"];
      const content: unknown = obj["content"] ?? obj["text"] ?? obj["body"];
      const timestamp: unknown = obj["timestamp"] ?? obj["createdAt"] ?? obj["date"];
      const isBot: unknown = obj["isBot"] ?? obj["bot"] ?? obj["fromBot"];

      if (typeof id === "string" && typeof content === "string") {
        messages.push({
          id,
          content,
          timestamp: typeof timestamp === "string" ? timestamp : new Date().toISOString(),
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
      if (parsed !== null && typeof parsed === "object") {
        const obj: Record<string, unknown> = parsed as Record<string, unknown>;

        for (const field of fields) {
          if (typeof obj[field] === "string") {
            return obj[field];
          }
        }

        // Check nested result object
        if (
          obj["result"] !== null &&
          typeof obj["result"] === "object"
        ) {
          const result: Record<string, unknown> = obj["result"] as Record<string, unknown>;
          for (const field of fields) {
            if (typeof result[field] === "string") {
              return result[field];
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

  private sleep(ms: number): Promise<void> {
    return new Promise<void>((resolve: () => void): void => {
      setTimeout(resolve, ms);
    });
  }
}

// ── Internal Types ───────────────────────────────────────────────────

interface ThreadMessage {
  readonly id: string;
  readonly content: string;
  readonly timestamp: string;
  readonly isBot: boolean;
}
