import type { DeepReadonly } from "../utils/deepfreeze.js";
import type { NotificationChannel } from "../types/NotificationChannel.js";
import type {
  DiscordThreadId,
  DiscordMessageId,
  DiscordNotification,
  DiscordResponse,
  NotificationType,
} from "../types/Discord.js";
import type { NodeStatus } from "../types/Pipeline.js";
import type { PipelineLogger } from "../types/Logger.js";

// ── Discord Character Limit ──────────────────────────────────────────

const DISCORD_MAX_CHARS: number = 1900;

// ── Notification Payload ─────────────────────────────────────────────

export interface NotificationPayload {
  readonly type: NotificationType;
  readonly pipelineId: string;
  readonly nodeId: string;
  readonly nodeStatus: NodeStatus;
  readonly output: string | null;
  readonly gateDetails: string | null;
}

// ── Notification Router ──────────────────────────────────────────────
// Formats pause events into Discord notifications and routes them
// through the NotificationChannel. Always logs to stdout via the
// PipelineLogger regardless of whether Discord is enabled.

export class NotificationRouter {
  private readonly channel: NotificationChannel;
  private readonly logger: PipelineLogger;
  private threadId: DiscordThreadId | null;

  constructor(
    channel: NotificationChannel,
    logger: PipelineLogger,
    threadId: DiscordThreadId | null,
  ) {
    this.channel = channel;
    this.logger = logger;
    this.threadId = threadId;
  }

  /**
   * Ensure a Discord thread exists for this pipeline.
   * Creates one if threadId is null.
   *
   * @param pipelineId - Pipeline identifier
   * @param feature - Feature description for the thread title
   * @returns The thread ID
   */
  async ensureThread(
    pipelineId: string,
    feature: string,
  ): Promise<DiscordThreadId> {
    if (this.threadId !== null) {
      return this.threadId;
    }
    const threadId: DiscordThreadId = await this.channel.createThread(
      pipelineId,
      feature,
    );
    this.threadId = threadId;
    return threadId;
  }

  /**
   * Get the current thread ID.
   */
  getThreadId(): DiscordThreadId | null {
    return this.threadId;
  }

  /**
   * Route a notification to both Discord and stdout.
   * Formats the notification based on type, sends to Discord,
   * and logs to the console.
   *
   * @param payload - The notification data
   * @returns The sent message ID (for tracking replies)
   */
  async notify(payload: NotificationPayload): Promise<DiscordMessageId> {
    const notification: DiscordNotification = this.formatNotification(payload);

    // Always log to stdout
    this.logger.pipelineEvent(
      "info",
      `[${notification.type}] ${notification.title}\n${notification.body}`,
    );

    // Send to Discord
    const messageId: DiscordMessageId = await this.channel.sendNotification(
      notification,
    );

    return messageId;
  }

  /**
   * Wait for a response from Discord.
   *
   * @param afterMessageId - Only consider messages after this ID
   * @param timeoutMs - Maximum wait time
   * @returns The user's response
   */
  async waitForResponse(
    afterMessageId: DiscordMessageId,
    timeoutMs: number,
  ): Promise<DiscordResponse> {
    if (this.threadId === null) {
      throw new Error("No thread created — cannot wait for response");
    }
    return this.channel.waitForResponse(
      this.threadId,
      afterMessageId,
      timeoutMs,
    );
  }

  /**
   * Send an informational update (no reply expected).
   *
   * @param message - The update text
   */
  async sendUpdate(message: string): Promise<void> {
    this.logger.pipelineEvent("info", message);

    if (this.threadId !== null) {
      await this.channel.sendUpdate(this.threadId, message);
    }
  }

  // ── Formatting ───────────────────────────────────────────────────

  private formatNotification(
    payload: NotificationPayload,
  ): DiscordNotification {
    const title: string = this.formatTitle(payload);
    const body: string = this.formatBody(payload);

    return {
      type: payload.type,
      pipelineId: payload.pipelineId,
      nodeId: payload.nodeId,
      title,
      body,
      expectsReply: payload.type !== "pipeline_update",
    };
  }

  private formatTitle(payload: NotificationPayload): string {
    switch (payload.type) {
      case "agent_question":
        return `❓ Agent \`${payload.nodeId}\` has a question`;
      case "human_gate":
        return `🚪 Human gate: \`${payload.nodeId}\` awaiting approval`;
      case "proposal_review":
        return `📋 Proposal review: \`${payload.nodeId}\``;
      case "implementation_review":
        return `🔍 Implementation review: \`${payload.nodeId}\``;
      case "pipeline_update":
        return `ℹ️ Pipeline update: \`${payload.nodeId}\``;
    }
  }

  private formatBody(payload: NotificationPayload): string {
    const parts: string[] = [];

    if (payload.output !== null) {
      const truncated: string = this.truncate(payload.output);
      parts.push(truncated);
    }

    if (payload.gateDetails !== null) {
      parts.push(`**Gate:** ${payload.gateDetails}`);
    }

    // Add action hints based on type
    switch (payload.type) {
      case "agent_question":
        parts.push("\n_Reply with your answer._");
        break;
      case "human_gate":
      case "proposal_review":
      case "implementation_review":
        parts.push("\n_Reply `approve` or `reject [reason]`._");
        break;
      case "pipeline_update":
        break;
    }

    return parts.join("\n\n");
  }

  private truncate(text: string): string {
    if (text.length <= DISCORD_MAX_CHARS) {
      return text;
    }
    const truncated: string = text.slice(0, DISCORD_MAX_CHARS - 20);
    return `${truncated}\n\n…(truncated)`;
  }
}
