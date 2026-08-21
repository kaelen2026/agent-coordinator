import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    setupFiles: ["./src/test-setup.ts"],
    globalSetup: ["./src/test-global-setup.ts"],
    // 集成测试共用同一个 Postgres 实例（限流表是全局状态），串行跑保证可重复
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
