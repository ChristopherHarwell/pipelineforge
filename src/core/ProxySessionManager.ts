import { execFile, spawn as spawnProcess } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import { PassThrough } from "node:stream";
import type { SpawnOptions } from "@pftypes/ExecutionBackend.ts";
import type { StreamingExecutionBackend, StreamingSessionHandle, StreamCompletionEvent } from "@pftypes/StreamingBackend.ts";
import type { ContainerResult } from "@pftypes/Pipeline.ts";
import type { SessionId, SessionCompletionResult } from "@pftypes/ProxySession.ts";
import { toSessionId } from "@pftypes/ProxySession.ts";
import type { PipelineLogger } from "@pftypes/Logger.ts";

const execFileAsync: typeof execFile.__promisify__ = promisify(execFile);

// ── Poll Config ─────────────────────────────────────────────────────

const DEFAULT_POLL_INTERVAL_MS: number = 5_000;
const OPENCLAW_CLI: string = "openclaw";

// ── Proxy Session Manager ───────────────────────────────────────────
// Implements ExecutionBackend by spawning OpenClaw sessions via the
// `openclaw` CLI subprocess. The CLI handles the WebSocket gateway
// protocol internally, avoiding the need to implement the cryptographic
// device identity handshake.
//
// Communication flow:
//   openclaw sessions spawn --agent <name> --message "<prompt>"  → sessionId
//   openclaw sessions history --session <id>                     → transcript
//   openclaw sessions list                                       → active sessions

export class ProxySessionManager implements StreamingExecutionBackend {
  readonly supportsStreaming: true = true;
  private readonly gatewayUrl: string;
  private readonly logger: PipelineLogger;
  private readonly pollIntervalMs: number;
  private readonly activeSessions: Map<string, SessionId> = new Map();
  private readonly activeProcesses: Map<string, ChildProcess> = new Map();

  constructor(
    gatewayUrl: string,
    logger: PipelineLogger,
    pollIntervalMs: number = DEFAULT_POLL_INTERVAL_MS,
  ) {
    this.gatewayUrl = gatewayUrl;
    this.logger = logger;
    this.pollIntervalMs = pollIntervalMs;
  }

  // ── ExecutionBackend Implementation ─────────────────────────────

  /**
   * Spawn an OpenClaw session for a blueprint node.
   * Shells out to `openclaw sessions spawn`, then polls `sessions history`
   * until the session completes or times out.
   *
   * @param options - Spawn configuration including node, blueprint, prompt
   * @returns Container result (stdout, stderr, exit code, duration)
   */
  readonly spawnContainer = async (options: SpawnOptions): Promise<ContainerResult> => {
    const { node, blueprint, prompt } = options;
    const agentName: string = node.id;
    const startTime: number = Date.now();
    const timeoutMs: number = blueprint.execution.timeout_minutes * 60 * 1000;

    this.logger.pipelineEvent(
      "info",
      `Spawning proxy session for ${agentName}...`,
    );

    // ── Spawn session via CLI ────────────────────────────────────
    const sessionId: SessionId = await this.spawnSession(agentName, prompt);
    this.activeSessions.set(node.id, sessionId);

    this.logger.pipelineEvent(
      "info",
      `Session ${String(sessionId)} spawned for ${agentName}`,
    );

    // ── Poll for completion ──────────────────────────────────────
    try {
      const completion: SessionCompletionResult = await this.pollUntilComplete(
        sessionId,
        timeoutMs,
        startTime,
      );

      this.activeSessions.delete(node.id);

      return {
        stdout: completion.output,
        stderr: "",
        exitCode: completion.exitCode,
        durationMs: completion.durationMs,
      };
    } catch (err: unknown) {
      this.activeSessions.delete(node.id);

      return {
        stdout: "",
        stderr: err instanceof Error ? err.message : "Unknown session error",
        exitCode: 124,
        durationMs: Date.now() - startTime,
      };
    }
  };

  /**
   * Kill all active sessions (cleanup on pipeline abort).
   */
  readonly killAll = async (): Promise<void> => {
    const kills: ReadonlyArray<Promise<void>> = Array.from(
      this.activeSessions.entries(),
    ).map(async ([_nodeId, sessionId]: [string, SessionId]): Promise<void> => {
      try {
        await execFileAsync(OPENCLAW_CLI, [
          "sessions",
          "stop",
          "--session",
          sessionId,
          "--gateway",
          this.gatewayUrl,
        ]);
      } catch {
        // Session may already be stopped
      }
    });

    await Promise.all(kills);
    this.activeSessions.clear();
  };

  // ── Streaming Session API ──────────────────────────────────────

  /**
   * Spawn a long-lived streaming session. Returns a handle with a
   * live output stream, message injection, and lifecycle control.
   * Uses `openclaw sessions stream` subprocess for real-time output.
   *
   * @param options - Spawn configuration including node, blueprint, prompt
   * @returns A streaming session handle
   */
  readonly spawnStreamingSession = async (
    options: SpawnOptions,
  ): Promise<StreamingSessionHandle> => {
    const { node, prompt } = options;
    const agentName: string = node.id;
    const startTime: number = Date.now();

    this.logger.pipelineEvent(
      "info",
      `Spawning streaming session for ${agentName}...`,
    );

    // Spawn session to get a session ID
    const sessionId: SessionId = await this.spawnSession(agentName, prompt);
    this.activeSessions.set(node.id, sessionId);

    this.logger.pipelineEvent(
      "info",
      `Streaming session ${String(sessionId)} spawned for ${agentName}`,
    );

    // Start long-lived stream subprocess
    const outputStream: PassThrough = new PassThrough();
    const outputChunks: Buffer[] = [];

    const child: ChildProcess = spawnProcess(OPENCLAW_CLI, [
      "sessions",
      "stream",
      "--session",
      sessionId,
      "--gateway",
      this.gatewayUrl,
    ]);

    this.activeProcesses.set(node.id, child);

    // Pipe stdout through PassThrough for consumers
    if (child.stdout !== null) {
      child.stdout.on("data", (chunk: Buffer): void => {
        outputChunks.push(chunk);
        outputStream.write(chunk);
      });
    }

    // Forward stderr to output stream as well
    if (child.stderr !== null) {
      child.stderr.on("data", (chunk: Buffer): void => {
        outputChunks.push(chunk);
        outputStream.write(chunk);
      });
    }

    // Build completion promise
    const completionPromise: Promise<StreamCompletionEvent> = new Promise<StreamCompletionEvent>(
      (resolve: (value: StreamCompletionEvent) => void): void => {
        child.on("close", (code: number | null): void => {
          outputStream.end();
          this.activeSessions.delete(node.id);
          this.activeProcesses.delete(node.id);

          resolve({
            type: "completion",
            exitCode: code ?? 1,
            fullOutput: Buffer.concat(outputChunks).toString("utf-8"),
            durationMs: Date.now() - startTime,
          });
        });
      },
    );

    const handle: StreamingSessionHandle = {
      sessionId,
      outputStream,
      sendMessage: async (message: string): Promise<void> => {
        await this.sendSessionMessage(sessionId, message);
      },
      waitForCompletion: (): Promise<StreamCompletionEvent> => completionPromise,
      kill: async (): Promise<void> => {
        child.kill("SIGTERM");
        try {
          await execFileAsync(OPENCLAW_CLI, [
            "sessions",
            "stop",
            "--session",
            sessionId,
            "--gateway",
            this.gatewayUrl,
          ]);
        } catch {
          // Session may already be stopped
        }
        this.activeSessions.delete(node.id);
        this.activeProcesses.delete(node.id);
      },
    };

    return handle;
  };

  /**
   * Send a message to an active session (answer injection).
   *
   * @param sessionId - The target session
   * @param message - The message to inject
   */
  readonly sendSessionMessage = async (
    sessionId: SessionId,
    message: string,
  ): Promise<void> => {
    await execFileAsync(OPENCLAW_CLI, [
      "sessions",
      "message",
      "--session",
      sessionId,
      "--message",
      message,
      "--gateway",
      this.gatewayUrl,
    ]);
  };

  // ── CLI Subprocess Helpers ──────────────────────────────────────

  /**
   * Spawn a new session via `openclaw sessions spawn`.
   *
   * @param agentName - The agent name (matches openclaw.json agent entry)
   * @param message - The prompt message to send
   * @returns The spawned session ID
   */
  private async spawnSession(
    agentName: string,
    message: string,
  ): Promise<SessionId> {
    const { stdout } = await execFileAsync(OPENCLAW_CLI, [
      "sessions",
      "spawn",
      "--agent",
      agentName,
      "--message",
      message,
      "--gateway",
      this.gatewayUrl,
    ]);

    const sessionId: string = this.extractSessionId(stdout);
    return toSessionId(sessionId);
  }

  /**
   * Poll `openclaw sessions history` until the session reaches a
   * terminal state (completed or failed) or the timeout expires.
   *
   * @param sessionId - The session to poll
   * @param timeoutMs - Maximum wait time
   * @param startTime - When the session was started (for duration calc)
   * @returns Session completion result
   * @throws Error if the timeout expires
   */
  private async pollUntilComplete(
    sessionId: SessionId,
    timeoutMs: number,
    startTime: number,
  ): Promise<SessionCompletionResult> {
    const deadline: number = startTime + timeoutMs;

    while (Date.now() < deadline) {
      const result: SessionCompletionResult | null =
        await this.checkSessionStatus(sessionId, startTime);

      if (result !== null) {
        return result;
      }

      await this.sleep(this.pollIntervalMs);
    }

    throw new Error(
      `Session ${String(sessionId)} timed out after ${String(timeoutMs / 1000)}s`,
    );
  }

  /**
   * Check the current status of a session via `openclaw sessions history`.
   * Returns null if the session is still running.
   *
   * @param sessionId - The session to check
   * @param startTime - When the session was started
   * @returns Completion result if terminal, null if still running
   */
  private async checkSessionStatus(
    sessionId: SessionId,
    startTime: number,
  ): Promise<SessionCompletionResult | null> {
    const { stdout } = await execFileAsync(OPENCLAW_CLI, [
      "sessions",
      "history",
      "--session",
      sessionId,
      "--format",
      "json",
      "--gateway",
      this.gatewayUrl,
    ]);

    const parsed: unknown = JSON.parse(stdout);

    if (
      parsed === null ||
      typeof parsed !== "object" ||
      !("status" in parsed)
    ) {
      return null;
    }

    const record: Record<string, unknown> = parsed as Record<string, unknown>;
    const status: unknown = record["status"];

    if (status === "running" || status === "pending") {
      return null;
    }

    // Extract output from the session transcript
    const output: string =
      typeof record["output"] === "string"
        ? record["output"]
        : typeof record["transcript"] === "string"
          ? record["transcript"]
          : JSON.stringify(record);

    const exitCode: number =
      status === "completed" ? 0 : 1;

    return {
      sessionId,
      status: status === "completed" ? "completed" : "failed",
      output,
      exitCode,
      durationMs: Date.now() - startTime,
    };
  }

  // ── Parsing Helpers ───────────────────────────────────────────────

  /**
   * Extract the session ID from `openclaw sessions spawn` stdout.
   * Expected formats:
   *   - Plain ID: "sess_abc123"
   *   - JSON: {"sessionId": "sess_abc123"}
   *   - Prefixed: "Session spawned: sess_abc123"
   *
   * @param stdout - Raw CLI output
   * @returns Extracted session ID string
   * @throws Error if no session ID can be extracted
   */
  private extractSessionId(stdout: string): string {
    const trimmed: string = stdout.trim();

    // Try JSON parse first
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (
        parsed !== null &&
        typeof parsed === "object" &&
        "sessionId" in parsed
      ) {
        const id: unknown = (parsed as Record<string, unknown>)["sessionId"];
        if (typeof id === "string") {
          return id;
        }
      }
    } catch {
      // Not JSON — try other formats
    }

    // Try "Session spawned: <id>" prefix
    const prefixMatch: RegExpMatchArray | null = trimmed.match(
      /session\s+(?:spawned|created|id)[:\s]+(\S+)/i,
    );
    if (prefixMatch !== null && prefixMatch[1] !== undefined) {
      return prefixMatch[1];
    }

    // Assume raw session ID
    if (trimmed.length > 0 && !trimmed.includes("\n")) {
      return trimmed;
    }

    throw new Error(
      `Could not extract session ID from openclaw output: ${trimmed.slice(0, 200)}`,
    );
  }

  private sleep(ms: number): Promise<void> {
    return new Promise<void>((resolve: () => void): void => {
      setTimeout(resolve, ms);
    });
  }
}
