import { serve } from "@hono/node-server";
import { createApp } from "./app.js";

const port = Number(process.env.PORT ?? 3001);

const server = serve({ fetch: createApp().fetch, port }, (info) => {
  console.log(JSON.stringify({ msg: "api listening", port: info.port }));
});

const shutdown = (signal: string) => {
  console.log(JSON.stringify({ msg: "api shutting down", signal }));
  server.close(() => process.exit(0));
};

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
