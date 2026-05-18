import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

export default {
  mode: "production",
  entry: "./src/main.js",
  output: {
    path: resolve(__dirname, "dist"),
    filename: "bundle.js",
    clean: true,
  },
};
