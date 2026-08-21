import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig } from "drizzle-kit";

// 本地开发从仓库根 .env 取连接串；CI/生产走真实环境变量。
const envFile = fileURLToPath(new URL("../../.env", import.meta.url));
if (existsSync(envFile)) {
  process.loadEnvFile(envFile);
}

const url = process.env.DATABASE_URL;
if (!url) {
  throw new Error("DATABASE_URL is required to run drizzle-kit (see .env.example)");
}

export default defineConfig({
  dialect: "postgresql",
  // 每个模块自带 schema.ts（单体模块化：表归属跟着模块走）
  schema: "./src/modules/*/schema.ts",
  out: "./drizzle",
  dbCredentials: { url },
  strict: true,
  verbose: true,
});
