// Produce a single-file ESM bundle of luv suitable for direct
// <script type="module"> consumption in a browser. Output goes to
// examples/claw-browser/luv.js.
//
// We use absolute paths inside the entry so Bun's bundler treats the
// imports as in-tree (not as external package references).

import { writeFileSync } from "node:fs";
import { join } from "node:path";

const SRC = join(import.meta.dir, "..", "src");
const OUT = join(
  import.meta.dir,
  "..",
  "..",
  "..",
  "examples",
  "claw-browser",
  "luv.js",
);

const entry = `
export * from "${SRC}/index.ts";
export * from "${SRC}/transport/openai_chat.ts";
export * from "${SRC}/transport/anthropic_messages.ts";
`;

const tmpEntry = join(import.meta.dir, ".bundle-entry.ts");
writeFileSync(tmpEntry, entry);

const result = await Bun.build({
  entrypoints: [tmpEntry],
  target: "browser",
  format: "esm",
  minify: false,
});

if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}

const output = await result.outputs[0].text();
writeFileSync(OUT, output);

// Clean up temp entry
import { unlinkSync } from "node:fs";
unlinkSync(tmpEntry);

console.log(`wrote ${OUT}`);
console.log(`size: ${(output.length / 1024).toFixed(2)} KB`);
