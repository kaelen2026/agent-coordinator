import type { HealthResponse } from "@agent-coordinator/contracts";

// 依赖检查（DB/队列）接入后在此汇总各依赖状态，决定 ok | degraded。
export const getHealth = (): HealthResponse => ({ status: "ok" });
