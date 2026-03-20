import { createInterface, type Interface } from "node:readline";
import type { InputChannel, UserInput } from "@pftypes/InputChannel.ts";

// ── CLI Input Channel ──────────────────────────────────────────────
// Reads user input from process.stdin via readline. The prompt()
// method displays the question and resolves when the user enters a
// line of text.

// Box interior width — fits comfortably in an 80-column terminal
const BOX_WIDTH: number = 52;

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

      // Word-wrap the question into lines that fit the box,
      // preserving newlines from the original text.
      const wrappedLines: ReadonlyArray<string> =
        CliInputChannel.wrapText(question, BOX_WIDTH);

      const bodyLines: string = wrappedLines
        .map((line: string): string => `  ║ ${line.padEnd(BOX_WIDTH)} ║`)
        .join("\n");

      const border: string = "═".repeat(BOX_WIDTH + 2);

      const formattedPrompt: string =
        `\n  ╔═ Agent Question ${border.slice(18)}╗\n` +
        `${bodyLines}\n` +
        `  ╚${border}╝\n` +
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

  // ── Word Wrap ──────────────────────────────────────────────────────
  // Splits text into lines of at most `width` characters. Respects
  // existing newlines and breaks on word boundaries when possible.

  /**
   * Word-wrap text to fit within a fixed column width.
   * Preserves explicit newlines from the source text and breaks
   * long words with a hard split when no space is available.
   *
   * @param text - The text to wrap
   * @param width - Maximum characters per line
   * @returns Array of wrapped lines
   */
  static wrapText(text: string, width: number): ReadonlyArray<string> {
    const output: string[] = [];

    // Split on explicit newlines first to preserve paragraph structure
    const paragraphs: ReadonlyArray<string> = text.split("\n");

    for (const paragraph of paragraphs) {
      // Empty line — preserve as a blank row in the box
      if (paragraph.trim().length === 0) {
        output.push("");
        continue;
      }

      let remaining: string = paragraph;

      while (remaining.length > 0) {
        // Line fits — push and done
        if (remaining.length <= width) {
          output.push(remaining);
          break;
        }

        // Find the last space within the width limit for a clean break
        // ES2023: findLastIndex would work on a char array, but
        // lastIndexOf on a substring is simpler here
        const breakAt: number = remaining.lastIndexOf(" ", width);

        if (breakAt > 0) {
          // Clean word break
          output.push(remaining.slice(0, breakAt));
          remaining = remaining.slice(breakAt + 1);
        } else {
          // No space found — hard-break the long word
          output.push(remaining.slice(0, width));
          remaining = remaining.slice(width);
        }
      }
    }

    return output;
  }
}
