import { createServer } from "node:http";
import { healthResponseSchema } from "@agent-coordinator/contracts";

// 最小可运行骨架：真实框架选型走 coordinator 流程后替换。
const port = Number(process.env.PORT ?? 3001);

const server = createServer((req, res) => {
  if (req.url === "/healthz") {
    const body = healthResponseSchema.parse({ status: "ok" });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
    return;
  }
  res.writeHead(404, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: { code: "NOT_FOUND", message: "no such route", details: [] } }));
});

server.listen(port, () => {
  console.log(JSON.stringify({ msg: "api listening", port }));
});
