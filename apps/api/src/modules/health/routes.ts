import { Hono } from "hono";
import { getHealth } from "./service.js";

export const healthRoutes = new Hono().get("/healthz", (c) => c.json(getHealth()));
