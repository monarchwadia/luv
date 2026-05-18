import * as luv from "luv-js";
import * as mw from "luv-js/middleware";

const EXPECT = {
  "luv-js": ["send", "sendStream", "tool", "openaiProvider", "parseArguments", "pendingToolCalls", "respondToToolCall"],
  "luv-js/middleware": ["trace", "meter", "retry", "rateLimit", "fallbackChain"],
};
const missing = [];
for (const k of EXPECT["luv-js"]) if (typeof luv[k] !== "function") missing.push("luv-js." + k);
for (const k of EXPECT["luv-js/middleware"]) if (typeof mw[k] !== "function") missing.push("luv-js/middleware." + k);
const result = { ok: missing.length === 0, missing };
window.__LUV_RESULT__ = result;
document.body.textContent = result.ok ? "OK" : "FAIL: " + missing.join(", ");
