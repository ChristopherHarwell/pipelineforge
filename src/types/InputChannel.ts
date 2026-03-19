// ── Input Source ────────────────────────────────────────────────────
// Branded union identifying the origin of a user response.

export type InputSource = "cli" | "discord";

// ── User Input ─────────────────────────────────────────────────────
// A response received from any input channel.

export interface UserInput {
  readonly source: InputSource;
  readonly content: string;
  readonly receivedAt: number;
}

// ── Input Channel ──────────────────────────────────────────────────
// Abstraction over a single input source (CLI stdin or Discord).
// Used by InputRacer to race multiple channels in parallel.

export interface InputChannel {
  readonly source: InputSource;

  /**
   * Prompt the user with a question and wait for their response.
   *
   * @param question - The question text to display
   * @returns The user's response
   */
  readonly prompt: (question: string) => Promise<UserInput>;

  /**
   * Clean up resources (close readline, cancel pending timers, etc.).
   */
  readonly close: () => void;
}
