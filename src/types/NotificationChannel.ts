import type {
  DiscordThreadId,
  DiscordMessageId,
  DiscordNotification,
  DiscordResponse,
} from "@pftypes/Discord.ts";

// ── Notification Channel Interface ───────────────────────────────────
// Abstraction over the notification delivery mechanism. Production uses
// OpenClawClient (Discord via OpenClaw HTTP API). Tests and non-Discord
// runs use NoopNotificationChannel.

export interface NotificationChannel {
  /**
   * Create a Discord forum thread for a pipeline run.
   *
   * @param pipelineId - The pipeline identifier
   * @param feature - Feature description (used as thread title)
   * @returns The created thread ID
   */
  readonly createThread: (
    pipelineId: string,
    feature: string,
  ) => Promise<DiscordThreadId>;

  /**
   * Send a notification to the pipeline's Discord thread.
   *
   * @param notification - The notification to send
   * @returns The sent message ID
   */
  readonly sendNotification: (
    notification: DiscordNotification,
  ) => Promise<DiscordMessageId>;

  /**
   * Wait for a user response in the thread after a given message.
   * Polls until a human reply arrives or the timeout expires.
   *
   * @param threadId - The thread to monitor
   * @param afterMessageId - Only consider messages after this ID
   * @param timeoutMs - Maximum wait time in milliseconds
   * @returns The user's response
   * @throws Error if timeout expires with no response
   */
  readonly waitForResponse: (
    threadId: DiscordThreadId,
    afterMessageId: DiscordMessageId,
    timeoutMs: number,
  ) => Promise<DiscordResponse>;

  /**
   * Send an informational update to the thread (no reply expected).
   *
   * @param threadId - The thread to send to
   * @param message - The update text
   */
  readonly sendUpdate: (
    threadId: DiscordThreadId,
    message: string,
  ) => Promise<void>;
}
