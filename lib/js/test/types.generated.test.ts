// B2 — locks that the generated Role/StopReason/Usage are re-exported from
// types.ts with the historical shapes (zero interface change). The real type
// gate is `tsc` (build:types); this is an additive runtime sanity check.
import { test, expect } from "bun:test";
import type { Role, StopReason, Usage } from "../src/types.ts";

const role: Role = "assistant";
const stop: StopReason = "end_turn";
const usage: Usage = { promptTokens: 1, completionTokens: 2, totalTokens: 3 };

test("generated Role/StopReason/Usage re-exported with prior shapes", () => {
  expect(role).toBe("assistant");
  expect(stop).toBe("end_turn");
  expect(usage.promptTokens + usage.completionTokens + usage.totalTokens).toBe(6);
});
