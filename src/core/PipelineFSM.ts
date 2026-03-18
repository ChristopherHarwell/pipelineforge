// ── Pipeline State Machine ──────────────────────────────────────────
// Models the lifecycle of a pipeline as a finite state machine.
// Hex-encoded state IDs with typed transition map.

import type { PipelineStatus } from "@pftypes/Pipeline.ts";

// ── State encoding (2-bit hex) ──────────────────────────────────────

type PipelineStateId = 0x0 | 0x1 | 0x2 | 0x3;

const P_RUNNING: PipelineStateId   = 0x0;
const P_PAUSED: PipelineStateId    = 0x1;
const P_COMPLETED: PipelineStateId = 0x2;
const P_FAILED: PipelineStateId    = 0x3;

export { P_RUNNING, P_PAUSED, P_COMPLETED, P_FAILED };
export type { PipelineStateId };

// ── State name map ──────────────────────────────────────────────────

const PIPELINE_STATE_NAMES: readonly [
  PipelineStatus, PipelineStatus, PipelineStatus, PipelineStatus,
] = [
  "running",    // 0x0
  "paused",     // 0x1
  "completed",  // 0x2
  "failed",     // 0x3
];

const PIPELINE_STATE_IDS: ReadonlyMap<PipelineStatus, PipelineStateId> =
  new Map<PipelineStatus, PipelineStateId>([
    ["running",   P_RUNNING],
    ["paused",    P_PAUSED],
    ["completed", P_COMPLETED],
    ["failed",    P_FAILED],
  ]);

// ── Transition events ──────────────────────────────────────────────

type PipelineEvent =
  | "NODE_PAUSED"       // running → paused (a node hit a human gate)
  | "RESUME"            // paused → running (user resumed)
  | "ALL_PASSED"        // running → completed (all nodes passed)
  | "NODE_FAILED"       // running → failed (a node failed with no retry)
  | "RETRY"             // failed → running (retry failed nodes)
  | "ABORT";            // running | paused → failed (user aborted)

export type { PipelineEvent };

// ── Transition table ────────────────────────────────────────────────

type PipelineTransitionKey = `${PipelineStateId}:${PipelineEvent}`;

const PIPELINE_TRANSITIONS: ReadonlyMap<PipelineTransitionKey, PipelineStateId> =
  new Map<PipelineTransitionKey, PipelineStateId>([
    [`${P_RUNNING}:NODE_PAUSED`,  P_PAUSED],
    [`${P_RUNNING}:ALL_PASSED`,   P_COMPLETED],
    [`${P_RUNNING}:NODE_FAILED`,  P_FAILED],
    [`${P_RUNNING}:ABORT`,        P_FAILED],
    [`${P_PAUSED}:RESUME`,        P_RUNNING],
    [`${P_PAUSED}:ABORT`,         P_FAILED],
    [`${P_FAILED}:RETRY`,         P_RUNNING],
  ]);

// ── Terminal states ─────────────────────────────────────────────────

const PIPELINE_TERMINAL: ReadonlySet<PipelineStateId> = new Set<PipelineStateId>([
  P_COMPLETED,
  P_FAILED,
]);

// ── Pipeline FSM ────────────────────────────────────────────────────

export class PipelineFSM {
  private state: PipelineStateId;
  private readonly pipelineId: string;

  constructor(pipelineId: string, initialState: PipelineStateId = P_RUNNING) {
    this.pipelineId = pipelineId;
    this.state = initialState;
  }

  /**
   * Transition the pipeline FSM via an event.
   *
   * @param event - The pipeline event
   * @returns The new state ID
   * @throws Error if the transition is invalid
   */
  transition(event: PipelineEvent): PipelineStateId {
    const key: PipelineTransitionKey = `${this.state}:${event}`;
    const nextState: PipelineStateId | undefined =
      PIPELINE_TRANSITIONS.get(key);

    if (nextState === undefined) {
      throw new Error(
        `Invalid pipeline transition: "${this.pipelineId}" in state ` +
        `${PIPELINE_STATE_NAMES[this.state]} (0x${this.state.toString(16)}) ` +
        `cannot handle event ${event}`,
      );
    }

    this.state = nextState;
    return this.state;
  }

  /**
   * Check if a transition event is valid from the current state.
   */
  canTransition(event: PipelineEvent): boolean {
    const key: PipelineTransitionKey = `${this.state}:${event}`;
    return PIPELINE_TRANSITIONS.has(key);
  }

  /**
   * Get the current state ID.
   */
  getState(): PipelineStateId {
    return this.state;
  }

  /**
   * Get the current state name as a PipelineStatus string.
   */
  getStateName(): PipelineStatus {
    return PIPELINE_STATE_NAMES[this.state];
  }

  /**
   * Check if the pipeline is in a terminal state.
   */
  isTerminal(): boolean {
    return PIPELINE_TERMINAL.has(this.state);
  }
}

// ── Factory: create from PipelineStatus string ──────────────────────

export function createPipelineFSM(
  pipelineId: string,
  status: PipelineStatus,
): PipelineFSM {
  const stateId: PipelineStateId | undefined = PIPELINE_STATE_IDS.get(status);
  if (stateId === undefined) {
    throw new Error(`Unknown PipelineStatus: ${status}`);
  }
  return new PipelineFSM(pipelineId, stateId);
}

// ── Compile-time assertions ─────────────────────────────────────────
// Moved to tests/types/PipelineFSM.typetest.ts to avoid noUnusedLocals errors.
// Run: npx tsc --project tsconfig.typetest.json
