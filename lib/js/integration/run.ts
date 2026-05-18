/**
 * Consumer integration matrix.
 *
 *   bun integration/run.ts                # quick tier: static + node + bun + esbuild
 *   bun integration/run.ts --all          # everything (heavy installs + Playwright)
 *   bun integration/run.ts --only=node,bun
 *   bun integration/run.ts --browser      # force the browser consumers on
 *
 * Flow: build lib -> pack tarball -> for each consumer install that tarball,
 * build, and assert the public exports resolve. Browser consumers are loaded
 * in Chromium/Firefox/WebKit via Playwright (skipped if Playwright absent).
 *
 * No-plugin policy: Vite/webpack/esbuild/Parcel resolve node_modules natively
 * so they consume the tarball with zero plugins. Standalone Rollup is omitted
 * — vanilla Rollup cannot resolve bare specifiers without a resolver plugin,
 * and Vite's production build already exercises Rollup.
 */
import { spawn } from "bun";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const CONSUMERS = join(import.meta.dir, "consumers");
const PACK_DIR = join(import.meta.dir, ".pack");
const TARBALL = join(PACK_DIR, "luv-js-0.1.0.tgz");

const args = process.argv.slice(2);
const ALL = args.includes("--all");
const FORCE_BROWSER = args.includes("--browser") || ALL;
const ONLY = args.find((a) => a.startsWith("--only="))?.slice(7).split(",");

type Kind = "node" | "bun" | "browser";
interface Consumer { name: string; kind: Kind; heavy: boolean }
const REGISTRY: Consumer[] = [
  { name: "node", kind: "node", heavy: false },
  { name: "bun", kind: "bun", heavy: false },
  { name: "esbuild", kind: "browser", heavy: false },
  { name: "vite", kind: "browser", heavy: true },
  { name: "webpack", kind: "browser", heavy: true },
  { name: "parcel", kind: "browser", heavy: true },
];

const results: { name: string; status: "PASS" | "FAIL" | "SKIP"; detail: string }[] = [];
function record(name: string, status: "PASS" | "FAIL" | "SKIP", detail = "") {
  results.push({ name, status, detail });
  const icon = status === "PASS" ? "✓" : status === "FAIL" ? "✗" : "–";
  console.log(`  ${icon} ${name.padEnd(22)} ${status}${detail ? "  " + detail : ""}`);
}

async function run(cmd: string[], cwd: string): Promise<{ code: number; out: string }> {
  const p = spawn({ cmd, cwd, stdout: "pipe", stderr: "pipe" });
  const out = (await new Response(p.stdout).text()) + (await new Response(p.stderr).text());
  const code = await p.exited;
  return { code, out };
}

// --- 1. build + pack -------------------------------------------------------
console.log("\n→ building luv-js + packing tarball");
{
  const b = await run(["bun", "run", "build"], ROOT);
  if (b.code !== 0) { console.error(b.out); process.exit(1); }
  const p = await run(["bun", "pm", "pack", "--destination", PACK_DIR], ROOT);
  if (p.code !== 0 || !existsSync(TARBALL)) { console.error(p.out); process.exit(1); }
  console.log("  tarball:", TARBALL);
}

// --- 2. consumer matrix ----------------------------------------------------
let playwright: typeof import("playwright") | null = null;
try { playwright = await import("playwright"); } catch { /* optional */ }

const selected = REGISTRY.filter((c) => {
  if (ONLY) return ONLY.includes(c.name);
  if (c.heavy && !ALL) return false;
  if (c.kind === "browser" && !FORCE_BROWSER && c.name !== "esbuild") return false;
  return true;
});

console.log("\n→ consumer matrix");
for (const c of selected) {
  const dir = join(CONSUMERS, c.name);
  const inst = await run(["bun", "install"], dir);
  if (inst.code !== 0) { record(c.name, "FAIL", "install: " + inst.out.trim().split("\n").slice(-2).join(" | ")); continue; }

  if (c.kind === "node") {
    if (!Bun.which("node")) { record(c.name, "SKIP", "node not on PATH (Bun-only host)"); continue; }
    const r = await run(["node", "smoke.mjs"], dir);
    record(c.name, r.code === 0 ? "PASS" : "FAIL", r.out.trim());
    continue;
  }
  if (c.kind === "bun") {
    const r = await run(["bun", "smoke.ts"], dir);
    record(c.name, r.code === 0 ? "PASS" : "FAIL", r.out.trim());
    continue;
  }

  // browser: build then load via Playwright. --bun forces Bun's runtime so
  // bundler CLIs with a `#!/usr/bin/env node` shebang work on a Node-less host.
  const build = await run(["bun", "--bun", "run", "build"], dir);
  if (build.code !== 0) { record(c.name, "FAIL", "build: " + build.out.trim().split("\n").slice(-3).join(" | ")); continue; }

  const distDir = join(dir, "dist");
  if (!existsSync(join(distDir, "index.html"))) {
    await Bun.write(join(distDir, "index.html"),
      `<!doctype html><html><body><script type="module" src="./bundle.js"></script></body></html>`);
  }
  if (!playwright) { record(c.name, "SKIP", "playwright not installed (bun add -d playwright && bunx playwright install)"); continue; }

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req) {
      const rel = decodeURIComponent(new URL(req.url).pathname);
      const target = resolve(distDir, "." + (rel === "/" ? "/index.html" : rel));
      // Contain every request inside distDir — reject path traversal.
      if (target !== distDir && !target.startsWith(distDir + "/")) {
        return new Response("forbidden", { status: 403 });
      }
      if (!existsSync(target)) return new Response("not found", { status: 404 });
      return new Response(Bun.file(target));
    },
  });
  const url = `http://127.0.0.1:${server.port}/`;
  const engines: ("chromium" | "firefox" | "webkit")[] = ["chromium", "firefox", "webkit"];
  const perEngine: string[] = [];
  for (const eng of engines) {
    try {
      const browser = await playwright[eng].launch();
      const page = await browser.newPage();
      await page.goto(url, { waitUntil: "load" });
      const res = await page.waitForFunction(() => (window as any).__LUV_RESULT__, null, { timeout: 8000 })
        .then((h) => h.jsonValue() as Promise<{ ok: boolean; missing: string[] }>);
      perEngine.push(`${eng}:${res.ok ? "ok" : "FAIL(" + res.missing.join(",") + ")"}`);
      await browser.close();
    } catch (e) {
      perEngine.push(`${eng}:ERR(${(e as Error).message.split("\n")[0]})`);
    }
  }
  server.stop(true);
  record(c.name, perEngine.every((s) => s.includes(":ok")) ? "PASS" : "FAIL", perEngine.join("  "));
}

// --- summary ---------------------------------------------------------------
const failed = results.filter((r) => r.status === "FAIL");
console.log(`\n${results.filter((r) => r.status === "PASS").length} passed, ${failed.length} failed, ${results.filter((r) => r.status === "SKIP").length} skipped`);
process.exit(failed.length ? 1 : 0);
