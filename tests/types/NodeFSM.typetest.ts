// ── Compile-time transition verification ────────────────────────────
// If this file compiles, all assertions pass. Incorrect types → compile error.

import type { StateId } from "../../src/core/NodeFSM.js";
import {
  PENDING,
  READY,
  RUNNING,
  DRY_RUN_COMPLETE,
  AWAITING_PROPOSAL_REVIEW,
  IMPLEMENTING,
  AWAITING_IMPLEMENTATION_REVIEW,
  PASSED,
  FAILED,
  SKIPPED,
  AWAITING_HUMAN,
} from "../../src/core/NodeFSM.js";

type Assert<T extends true> = T;
type Equal<A, B> = [A] extends [B] ? [B] extends [A] ? true : false : false;

// ── Verify state ID encoding ────────────────────────────────────────

type _v0 = Assert<Equal<typeof PENDING, 0x0>>;
type _v1 = Assert<Equal<typeof READY, 0x1>>;
type _v2 = Assert<Equal<typeof RUNNING, 0x2>>;
type _v3 = Assert<Equal<typeof DRY_RUN_COMPLETE, 0x3>>;
type _v4 = Assert<Equal<typeof AWAITING_PROPOSAL_REVIEW, 0x4>>;
type _v5 = Assert<Equal<typeof IMPLEMENTING, 0x5>>;
type _v6 = Assert<Equal<typeof AWAITING_IMPLEMENTATION_REVIEW, 0x6>>;
type _v7 = Assert<Equal<typeof PASSED, 0x7>>;
type _v8 = Assert<Equal<typeof FAILED, 0x8>>;
type _v9 = Assert<Equal<typeof SKIPPED, 0x9>>;
type _vA = Assert<Equal<typeof AWAITING_HUMAN, 0xA>>;

// ── Verify StateId is a proper union ────────────────────────────────

type _allStates = Assert<
  Equal<
    StateId,
    0x0 | 0x1 | 0x2 | 0x3 | 0x4 | 0x5 | 0x6 | 0x7 | 0x8 | 0x9 | 0xA
  >
>;

// ── Negative tests ──────────────────────────────────────────────────

// @ts-expect-error — PENDING is 0x0, not 0x1
type _bad1 = Assert<Equal<typeof PENDING, 0x1>>;
// @ts-expect-error — PASSED is 0x7, not 0x8
type _bad2 = Assert<Equal<typeof PASSED, 0x8>>;
