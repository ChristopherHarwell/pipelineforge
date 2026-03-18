import { z } from "zod";
import type { DeepReadonly } from "@utils/deepfreeze.ts";

// ── Branded IDs ──────────────────────────────────────────────────────

export type DiscordChannelId = string & { readonly __brand: "DiscordChannelId" };
export type DiscordThreadId = string & { readonly __brand: "DiscordThreadId" };
export type DiscordMessageId = string & { readonly __brand: "DiscordMessageId" };

export function toChannelId(id: string): DiscordChannelId {
  return id as DiscordChannelId;
}

export function toThreadId(id: string): DiscordThreadId {
  return id as DiscordThreadId;
}

export function toMessageId(id: string): DiscordMessageId {
  return id as DiscordMessageId;
}

// ── OpenClaw Config Schema ───────────────────────────────────────────

export const OpenClawConfigSchema: z.ZodObject<{
  readonly gateway_url: z.ZodDefault<z.ZodString>;
  readonly bearer_token: z.ZodString;
  readonly forum_channel_id: z.ZodString;
  readonly poll_timeout_ms: z.ZodDefault<z.ZodNumber>;
  readonly poll_interval_ms: z.ZodDefault<z.ZodNumber>;
}> = z.object({
  gateway_url: z.string().url().default("http://127.0.0.1:18789"),
  bearer_token: z.string().min(1),
  forum_channel_id: z.string().min(1),
  poll_timeout_ms: z.number().positive().default(300_000),
  poll_interval_ms: z.number().positive().default(3_000),
});

export type OpenClawConfig = DeepReadonly<z.infer<typeof OpenClawConfigSchema>>;

// ── Notification Types ───────────────────────────────────────────────

export type NotificationType =
  | "agent_question"
  | "human_gate"
  | "proposal_review"
  | "implementation_review"
  | "pipeline_update";

export interface DiscordNotification {
  readonly type: NotificationType;
  readonly pipelineId: string;
  readonly nodeId: string;
  readonly threadId: DiscordThreadId;
  readonly title: string;
  readonly body: string;
  readonly expectsReply: boolean;
}

// ── Response Types ───────────────────────────────────────────────────

export type ResponseAction = "approve" | "reject" | "answer";

export interface DiscordResponse {
  readonly messageId: DiscordMessageId;
  readonly action: ResponseAction;
  readonly content: string;
  readonly respondedAt: string;
}

// ── Thread Tracking ──────────────────────────────────────────────────

export interface PipelineThread {
  readonly pipelineId: string;
  readonly threadId: DiscordThreadId;
  readonly channelId: DiscordChannelId;
  readonly createdAt: string;
}
