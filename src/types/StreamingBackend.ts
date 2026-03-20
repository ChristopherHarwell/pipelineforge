import type { Readable } from "node:stream";
import type { ExecutionBackend, SpawnOptions } from "@pftypes/ExecutionBackend.ts";
import type { SessionId } from "@pftypes/ProxySession.ts";
import type { VoidPromise } from "@pftypes/TypeUtils.ts";

// ── Stream Event Types ──────────────────────────────────────────────

export interface StreamLineEvent {
  readonly type: "line";
  readonly content: string;
  readonly timestamp: number;
}

export interface StreamCompletionEvent {
  readonly type: "completion";
  readonly exitCode: number;
  readonly fullOutput: string;
  readonly durationMs: number;
}

export type StreamEvent = StreamLineEvent | StreamCompletionEvent;

// ── Streaming Session Handle ────────────────────────────────────────
// Returned by spawnStreamingSession(). Exposes a live output stream,
// message injection, and lifecycle control.
//
// Implements AsyncDisposable (ES2025) — use with `await using` for
// automatic cleanup when the handle leaves scope:
//
//   await using handle = await backend.spawnStreamingSession(opts);
//   // ... handle[Symbol.asyncDispose]() called automatically on scope exit

export interface StreamingSessionHandle extends AsyncDisposable {
  readonly sessionId: SessionId;
  readonly outputStream: Readable;
  readonly sendMessage: (message: string) => Promise<string>;
  readonly waitForCompletion: () => Promise<StreamCompletionEvent>;
  readonly kill: () => VoidPromise;
}

// ── Streaming Execution Backend ─────────────────────────────────────
// Extends ExecutionBackend with streaming session capabilities.
// ProxySessionManager implements this; DockerManager does not.

export interface StreamingExecutionBackend extends ExecutionBackend {
  readonly supportsStreaming: true;

  /**
   * Spawn a long-lived streaming session that exposes a live output
   * stream. The caller can read output line-by-line, detect questions,
   * and inject answers via sendMessage().
   *
   * @param options - Spawn configuration
   * @returns A handle for interacting with the live session
   */
  readonly spawnStreamingSession: (
    options: SpawnOptions,
  ) => Promise<StreamingSessionHandle>;

  /**
   * Send a message to an active session (answer injection).
   *
   * @param sessionId - The target session
   * @param message - The message to inject
   * @returns The agent's response text
   */
  readonly sendSessionMessage: (
    sessionId: SessionId,
    message: string,
  ) => Promise<string>;
}

// ── Type Guard ──────────────────────────────────────────────────────
// Runtime check for DagExecutor branching. Uses `supportsStreaming`
// property to distinguish streaming backends from batch backends.

export function isStreamingBackend(
  backend: ExecutionBackend,
): backend is StreamingExecutionBackend {
  return (
    "supportsStreaming" in backend &&
    (backend as StreamingExecutionBackend).supportsStreaming === true
  );
}
