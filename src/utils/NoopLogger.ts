// ── Noop Logger ─────────────────────────────────────────────────────
// Silent PipelineLogger for testing and non-interactive contexts.

import type { Readable } from "node:stream";
import type {
  PipelineLogger,
  LogLevel,
  NodeLogEvent,
} from "@pftypes/Logger.ts";

export class NoopLogger implements PipelineLogger {
  nodeEvent(
    _level: LogLevel,
    _event: NodeLogEvent,
    _message: string,
  ): void {
    // Intentionally silent
  }

  pipelineEvent(_level: LogLevel, _message: string): void {
    // Intentionally silent
  }

  streamContainerOutput(
    _nodeId: string,
    _stream: Readable,
  ): void {
    // Intentionally silent
  }
}
