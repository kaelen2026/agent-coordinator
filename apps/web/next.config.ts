import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { NextConfig } from "next";

// 全仓库共用根目录那一份 .env（apps/api 也是用 --env-file 指到它）。
// Next 默认只看 app 目录下的 .env*，不接上的话 NEXT_PUBLIC_API_BASE_URL 在
// dev/build 时都是空的。已经存在于环境里的变量不会被覆盖，CI 与 shell 仍然优先。
const rootEnvFile = resolve(dirname(fileURLToPath(import.meta.url)), "../../.env");
if (existsSync(rootEnvFile)) {
  process.loadEnvFile(rootEnvFile);
}

const nextConfig: NextConfig = {};

export default nextConfig;
