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
// Implements ExecutionBackend by spawning OpenClaw agent sessions via
// the `openclaw` CLI subprocess. The CLI handles the WebSocket gateway
// protocol internally, avoiding the need to implement the cryptographic
// device identity handshake.
//
// Communication flow:
//   openclaw agent --agent <name> -m "<prompt>" --json  → session + output
//   openclaw agent --session-id <id> -m "<text>" --json → follow-up message
//   openclaw sessions --agent <name> --json             → session list + status

export class ProxySessionManager implements StreamingExecutionBackend {
  readonly supportsStreaming: true = true;
  private readonly logger: PipelineLogger;
  private readonly pollIntervalMs: number;
  private readonly activeSessions: Map<string, SessionId> = new Map();
  private readonly activeProcesses: Map<string, ChildProcess> = new Map();

  constructor(
    _gatewayUrl: string,
    logger: PipelineLogger,
    pollIntervalMs: number = DEFAULT_POLL_INTERVAL_MS,
  ) {
    // gatewayUrl is accepted for API compatibility but not used —
    // the openclaw CLI reads gateway config from ~/.openclaw/openclaw.json
    this.logger = logger;
    this.pollIntervalMs = pollIntervalMs;
  }

  // ── ExecutionBackend Implementation ─────────────────────────────

  /**
   * Spawn an OpenClaw agent session for a blueprint node.
   * Shells out to `openclaw agent`, then polls session status
   * until the session completes or times out.
   *
   * @param options - Spawn configuration including node, blueprint, prompt
   * @returns Container result (stdout, stderr, exit code, duration)
   */
  readonly spawnContainer = async (options: SpawnOptions): Promise<ContainerResult> => {
    const { node, blueprint, prompt } = options;
    const agentName: string = node.blueprint;
    const startTime: number = Date.now();
    const timeoutMs: number = blueprint.execution.timeout_minutes * 60 * 1000;

    this.logger.pipelineEvent(
      "info",
      `Spawning proxy session for ${agentName}...`,
    );

    // ── Spawn session via CLI ────────────────────────────────────
    const sessionId: SessionId = await this.spawnAgentSession(agentName, prompt);
    this.activeSessions.set(node.id, sessionId);

    this.logger.pipelineEvent(
      "info",
      `Session ${String(sessionId)} spawned for ${agentName}`,
    );

    // ── Poll for completion ──────────────────────────────────────
    try {
      const completion: SessionCompletionResult = await this.pollUntilComplete(
        sessionId,
        agentName,
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
   * OpenClaw sessions are cleaned up via the sandbox recreate command.
   */
  readonly killAll = async (): Promise<void> => {
    const kills: ReadonlyArray<Promise<void>> = Array.from(
      this.activeSessions.entries(),
    ).map(async ([_nodeId, _sessionId]: [string, SessionId]): Promise<void> => {
      // OpenClaw manages session lifecycle through the gateway;
      // sandbox containers are cleaned up when the gateway stops.
    });

    await Promise.all(kills);
    this.activeSessions.clear();

    // Kill any streaming subprocesses
    for (const [nodeId, child] of this.activeProcesses.entries()) {
      child.kill("SIGTERM");
      this.activeProcesses.delete(nodeId);
    }
  };

  // ── Streaming Session API ──────────────────────────────────────

  /**
   * Spawn a long-lived streaming session. Returns a handle with a
   * live output stream, message injection, and lifecycle control.
   * Uses `openclaw agent` subprocess with streaming output.
   *
   * @param options - Spawn configuration including node, blueprint, prompt
   * @returns A streaming session handle
   */
  readonly spawnStreamingSession = async (
    options: SpawnOptions,
  ): Promise<StreamingSessionHandle> => {
    const { node, prompt } = options;
    const agentName: string = node.blueprint;
    const startTime: number = Date.now();

    this.logger.pipelineEvent(
      "info",
      `Spawning streaming session for ${agentName}...`,
    );

    // Spawn agent as a long-lived subprocess for real-time output
    const outputStream: PassThrough = new PassThrough();
    const outputChunks: Buffer[] = [];

    const child: ChildProcess = spawnProcess(OPENCLAW_CLI, [
      "agent",
      "--agent",
      agentName,
      "-m",
      prompt,
      "--json",
    ]);

    this.activeProcesses.set(node.id, child);

    // Extract session ID from early JSON output or generate a synthetic one
    const sessionId: SessionId = toSessionId(`pf-${agentName}-${Date.now()}`);
    this.activeSessions.set(node.id, sessionId);

    this.logger.pipelineEvent(
      "info",
      `Streaming session ${String(sessionId)} spawned for ${agentName}`,
    );

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
        this.activeSessions.delete(node.id);
        this.activeProcesses.delete(node.id);
      },
    };

    return handle;
  };

  /**
   * Send a follow-up message to an active session (answer injection).
   *
   * @param sessionId - The target session
   * @param message - The message to inject
   */
  readonly sendSessionMessage = async (
    sessionId: SessionId,
    message: string,
  ): Promise<void> => {
    await execFileAsync(OPENCLAW_CLI, [
      "agent",
      "--session-id",
      sessionId,
      "-m",
      message,
      "--json",
    ]);
  };

  // ── CLI Subprocess Helpers ──────────────────────────────────────

  /**
   * Spawn a new agent session via `openclaw agent`.
   *
   * @param agentName - The agent name (matches openclaw config agent entry)
   * @param message - The prompt message to send
   * @returns The spawned session ID
   */
  private async spawnAgentSession(
    agentName: string,
    message: string,
  ): Promise<SessionId> {
    const { stdout } = await execFileAsync(OPENCLAW_CLI, [
      "agent",
      "--agent",
      agentName,
      "-m",
      message,
      "--json",
    ]);

    const sessionId: string = this.extractSessionId(stdout);
    return toSessionId(sessionId);
  }

  /**
   * Poll session status until the session reaches a terminal state
   * (completed or failed) or the timeout expires.
   *
   * @param sessionId - The session to poll
   * @param agentName - The agent owning the session
   * @param timeoutMs - Maximum wait time
   * @param startTime - When the session was started (for duration calc)
   * @returns Session completion result
   * @throws Error if the timeout expires
   */
  private async pollUntilComplete(
    sessionId: SessionId,
    agentName: string,
    timeoutMs: number,
    startTime: number,
  ): Promise<SessionCompletionResult> {
    const deadline: number = startTime + timeoutMs;

    while (Date.now() < deadline) {
      const result: SessionCompletionResult | null =
        await this.checkSessionStatus(sessionId, agentName, startTime);

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
   * Check the current status of a session via `openclaw sessions`.
   * Returns null if the session is still running.
   *
   * @param sessionId - The session to check
   * @param agentName - The agent owning the session
   * @param startTime - When the session was started
   * @returns Completion result if terminal, null if still running
   */
  private async checkSessionStatus(
    sessionId: SessionId,
    agentName: string,
    startTime: number,
  ): Promise<SessionCompletionResult | null> {
    const { stdout } = await execFileAsync(OPENCLAW_CLI, [
      "sessions",
      "--agent",
      agentName,
      "--json",
    ]);

    // Parse session list and find our session
    const parsed: unknown = JSON.parse(stdout);

    if (!Array.isArray(parsed)) {
      // Single session object
      return this.parseSessionResult(parsed, sessionId, startTime);
    }

    // Array of sessions — find ours
    const sessions: ReadonlyArray<unknown> = parsed as ReadonlyArray<unknown>;
    for (const session of sessions) {
      if (
        session !== null &&
        typeof session === "object" &&
        "id" in session &&
        (session as Record<string, unknown>)["id"] === String(sessionId)
      ) {
        return this.parseSessionResult(session, sessionId, startTime);
      }

      // Also check sessionId field
      if (
        session !== null &&
        typeof session === "object" &&
        "sessionId" in session &&
        (session as Record<string, unknown>)["sessionId"] === String(sessionId)
      ) {
        return this.parseSessionResult(session, sessionId, startTime);
      }
    }

    // Session not found in list — may still be initializing
    return null;
  }

  /**
   * Parse a session record into a completion result.
   * Returns null if the session is still running.
   */
  private parseSessionResult(
    record: unknown,
    sessionId: SessionId,
    startTime: number,
  ): SessionCompletionResult | null {
    if (record === null || typeof record !== "object" || !("status" in record)) {
      return null;
    }

    const obj: Record<string, unknown> = record as Record<string, unknown>;
    const status: unknown = obj["status"];

    if (status === "running" || status === "pending" || status === "active") {
      return null;
    }

    // Extract output from the session transcript
    const output: string =
      typeof obj["output"] === "string"
        ? obj["output"]
        : typeof obj["transcript"] === "string"
          ? obj["transcript"]
          : typeof obj["result"] === "string"
            ? obj["result"]
            : JSON.stringify(obj);

    const exitCode: number =
      status === "completed" || status === "done" ? 0 : 1;

    return {
      sessionId,
      status: exitCode === 0 ? "completed" : "failed",
      output,
      exitCode,
      durationMs: Date.now() - startTime,
    };
  }

  // ── Parsing Helpers ───────────────────────────────────────────────

  /**
   * Extract the session ID from `openclaw agent` JSON output.
   * Expected formats:
   *   - JSON: {"sessionId": "sess_abc123", ...}
   *   - JSON: {"id": "sess_abc123", ...}
   *   - JSON: {"session": {"id": "sess_abc123"}, ...}
   *   - Prefixed: "Session: sess_abc123"
   *   - Plain ID: "sess_abc123"
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
      if (parsed !== null && typeof parsed === "object") {
        const obj: Record<string, unknown> = parsed as Record<string, unknown>;

        // Direct sessionId field
        if (typeof obj["sessionId"] === "string") {
          return obj["sessionId"];
        }

        // Direct id field
        if (typeof obj["id"] === "string") {
          return obj["id"];
        }

        // Nested session.id
        if (
          obj["session"] !== null &&
          typeof obj["session"] === "object" &&
          "id" in (obj["session"] as Record<string, unknown>)
        ) {
          const sessionObj: Record<string, unknown> = obj["session"] as Record<string, unknown>;
          if (typeof sessionObj["id"] === "string") {
            return sessionObj["id"];
          }
        }

        // session_id field
        if (typeof obj["session_id"] === "string") {
          return obj["session_id"];
        }
      }
    } catch {
      // Not JSON — try other formats
    }

    // Try "Session: <id>" or "Session spawned: <id>" prefix
    const prefixMatch: RegExpMatchArray | null = trimmed.match(
      /session\s*(?:spawned|created|id)?[:\s]+(\S+)/i,
    );
    if (prefixMatch !== null && prefixMatch[1] !== undefined) {
      return prefixMatch[1];
    }

    // Assume raw session ID if single line
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
