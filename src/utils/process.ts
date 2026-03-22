import { execFile } from "node:child_process";
import { promisify } from "node:util";

// ── Process Utilities ───────────────────────────────────────────────

export const execFileAsync: typeof execFile.__promisify__ = promisify(execFile);

/**
 * Delay execution for the specified number of milliseconds.
 *
 * @param ms - Delay duration in milliseconds
 * @returns A promise that resolves after the delay
 */
export function sleep(ms: number): Promise<void> {
  return new Promise<void>((resolve: () => void): void => {
    setTimeout(resolve, ms);
  });
}
