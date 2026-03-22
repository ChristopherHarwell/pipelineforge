import { spawn as spawnProcess } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { PassThrough } from "node:stream";
import type { SpawnOptions } from "@pftypes/ExecutionBackend.ts";
import type { StreamingExecutionBackend, StreamingSessionHandle, StreamCompletionEvent } from "@pftypes/StreamingBackend.ts";
import type { ContainerResult } from "@pftypes/Pipeline.ts";
import type { SessionId, SessionCompletionResult } from "@pftypes/ProxySession.ts";
import { toSessionId } from "@pftypes/ProxySession.ts";
import type { PipelineLogger } from "@pftypes/Logger.ts";
import type { VoidPromise } from "@pftypes/TypeUtils.ts";
import type { DockerAgentConfig } from "@core/OpenClawAgentRegistrar.ts";
import { execFileAsync, sleep } from "@utils/process.ts";
import { OPENCLAW_CLI, collectClaudeAuthEnv } from "@utils/openclaw-constants.ts";
import { isJsonObject, getStringField, getNestedObject } from "@utils/json-guards.ts";

// ── Poll Config ─────────────────────────────────────────────────────

const DEFAULT_POLL_INTERVAL_MS: number = 5_000;

// ── Proxy Session Manager ───────────────────────────────────────────
// Implements ExecutionBackend by spawning OpenClaw agent sessions.
// When a DockerAgentConfig is provided, each `openclaw agent` call
// runs inside a `docker run` container with proper volume mounts
// (notes, repo, state, claude credentials, openclaw config).
// When no docker config is given, agents run directly on the host.

export class ProxySessionManager implements StreamingExecutionBackend {
  readonly supportsStreaming: true = true;
  private readonly logger: PipelineLogger;
  private readonly pollIntervalMs: number;
  private readonly dockerConfig: DockerAgentConfig | null;
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

    // ── Run agent via CLI (optionally inside Docker) ─────────────
    // `openclaw agent --json` is a blocking command — it runs the
    // full agent and returns a completion JSON. When dockerConfig is
    // set, the command runs inside a container with proper mounts.
    const [cmd, cmdArgs] = this.buildCommand([
      "agent",
      "--agent",
      agentName,
      "-m",
      prompt,
      "--json",
    ]);
    const { stdout } = await execFileAsync(cmd, [...cmdArgs], { timeout: timeoutMs });

    const durationMs: number = Date.now() - startTime;

    // ── Check for immediate completion ───────────────────────────
    // ES2022: Object.hasOwn() — safe prototype-free property check
    const immediateResult: ContainerResult | null =
      ProxySessionManager.tryParseCompletedResult(stdout, durationMs);

    if (immediateResult !== null) {
      this.logger.pipelineEvent(
        "info",
        `Agent ${agentName} completed immediately (${String(durationMs)}ms)`,
      );
      return immediateResult;
    }

    // ── Fall through: extract session ID and poll ────────────────
    // Some openclaw configurations return a session handle for
    // long-running agents that run asynchronously on the gateway.
    const sessionId: SessionId = toSessionId(this.extractSessionId(stdout));
    this.activeSessions.set(node.id, sessionId);

    this.logger.pipelineEvent(
      "info",
      `Session ${String(sessionId)} spawned for ${agentName}`,
    );

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
  readonly killAll = async (): VoidPromise => {
    const kills: ReadonlyArray<VoidPromise> = Array.from(
      this.activeSessions.entries(),
    ).map(async ([_nodeId, _sessionId]: [string, SessionId]): VoidPromise => {
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

    // ES2024: Promise.withResolvers() — cleaner than wrapping in
    // `new Promise()`. Returns { promise, resolve, reject } so you
    // can resolve from outside the constructor callback.
    const { promise: completionPromise, resolve: resolveCompletion } =
      Promise.withResolvers<StreamCompletionEvent>();

    child.on("close", (code: number | null): void => {
      outputStream.end();
      this.activeSessions.delete(node.id);
      this.activeProcesses.delete(node.id);

      resolveCompletion({
        type: "completion",
        exitCode: code ?? 1,
        fullOutput: Buffer.concat(outputChunks).toString("utf-8"),
        durationMs: Date.now() - startTime,
      });
    });

    // ES2025: Symbol.asyncDispose — the kill() logic runs automatically
    // when the handle leaves an `await using` scope. Manual kill() is
    // still available for explicit cleanup outside `await using`.
    const killFn: () => VoidPromise = async (): VoidPromise => {
      child.kill("SIGTERM");
      this.activeSessions.delete(node.id);
      this.activeProcesses.delete(node.id);
    };

    const handle: StreamingSessionHandle = {
      sessionId,
      outputStream,
      sendMessage: async (message: string): Promise<string> => {
        return this.sendSessionMessage(sessionId, message);
      },
      waitForCompletion: (): Promise<StreamCompletionEvent> => completionPromise,
      kill: killFn,
      [Symbol.asyncDispose]: killFn,
    };

    return handle;
  };

  /**
   * Send a follow-up message to an active session (answer injection).
   *
   * @param sessionId - The target session
   * @param message - The message to inject
   * @returns The agent's response output (stdout from the subprocess)
   */
  readonly sendSessionMessage = async (
    sessionId: SessionId,
    message: string,
  ): Promise<string> => {
    const { stdout } = await execFileAsync(OPENCLAW_CLI, [
      "agent",
      "--session-id",
      sessionId,
      "-m",
      message,
      "--json",
    ]);
    const { stdout } = await execFileAsync(cmd, [...cmdArgs]);
    return stdout;
  };

  // ── CLI Subprocess Helpers ──────────────────────────────────────

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
      if (isJsonObject(session)) {
        const id: string | undefined = getStringField(session, "id");
        if (id === String(sessionId)) {
          return this.parseSessionResult(session, sessionId, startTime);
        }

        const sessId: string | undefined = getStringField(session, "sessionId");
        if (sessId === String(sessionId)) {
          return this.parseSessionResult(session, sessionId, startTime);
        }
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
    if (!isJsonObject(record) || !("status" in record)) {
      return null;
    }

    const status: unknown = record["status"];

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

  // ── Immediate Completion Detection ──────────────────────────────
  // `openclaw agent --json` blocks until the agent finishes. The
  // response is a full result JSON with `status`, `result.payloads`,
  // and `result.meta`. Detect this shape and return a ContainerResult
  // directly — no session ID extraction or polling needed.

  /**
   * Attempt to parse a completed agent result from raw CLI output.
   * Returns null if the output is not a completed result JSON.
   *
   * @param stdout - Raw CLI output from `openclaw agent --json`
   * @param durationMs - Elapsed time since the command was spawned
   * @returns ContainerResult if the response is a completed result, null otherwise
   */
  static tryParseCompletedResult(
    stdout: string,
    durationMs: number,
  ): ContainerResult | null {
    try {
      const parsed: unknown = JSON.parse(stdout.trim());

      if (!isJsonObject(parsed)) {
        return null;
      }

      // OpenClaw completion shape: { status: "ok", result: { payloads: [...] } }
      if (parsed["status"] !== "ok" && parsed["status"] !== "completed" && parsed["status"] !== "done") {
        return null;
      }

      // Must have a result or payloads — distinguishes completion
      // from a session-creation response
      if (!Object.hasOwn(parsed, "result") && !Object.hasOwn(parsed, "payloads")) {
        return null;
      }

      return {
        stdout,
        stderr: "",
        exitCode: 0,
        durationMs,
      };
    } catch {
      return null;
    }
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
      if (isJsonObject(parsed)) {
        // Direct sessionId field
        const sessionIdVal: string | undefined = getStringField(parsed, "sessionId");
        if (sessionIdVal !== undefined) {
          return sessionIdVal;
        }

        // Direct id field
        const idVal: string | undefined = getStringField(parsed, "id");
        if (idVal !== undefined) {
          return idVal;
        }

        // Nested session.id
        const sessionObj: Record<string, unknown> | undefined = getNestedObject(parsed, "session");
        if (sessionObj !== undefined) {
          const nestedId: string | undefined = getStringField(sessionObj, "id");
          if (nestedId !== undefined) {
            return nestedId;
          }
        }

        // session_id field
        const sessionUnderscoreId: string | undefined = getStringField(parsed, "session_id");
        if (sessionUnderscoreId !== undefined) {
          return sessionUnderscoreId;
        }

        // runId field (OpenClaw completion response)
        const runId: string | undefined = getStringField(parsed, "runId");
        if (runId !== undefined) {
          return runId;
        }

        // Nested result.meta.agentMeta.sessionId (OpenClaw completion)
        const nestedSessionId: string | undefined =
          ProxySessionManager.extractNestedSessionId(parsed);
        if (nestedSessionId !== undefined) {
          return nestedSessionId;
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

  /**
   * Walk into result.meta.agentMeta.sessionId — the nested path
   * where OpenClaw completion responses store the session identifier.
   *
   * @param obj - The parsed top-level JSON object
   * @returns The session ID string if found, undefined otherwise
   */
  private static extractNestedSessionId(
    obj: Record<string, unknown>,
  ): string | undefined {
    const result: Record<string, unknown> | undefined = getNestedObject(obj, "result");
    if (result === undefined) {
      return undefined;
    }

    const meta: Record<string, unknown> | undefined = getNestedObject(result, "meta");
    if (meta === undefined) {
      return undefined;
    }

    const agentMeta: Record<string, unknown> | undefined = getNestedObject(meta, "agentMeta");
    if (agentMeta === undefined) {
      return undefined;
    }

    return getStringField(agentMeta, "sessionId");
  }

}
