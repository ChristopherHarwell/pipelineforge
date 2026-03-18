import type { NotificationChannel } from "@pftypes/NotificationChannel.ts";
import type {
  DiscordThreadId,
  DiscordMessageId,
  DiscordNotification,
  DiscordResponse,
} from "@pftypes/Discord.ts";
import { toThreadId, toMessageId } from "@pftypes/Discord.ts";

// ── Noop Notification Channel ────────────────────────────────────────
// Silent implementation for tests and when Discord is not enabled.
// Returns dummy branded IDs so the type system is satisfied without
// making any external calls.

export class NoopNotificationChannel implements NotificationChannel {
  readonly createThread = async (
    _pipelineId: string,
    _feature: string,
  ): Promise<DiscordThreadId> => {
    return toThreadId("noop-thread");
  };

  readonly sendNotification = async (
    _notification: DiscordNotification,
  ): Promise<DiscordMessageId> => {
    return toMessageId("noop-message");
  };

  readonly waitForResponse = async (
    _threadId: DiscordThreadId,
    _afterMessageId: DiscordMessageId,
    _timeoutMs: number,
  ): Promise<DiscordResponse> => {
    throw new Error(
      "NoopNotificationChannel cannot wait for responses — " +
      "Discord is not enabled. Use CLI resume instead.",
    );
  };

  readonly sendUpdate = async (
    _threadId: DiscordThreadId,
    _message: string,
  ): Promise<void> => {
    // Silent — no-op
  };
}
