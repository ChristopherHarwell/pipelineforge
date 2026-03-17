// ── Pipeline Logger ─────────────────────────────────────────────────
// Abstraction for pipeline execution logging. Injected into DagExecutor
// and DockerManager to decouple core logic from output concerns.

import type { Readable } from "node:stream";

// ── Log Event Types ────────────────────────────────────────────────

export type LogLevel = "info" | "warn" | "error" | "debug";

export interface NodeLogEvent {
  readonly nodeId: string;
  readonly blueprint: string;
  readonly instance: number;
}

// ── Pipeline Logger Interface ──────────────────────────────────────

export interface PipelineLogger {
  /**
   * Log a node lifecycle event (dispatch, gate result, completion).
   *
   * @param level - Log severity
   * @param event - Node metadata
   * @param message - Human-readable message
   */
  readonly nodeEvent: (
    level: LogLevel,
    event: NodeLogEvent,
    message: string,
  ) => void;

  /**
   * Log a pipeline-level event (start, pause, resume, complete, fail).
   *
   * @param level - Log severity
   * @param message - Human-readable message
   */
  readonly pipelineEvent: (level: LogLevel, message: string) => void;

  /**
   * Attach to a live container output stream and forward to the user.
   * Returns when the stream ends.
   *
   * @param nodeId - The node whose container is streaming
   * @param stream - Readable stream from Docker container logs
   */
  readonly streamContainerOutput: (
    nodeId: string,
    stream: Readable,
  ) => void;
}
