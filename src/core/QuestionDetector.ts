import { deepFreeze } from "@utils/deepfreeze.ts";
import type { DeepReadonly } from "@utils/deepfreeze.ts";

// ── Detection Result ─────────────────────────────────────────────────

export interface QuestionDetectionResult {
  readonly detected: boolean;
  readonly questions: ReadonlyArray<string>;
  readonly confidence: number;
}

// ── Question Patterns ────────────────────────────────────────────────
// Regex patterns that indicate an agent is asking the user a question
// rather than producing a final result.

const QUESTION_LINE_PATTERN: RegExp = /\?[\s]*$/;

const QUESTION_PREFIX_PATTERNS: ReadonlyArray<RegExp> = deepFreeze([
  /^(?:\d+\.\s*)?(?:\*{1,2})?(?:what|which|how|should|would|do you|can you|could you|please specify|please provide|please choose|please select)/i,
  /^(?:\d+\.\s*)?(?:\*{1,2})?(?:i need|i have a question|before i proceed|i need clarification|let me know|tell me)/i,
  /^(?:\d+\.\s*)?(?:\*{1,2})?(?:is this|are there|are you|will this|does this|did you)/i,
]);

// ── Confidence Thresholds ────────────────────────────────────────────
// bits[1:0] → question line weight  bits[3:2] → prefix match weight
const QUESTION_LINE_WEIGHT: number = 0.3;
const PREFIX_MATCH_WEIGHT: number = 0.5;
const MULTI_QUESTION_BONUS: number = 0.2;
const CONFIDENCE_THRESHOLD: number = 0.5;

// ── Question Detector ────────────────────────────────────────────────
// Scans agent container output for question patterns to determine
// whether the agent is asking the user for input.

export class QuestionDetector {
  /**
   * Detect questions in agent output text.
   *
   * @param output - The raw agent output (extracted result text)
   * @returns Detection result with confidence score and extracted questions
   */
  detect(output: string): DeepReadonly<QuestionDetectionResult> {
    const lines: ReadonlyArray<string> = output.split("\n");
    const questions: string[] = [];
    let confidence: number = 0;

    for (const line of lines) {
      const trimmed: string = line.trim();
      if (trimmed.length === 0) {
        continue;
      }

      const isQuestionLine: boolean = QUESTION_LINE_PATTERN.test(trimmed);
      const hasPrefixMatch: boolean = QUESTION_PREFIX_PATTERNS.some(
        (pattern: RegExp): boolean => pattern.test(trimmed),
      );

      if (isQuestionLine) {
        questions.push(trimmed);
        confidence += QUESTION_LINE_WEIGHT;
      }

      if (hasPrefixMatch && isQuestionLine) {
        confidence += PREFIX_MATCH_WEIGHT;
      }
    }

    if (questions.length > 1) {
      confidence += MULTI_QUESTION_BONUS;
    }

    // Cap confidence at 1.0
    const finalConfidence: number = Math.min(confidence, 1.0);
    const detected: boolean = finalConfidence >= CONFIDENCE_THRESHOLD;

    return deepFreeze({
      detected,
      questions,
      confidence: finalConfidence,
    });
  }
}
