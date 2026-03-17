// ── Compile-time assertions for PipelineFSM ─────────────────────────

import type { PipelineStateId } from "../../src/core/PipelineFSM.js";
import {
  P_RUNNING,
  P_PAUSED,
  P_COMPLETED,
  P_FAILED,
} from "../../src/core/PipelineFSM.js";

type Assert<T extends true> = T;
type Equal<A, B> = [A] extends [B] ? [B] extends [A] ? true : false : false;

type _p0 = Assert<Equal<typeof P_RUNNING, 0x0>>;
type _p1 = Assert<Equal<typeof P_PAUSED, 0x1>>;
type _p2 = Assert<Equal<typeof P_COMPLETED, 0x2>>;
type _p3 = Assert<Equal<typeof P_FAILED, 0x3>>;

type _pAll = Assert<Equal<PipelineStateId, 0x0 | 0x1 | 0x2 | 0x3>>;

// @ts-expect-error — RUNNING is 0x0, not 0x1
type _bad = Assert<Equal<typeof P_RUNNING, 0x1>>;
