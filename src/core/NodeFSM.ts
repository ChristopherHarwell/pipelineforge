// ── Node State Machine ──────────────────────────────────────────────
// Models the lifecycle of a DAG node as a finite state machine.
// Inspired by the traffic light FSM pattern: hex-encoded state IDs,
// typed transition map, and compile-time transition verification.

// ── State encoding (4-bit hex) ──────────────────────────────────────

type StateId =
  | 0x0 | 0x1 | 0x2 | 0x3 | 0x4
  | 0x5 | 0x6 | 0x7 | 0x8 | 0x9
  | 0xA | 0xB;

const PENDING: StateId                      = 0x0;
const READY: StateId                        = 0x1;
const RUNNING: StateId                      = 0x2;
const DRY_RUN_COMPLETE: StateId             = 0x3;
const AWAITING_PROPOSAL_REVIEW: StateId     = 0x4;
const IMPLEMENTING: StateId                 = 0x5;
const AWAITING_IMPLEMENTATION_REVIEW: StateId = 0x6;
const PASSED: StateId                       = 0x7;
const FAILED: StateId                       = 0x8;
const SKIPPED: StateId                      = 0x9;
const AWAITING_HUMAN: StateId               = 0xA;
const AWAITING_ANSWER: StateId              = 0xB;

export {
  PENDING,
  READY,
  RUNNING,
  DRY_RUN_COMPLETE,
  AWAITING_PROPOSAL_REVIEW,
  IMPLEMENTING,
  AWAITING_IMPLEMENTATION_REVIEW,
  PASSED,
  FAILED,
  SKIPPED,
  AWAITING_HUMAN,
  AWAITING_ANSWER,
};

export type { StateId };

// ── State name map ──────────────────────────────────────────────────

import type { NodeStatus } from "../types/Pipeline.js";

const STATE_NAMES: readonly [
  NodeStatus, NodeStatus, NodeStatus, NodeStatus, NodeStatus,
  NodeStatus, NodeStatus, NodeStatus, NodeStatus, NodeStatus,
  NodeStatus, NodeStatus,
] = [
  "pending",                       // 0x0
  "ready",                         // 0x1
  "running",                       // 0x2
  "dry_run_complete",              // 0x3
  "awaiting_proposal_review",      // 0x4
  "implementing",                  // 0x5
  "awaiting_implementation_review", // 0x6
  "passed",                        // 0x7
  "failed",                        // 0x8
  "skipped",                       // 0x9
  "awaiting_human",                // 0xA
  "awaiting_answer",               // 0xB
];

const STATE_IDS: ReadonlyMap<NodeStatus, StateId> = new Map<NodeStatus, StateId>([
  ["pending",                       PENDING],
  ["ready",                         READY],
  ["running",                       RUNNING],
  ["dry_run_complete",              DRY_RUN_COMPLETE],
  ["awaiting_proposal_review",      AWAITING_PROPOSAL_REVIEW],
  ["implementing",                  IMPLEMENTING],
  ["awaiting_implementation_review", AWAITING_IMPLEMENTATION_REVIEW],
  ["passed",                        PASSED],
  ["failed",                        FAILED],
  ["skipped",                       SKIPPED],
  ["awaiting_human",                AWAITING_HUMAN],
  ["awaiting_answer",               AWAITING_ANSWER],
]);

// ── Transition event types ──────────────────────────────────────────
// Each event triggers a specific state transition. The FSM validates
// that the current state allows the requested event.

type TransitionEvent =
  | "DEPS_SATISFIED"         // pending → ready
  | "DISPATCH"               // ready → running
  | "DRY_RUN_DONE"           // running → dry_run_complete (review mode)
  | "PRESENT_PROPOSAL"       // dry_run_complete → awaiting_proposal_review
  | "PROPOSAL_APPROVED"      // awaiting_proposal_review → implementing
  | "PROPOSAL_REJECTED"      // awaiting_proposal_review → running (retry)
  | "IMPLEMENTATION_DONE"    // implementing → awaiting_implementation_review
  | "IMPL_APPROVED"          // awaiting_implementation_review → passed
  | "IMPL_REJECTED"          // awaiting_implementation_review → running (retry)
  | "GATE_PASSED"            // running → passed (standard path)
  | "GATE_FAILED"            // running → failed
  | "HUMAN_GATE"             // running → awaiting_human
  | "HUMAN_APPROVED"         // awaiting_human → passed
  | "HUMAN_REJECTED"         // awaiting_human → failed
  | "AGENT_QUESTION"         // running → awaiting_answer (agent asked a question)
  | "ANSWER_RECEIVED"        // awaiting_answer → running (user answered)
  | "RETRY"                  // failed → pending (retry after transient failure)
  | "SKIP";                  // any → skipped

export type { TransitionEvent };

// ── Transition table ────────────────────────────────────────────────
// Maps (currentState, event) → nextState.
// Invalid transitions are not in the table and will throw at runtime.

type TransitionKey = `${StateId}:${TransitionEvent}`;

const TRANSITIONS: ReadonlyMap<TransitionKey, StateId> = new Map<TransitionKey, StateId>([
  // ── Standard lifecycle ────────────────────────────────────────────
  [`${PENDING}:DEPS_SATISFIED`,                     READY],
  [`${READY}:DISPATCH`,                             RUNNING],

  // ── Standard path (no review mode) ────────────────────────────────
  [`${RUNNING}:GATE_PASSED`,                        PASSED],
  [`${RUNNING}:GATE_FAILED`,                        FAILED],
  [`${RUNNING}:HUMAN_GATE`,                         AWAITING_HUMAN],

  // ── Human gate resolution ─────────────────────────────────────────
  [`${AWAITING_HUMAN}:HUMAN_APPROVED`,              PASSED],
  [`${AWAITING_HUMAN}:HUMAN_REJECTED`,              FAILED],

  // ── Review mode path ──────────────────────────────────────────────
  [`${RUNNING}:DRY_RUN_DONE`,                       DRY_RUN_COMPLETE],
  [`${DRY_RUN_COMPLETE}:PRESENT_PROPOSAL`,          AWAITING_PROPOSAL_REVIEW],
  [`${AWAITING_PROPOSAL_REVIEW}:PROPOSAL_APPROVED`, IMPLEMENTING],
  [`${AWAITING_PROPOSAL_REVIEW}:PROPOSAL_REJECTED`, RUNNING],
  [`${IMPLEMENTING}:IMPLEMENTATION_DONE`,           AWAITING_IMPLEMENTATION_REVIEW],
  [`${AWAITING_IMPLEMENTATION_REVIEW}:IMPL_APPROVED`, PASSED],
  [`${AWAITING_IMPLEMENTATION_REVIEW}:IMPL_REJECTED`, RUNNING],

  // ── Agent question path ────────────────────────────────────────────
  [`${RUNNING}:AGENT_QUESTION`,                      AWAITING_ANSWER],
  [`${AWAITING_ANSWER}:ANSWER_RECEIVED`,             RUNNING],

  // ── Retry (from failed state) ──────────────────────────────────────
  [`${FAILED}:RETRY`,                                PENDING],

  // ── Skip (from any non-terminal state) ────────────────────────────
  [`${PENDING}:SKIP`,                               SKIPPED],
  [`${READY}:SKIP`,                                 SKIPPED],
  [`${RUNNING}:SKIP`,                               SKIPPED],
  [`${DRY_RUN_COMPLETE}:SKIP`,                      SKIPPED],
  [`${AWAITING_PROPOSAL_REVIEW}:SKIP`,              SKIPPED],
  [`${IMPLEMENTING}:SKIP`,                          SKIPPED],
  [`${AWAITING_IMPLEMENTATION_REVIEW}:SKIP`,        SKIPPED],
  [`${AWAITING_HUMAN}:SKIP`,                        SKIPPED],
  [`${AWAITING_ANSWER}:SKIP`,                       SKIPPED],
]);

// ── Terminal state check ────────────────────────────────────────────

const TERMINAL_STATES: ReadonlySet<StateId> = new Set<StateId>([
  PASSED,
  FAILED,
  SKIPPED,
]);

// ── Pause states (pipeline pauses for human input) ──────────────────

const PAUSE_STATES: ReadonlySet<StateId> = new Set<StateId>([
  AWAITING_PROPOSAL_REVIEW,
  AWAITING_IMPLEMENTATION_REVIEW,
  AWAITING_HUMAN,
  AWAITING_ANSWER,
]);

// ── Node FSM ────────────────────────────────────────────────────────

export class NodeFSM {
  private state: StateId;
  private readonly nodeId: string;

  constructor(nodeId: string, initialState: StateId = PENDING) {
    this.nodeId = nodeId;
    this.state = initialState;
  }

  /**
   * Transition the FSM to the next state via an event.
   * Throws if the transition is invalid for the current state.
   *
   * @param event - The transition event
   * @returns The new state ID
   * @throws Error if the transition is not defined
   */
  transition(event: TransitionEvent): StateId {
    const key: TransitionKey = `${this.state}:${event}`;
    const nextState: StateId | undefined = TRANSITIONS.get(key);

    if (nextState === undefined) {
      throw new Error(
        `Invalid transition: node "${this.nodeId}" in state ` +
        `${STATE_NAMES[this.state]} (0x${this.state.toString(16)}) ` +
        `cannot handle event ${event}`,
      );
    }

    this.state = nextState;
    return this.state;
  }

  /**
   * Check if a transition event is valid from the current state.
   *
   * @param event - The transition event to check
   * @returns true if the transition is defined
   */
  canTransition(event: TransitionEvent): boolean {
    const key: TransitionKey = `${this.state}:${event}`;
    return TRANSITIONS.has(key);
  }

  /**
   * Get the current state ID.
   */
  getState(): StateId {
    return this.state;
  }

  /**
   * Get the current state name as a NodeStatus string.
   */
  getStateName(): NodeStatus {
    return STATE_NAMES[this.state];
  }

  /**
   * Check if the FSM is in a terminal state (passed, failed, skipped).
   */
  isTerminal(): boolean {
    return TERMINAL_STATES.has(this.state);
  }

  /**
   * Check if the FSM is in a pause state (awaiting human input).
   */
  isPaused(): boolean {
    return PAUSE_STATES.has(this.state);
  }

  /**
   * Get the node ID.
   */
  getNodeId(): string {
    return this.nodeId;
  }
}

// ── Factory: create from NodeStatus string ──────────────────────────

/**
 * Create a NodeFSM from a NodeStatus string (e.g., when resuming from persisted state).
 *
 * @param nodeId - The DAG node ID
 * @param status - The current NodeStatus string
 * @returns A NodeFSM initialized to the given state
 * @throws Error if the status string is not a valid NodeStatus
 */
export function createNodeFSM(nodeId: string, status: NodeStatus): NodeFSM {
  const stateId: StateId | undefined = STATE_IDS.get(status);
  if (stateId === undefined) {
    throw new Error(`Unknown NodeStatus: ${status}`);
  }
  return new NodeFSM(nodeId, stateId);
}

// ── Compile-time transition verification ────────────────────────────
// Moved to tests/types/NodeFSM.typetest.ts to avoid noUnusedLocals errors.
// Run: npx tsc --project tsconfig.typetest.json
