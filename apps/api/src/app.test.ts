import { apiErrorSchema, healthResponseSchema } from "@agent-coordinator/contracts";
import { describe, expect, it } from "vitest";
import { createApp } from "./app.js";

describe("app", () => {
  it("healthz_returns_contract_shaped_ok", async () => {
    const res = await createApp().request("/healthz");
    expect(res.status).toBe(200);
    const parsed = healthResponseSchema.parse(await res.json());
    expect(parsed.status).toBe("ok");
  });

  it("unknown_route_returns_contract_shaped_404", async () => {
    const res = await createApp().request("/no-such-route");
    expect(res.status).toBe(404);
    const parsed = apiErrorSchema.parse(await res.json());
    expect(parsed.error.code).toBe("NOT_FOUND");
  });
});
