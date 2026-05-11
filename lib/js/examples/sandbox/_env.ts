// Side-effect import that locates the repo-root .env relative to this
// file (not CWD) and populates process.env, so sandbox scripts work
// whether you run them via `bun run sandbox <file>` or `bun <file>`
// from any directory.
//
// Each starter has `import "./_env.ts";` as its first import.

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
// sandbox/ → examples/ → js/ → lib/ → repo root
const envPath = join(here, "..", "..", "..", "..", ".env");

const file = Bun.file(envPath);
if (await file.exists()) {
  const text = await file.text();
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    // Don't override anything already in the environment.
    if (!(key in process.env)) process.env[key] = value;
  }
}
