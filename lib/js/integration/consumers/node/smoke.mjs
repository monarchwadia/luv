import * as luv from "luv-js";
import * as mw from "luv-js/middleware";
import * as mcp from "luv-js/mcp";
import { runChecks } from "../../checks.mjs";

const missing = runChecks({ luv, mw, mcp });
if (missing.length) {
  console.error("FAIL missing exports:", missing.join(", "));
  process.exit(1);
}
console.log("OK node");
