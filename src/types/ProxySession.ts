// ── Branded Session ID ──────────────────────────────────────────────

export type SessionId = string & { readonly __brand: "SessionId" };

export function toSessionId(id: string): SessionId {
  return id as SessionId;
}

// ── Session Status ──────────────────────────────────────────────────

export type SessionStatus = "running" | "completed" | "failed" | "timeout";

// ── Session Completion Result ───────────────────────────────────────
// Returned by `openclaw sessions history` after a session finishes.

export interface SessionCompletionResult {
  readonly sessionId: SessionId;
  readonly status: SessionStatus;
  readonly output: string;
  readonly exitCode: number;
  readonly durationMs: number;
}

// ── Proxy Container Config ──────────────────────────────────────────
// Configuration for the OpenClaw proxy Docker container.

export interface ProxyContainerConfig {
  readonly pipelineId: string;
  readonly containerName: string;
  readonly openclawImage: string;
  readonly gatewayPort: number;
  readonly anthropicApiKey: string;
  readonly configPath: string;
  readonly repoDir: string;
  readonly notesDir: string;
  readonly stateDir: string;
  readonly claudeDir: string;
  readonly dockerSocketPath: string;
}

// ── OpenClaw Agent Config ───────────────────────────────────────────
// Represents a single agent entry in openclaw.json.

export interface OpenClawAgentConfig {
  readonly name: string;
  readonly model: string;
  readonly instructions: string;
  readonly tools: ReadonlyArray<string>;
  readonly disallowedTools?: ReadonlyArray<string>;
  readonly maxTurns: number;
  readonly sandbox: {
    readonly docker: {
      readonly image: string;
      readonly mounts: ReadonlyArray<string>;
      readonly workingDir: string;
    };
  };
}

// ── OpenClaw Gateway Config ─────────────────────────────────────────
// Top-level openclaw.json structure mounted into the proxy container.

export interface OpenClawGatewayConfig {
  readonly agents: {
    readonly list: ReadonlyArray<OpenClawAgentConfig>;
  };
  readonly sandbox: {
    readonly docker: {
      readonly enabled: boolean;
    };
  };
  readonly maxConcurrent: number;
  readonly discord?: {
    readonly enabled: boolean;
    readonly channelId: string;
  };
}
