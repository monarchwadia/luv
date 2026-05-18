import { build } from "esbuild";

await build({
  entryPoints: ["src/main.js"],
  bundle: true,
  format: "esm",
  platform: "browser",
  outfile: "dist/bundle.js",
  // Exercise the same engine floor the library targets.
  target: ["chrome90", "firefox88", "safari14.1"],
});
console.log("esbuild consumer build OK");
