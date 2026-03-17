// ── Console Logger ──────────────────────────────────────────────────
// Default PipelineLogger implementation that writes to stdout/stderr
// with node-prefixed lines and live container output streaming.

import type { Readable } from "node:stream";
import { createInterface, type Interface } from "node:readline";
import type {
  PipelineLogger,
  LogLevel,
  NodeLogEvent,
} from "../types/Logger.js";

// ── Node Status Icons ──────────────────────────────────────────────

const LEVEL_PREFIX: Readonly<Record<LogLevel, string>> = {
  info:  "  ",
  warn:  "  ",
  error: "  ",
  debug: "  ",
};

const NODE_ICONS: Readonly<Record<string, string>> = {
  dispatch:  "▶",
  passed:    "✓",
  failed:    "✗",
  skipped:   "─",
  paused:    "⏸",
  streaming: "│",
};

// ── Console Logger ─────────────────────────────────────────────────

export class ConsoleLogger implements PipelineLogger {
  nodeEvent(
    level: LogLevel,
    event: NodeLogEvent,
    message: string,
  ): void {
    const prefix: string = LEVEL_PREFIX[level];
    const timestamp: string = new Date().toISOString().slice(11, 19);
    const line: string =
      `${prefix}[${timestamp}] ${event.nodeId}: ${message}`;

    if (level === "error") {
      process.stderr.write(`${line}\n`);
    } else {
      process.stdout.write(`${line}\n`);
    }
  }

  pipelineEvent(level: LogLevel, message: string): void {
    const prefix: string = LEVEL_PREFIX[level];
    const timestamp: string = new Date().toISOString().slice(11, 19);
    const line: string = `${prefix}[${timestamp}] ${message}`;

    if (level === "error") {
      process.stderr.write(`${line}\n`);
    } else {
      process.stdout.write(`${line}\n`);
    }
  }

  streamContainerOutput(
    nodeId: string,
    stream: Readable,
  ): void {
    const icon: string = NODE_ICONS["streaming"] ?? "│";
    const rl: Interface = createInterface({ input: stream });

    rl.on("line", (line: string): void => {
      process.stdout.write(`  ${icon} ${nodeId}: ${line}\n`);
    });
  }
}
