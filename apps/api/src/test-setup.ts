import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

// 测试环境变量与 dev 同源（仓库根 .env）；CI 直接给真实环境变量。
const envFile = fileURLToPath(new URL("../../../.env", import.meta.url));
if (existsSync(envFile)) {
  process.loadEnvFile(envFile);
}

// 会话签名密钥每次运行随机生成、用完即弃：仓库里不存在任何固定密钥。
process.env.BETTER_AUTH_SECRET ??= randomBytes(32).toString("hex");
