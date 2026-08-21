import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  // 手写 alias 而不是引 vite-tsconfig-paths / plugin-react：这两个包各自把 vite 作为 peer，
  // 很容易和 vitest 自带的 vite 解析成两个大版本，让 vitest.config.ts 自己类型报错。
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  // tsconfig 的 jsx 是 "preserve"（交给 Next 编译），测试里得让 esbuild 自己转 JSX。
  esbuild: { jsx: "automatic" },
  test: {
    environment: "jsdom",
    // 测试环境的 api 基址：只是个占位主机名，所有请求都被 stub 掉，不会真的发出去。
    env: { NEXT_PUBLIC_API_BASE_URL: "http://api.test" },
    setupFiles: ["./vitest.setup.ts"],
    include: ["src/**/*.test.{ts,tsx}"],
    // 每个用例自建自清，互不影响（testing.md：测试之间相互独立）
    restoreMocks: true,
    unstubEnvs: true,
    unstubGlobals: true,
  },
});
