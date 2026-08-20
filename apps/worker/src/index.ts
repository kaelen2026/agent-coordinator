// 最小可运行骨架：队列选型与任务模型走 coordinator 流程后按 job-queue SOP 实现。
console.log(JSON.stringify({ msg: "worker started" }));

const shutdown = (signal: string) => {
  console.log(JSON.stringify({ msg: "worker shutting down", signal }));
  process.exit(0);
};

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
