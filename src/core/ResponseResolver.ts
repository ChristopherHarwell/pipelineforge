import { deepFreeze } from "@utils/deepfreeze.ts";
import type { DeepReadonly } from "@utils/deepfreeze.ts";
import type { ResponseAction, DiscordResponse } from "@pftypes/Discord.ts";
import type { NodeStatus } from "@pftypes/Pipeline.ts";
import type { TransitionEvent } from "@core/NodeFSM.ts";

// ── Resolved Response ────────────────────────────────────────────────

export interface ResolvedResponse {
  readonly action: ResponseAction;
  readonly content: string;
  readonly fsmEvent: TransitionEvent;
}

// ── Approval Patterns ────────────────────────────────────────────────

const APPROVE_PATTERNS: ReadonlyArray<RegExp> = deepFreeze([
  /^(?:approve[d]?|yes|lgtm|looks good|ship it|👍|✅)$/i,
]);

const REJECT_PATTERN: RegExp = /^(?:reject(?:ed)?|no|nack|👎|❌)(?:\s+(.*))?$/i;

// ── State → Event Mapping ────────────────────────────────────────────

const APPROVE_EVENT_MAP: ReadonlyMap<NodeStatus, TransitionEvent> = new Map<NodeStatus, TransitionEvent>([
  ["awaiting_human", "HUMAN_APPROVED"],
  ["awaiting_proposal_review", "PROPOSAL_APPROVED"],
  ["awaiting_implementation_review", "IMPL_APPROVED"],
  ["awaiting_answer", "ANSWER_RECEIVED"],
]);

const REJECT_EVENT_MAP: ReadonlyMap<NodeStatus, TransitionEvent> = new Map<NodeStatus, TransitionEvent>([
  ["awaiting_human", "HUMAN_REJECTED"],
  ["awaiting_proposal_review", "PROPOSAL_REJECTED"],
  ["awaiting_implementation_review", "IMPL_REJECTED"],
]);

// ── Response Resolver ────────────────────────────────────────────────
// Maps free-text Discord replies to FSM transition events based on
// the current node state. Handles approve/reject/answer actions.

export class ResponseResolver {
  /**
   * Parse a Discord response and resolve it to an FSM event.
   *
   * @param response - The Discord response from the user
   * @param nodeStatus - The current FSM state of the node
   * @returns Resolved response with action, content, and FSM event
   * @throws Error if the response action is invalid for the node state
   */
  resolve(
    response: DiscordResponse,
    nodeStatus: NodeStatus,
  ): DeepReadonly<ResolvedResponse> {
    const action: ResponseAction = this.parseAction(response.content);
    const content: string = this.parseContent(response.content, action);
    const fsmEvent: TransitionEvent = this.mapToFSMEvent(action, nodeStatus);

    return deepFreeze({ action, content, fsmEvent });
  }

  /**
   * Parse the user's intent from their Discord message.
   *
   * @param text - Raw message text
   * @returns The detected action
   */
  private parseAction(text: string): ResponseAction {
    const trimmed: string = text.trim();

    const isApproval: boolean = APPROVE_PATTERNS.some(
      (pattern: RegExp): boolean => pattern.test(trimmed),
    );
    if (isApproval) {
      return "approve";
    }

    const isRejection: boolean = REJECT_PATTERN.test(trimmed);
    if (isRejection) {
      return "reject";
    }

    return "answer";
  }

  /**
   * Extract the meaningful content from the response.
   * For rejections, strips the "reject" prefix to get the reason.
   *
   * @param text - Raw message text
   * @param action - The parsed action
   * @returns Extracted content
   */
  private parseContent(text: string, action: ResponseAction): string {
    if (action === "reject") {
      const match: RegExpMatchArray | null = text.trim().match(REJECT_PATTERN);
      const reason: string | undefined = match?.[1];
      return reason !== undefined ? reason.trim() : "";
    }

    if (action === "approve") {
      return "";
    }

    return text.trim();
  }

  /**
   * Map a response action to the correct FSM transition event
   * based on the current node state.
   *
   * @param action - The parsed action
   * @param nodeStatus - The current node status
   * @returns The FSM transition event
   * @throws Error if the action is invalid for the state
   */
  private mapToFSMEvent(
    action: ResponseAction,
    nodeStatus: NodeStatus,
  ): TransitionEvent {
    if (action === "approve" || action === "answer") {
      const event: TransitionEvent | undefined = APPROVE_EVENT_MAP.get(nodeStatus);
      if (event === undefined) {
        throw new Error(
          `Cannot apply "${action}" to node in state "${nodeStatus}"`,
        );
      }
      return event;
    }

    // action === "reject"
    const event: TransitionEvent | undefined = REJECT_EVENT_MAP.get(nodeStatus);
    if (event === undefined) {
      throw new Error(
        `Cannot apply "reject" to node in state "${nodeStatus}"`,
      );
    }
    return event;
  }
}
