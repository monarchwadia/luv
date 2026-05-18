// Shared smoke assertions. Environment-agnostic: callers pass the imported
// namespaces. Returns an array of missing-export descriptions ([] === pass).
export const EXPECT = {
  "luv-js": [
    "send",
    "sendStream",
    "tool",
    "openaiProvider",
    "parseArguments",
    "pendingToolCalls",
    "respondToToolCall",
  ],
  "luv-js/middleware": ["trace", "meter", "retry", "rateLimit", "fallbackChain"],
};

export function runChecks({ luv, mw }) {
  const missing = [];
  for (const k of EXPECT["luv-js"]) {
    if (typeof luv?.[k] !== "function") missing.push(`luv-js.${k}`);
  }
  for (const k of EXPECT["luv-js/middleware"]) {
    if (typeof mw?.[k] !== "function") missing.push(`luv-js/middleware.${k}`);
  }
  return missing;
}
