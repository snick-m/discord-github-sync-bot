import { defineConfig } from "tsup";
export default defineConfig({
  entry: { index: "src/index.ts", queue: "src/queue.ts" },
  outDir: "dist",
  format: ["cjs"],
  target: "node24",
  // SQLite is a prefix-only builtin: require("sqlite") is not require("node:sqlite").
  removeNodeProtocol: false,
  sourcemap: true,
  splitting: false,
  clean: true,
});
