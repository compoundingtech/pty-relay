import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    // `result` is the nix build symlink; it contains a full copy of the
    // source tree, so without this every test would be collected twice.
    exclude: ["integration/**", "node_modules/**", "result/**"],
    setupFiles: ["./test/setup.ts"],
    globalSetup: ["./test/setup/vitest-global.ts"],
  },
});
