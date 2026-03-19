import { createInterface, type Interface } from "node:readline";
import type { InputChannel, UserInput } from "@pftypes/InputChannel.ts";

// ── CLI Input Channel ──────────────────────────────────────────────
// Reads user input from process.stdin via readline. The prompt()
// method displays the question and resolves when the user enters a
// line of text.

export class CliInputChannel implements InputChannel {
  readonly source = "cli" as const;
  private rl: Interface | null = null;

  /**
   * Prompt the user via CLI stdin and wait for a line of input.
   *
   * @param question - The question text to display
   * @returns The user's response
   */
  readonly prompt = (question: string): Promise<UserInput> => {
    return new Promise<UserInput>((resolve: (value: UserInput) => void): void => {
      if (this.rl === null) {
        this.rl = createInterface({
          input: process.stdin,
          output: process.stdout,
        });
      }

      const formattedPrompt: string =
        `\n  ╔══ Agent Question ════════════════════════════════════╗\n` +
        `  ║ ${question.slice(0, 52).padEnd(52)} ║\n` +
        `  ╚════════════════════════════════════════════════════════╝\n` +
        `  Your answer: `;

      this.rl.question(formattedPrompt, (answer: string): void => {
        resolve({
          source: "cli",
          content: answer.trim(),
          receivedAt: Date.now(),
        });
      });
    });
  };

  /**
   * Close the readline interface and release stdin.
   */
  readonly close = (): void => {
    if (this.rl !== null) {
      this.rl.close();
      this.rl = null;
    }
  };
}
