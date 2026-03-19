import type { InputChannel, UserInput } from "@pftypes/InputChannel.ts";
import type { NotificationRouter, NotificationPayload } from "@core/NotificationRouter.ts";
import type { DiscordMessageId } from "@pftypes/Discord.ts";

// ── Default Timeout ─────────────────────────────────────────────────

const DEFAULT_DISCORD_TIMEOUT_MS: number = 300_000;

// ── Discord Input Channel ───────────────────────────────────────────
// Wraps NotificationRouter.notify() + waitForResponse() into the
// InputChannel interface. Sends the question as a Discord notification
// and waits for a human reply in the thread.

export class DiscordInputChannel implements InputChannel {
  readonly source = "discord" as const;
  private readonly router: NotificationRouter;
  private readonly pipelineId: string;
  private readonly nodeId: string;
  private readonly timeoutMs: number;

  constructor(
    router: NotificationRouter,
    pipelineId: string,
    nodeId: string,
    timeoutMs: number = DEFAULT_DISCORD_TIMEOUT_MS,
  ) {
    this.router = router;
    this.pipelineId = pipelineId;
    this.nodeId = nodeId;
    this.timeoutMs = timeoutMs;
  }

  /**
   * Send the question to Discord and wait for a human reply.
   *
   * @param question - The question text to send
   * @returns The user's response from Discord
   */
  readonly prompt = async (question: string): Promise<UserInput> => {
    const payload: NotificationPayload = {
      type: "agent_question",
      pipelineId: this.pipelineId,
      nodeId: this.nodeId,
      nodeStatus: "awaiting_answer",
      output: question,
      gateDetails: null,
    };

    const messageId: DiscordMessageId = await this.router.notify(payload);

    const response = await this.router.waitForResponse(
      messageId,
      this.timeoutMs,
    );

    return {
      source: "discord",
      content: response.content,
      receivedAt: Date.now(),
    };
  };

  /**
   * No-op — Discord channel has no local resources to clean up.
   */
  readonly close = (): void => {
    // Nothing to clean up
  };
}
