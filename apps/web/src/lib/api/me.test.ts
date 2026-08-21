import type { AuthUser } from "@agent-coordinator/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fetchCurrentUser } from "./me";

const validUser: AuthUser = {
  id: "user_1",
  email: "a@example.com",
  name: "阿玖",
  emailVerified: false,
  image: null,
  createdAt: "2026-08-21T07:11:17.878Z",
};

const jsonResponse = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });

// 给 mock 标上真实签名，取用 mock.calls 时不需要任何断言
const makeFetchMock = () => vi.fn<(input: unknown, init?: RequestInit) => Promise<Response>>();

let fetchMock: ReturnType<typeof makeFetchMock>;

beforeEach(() => {
  fetchMock = makeFetchMock();
  vi.stubGlobal("fetch", fetchMock);
});

describe("fetchCurrentUser 的请求构造", () => {
  it("打的是 NEXT_PUBLIC_API_BASE_URL 下的 /api/me，且带上 cookie", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { user: validUser }));

    await fetchCurrentUser();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe("http://api.test/api/me");
    expect(init).toMatchObject({ method: "GET", credentials: "include" });
  });

  it("透传 AbortSignal，便于组件卸载时取消", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { user: validUser }));
    const controller = new AbortController();

    await fetchCurrentUser(controller.signal);

    const [, init] = fetchMock.mock.calls[0] ?? [];
    expect(init?.signal).toBe(controller.signal);
  });
});

describe("fetchCurrentUser 的成功路径", () => {
  it("200 时按 meResponseSchema 解析出用户", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { user: validUser }));

    const result = await fetchCurrentUser();

    expect(result).toEqual({ ok: true, data: validUser });
  });

  it("200 但响应不符合契约 schema 时视为失败，不把脏数据放进类型世界", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { user: { id: "user_1" } }));

    const result = await fetchCurrentUser();

    expect(result).toEqual({ ok: false, failure: { kind: "unexpected", status: 200 } });
  });

  it("200 但 body 不是 JSON 时视为失败而不是崩溃", async () => {
    fetchMock.mockResolvedValue(
      new Response("<html>proxy</html>", { status: 200, headers: { "content-type": "text/html" } }),
    );

    const result = await fetchCurrentUser();

    expect(result).toEqual({ ok: false, failure: { kind: "unexpected", status: 200 } });
  });
});

describe("fetchCurrentUser 的错误分支", () => {
  it("401 UNAUTHENTICATED 映射为未登录", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(401, {
        error: { code: "UNAUTHENTICATED", message: "authentication required", details: [] },
      }),
    );

    const result = await fetchCurrentUser();

    expect(result).toEqual({ ok: false, failure: { kind: "unauthenticated" } });
  });

  it("429 读自有端点的 Retry-After 头拿到等待秒数", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(
        429,
        { error: { code: "RATE_LIMITED", message: "too many requests", details: [] } },
        { "Retry-After": "45" },
      ),
    );

    const result = await fetchCurrentUser();

    expect(result).toEqual({ ok: false, failure: { kind: "rate-limited", retryAfterSeconds: 45 } });
  });

  it("500 映射为服务端错误", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(500, { error: { code: "INTERNAL", message: "", details: [] } }),
    );

    const result = await fetchCurrentUser();

    expect(result).toEqual({ ok: false, failure: { kind: "server", status: 500 } });
  });

  it("5xx 且 body 不是 JSON（网关返回 html）也不崩", async () => {
    fetchMock.mockResolvedValue(new Response("<html>502</html>", { status: 502 }));

    const result = await fetchCurrentUser();

    expect(result).toEqual({ ok: false, failure: { kind: "server", status: 502 } });
  });

  it("fetch 抛错（断网 / CORS 预检失败）映射为网络失败", async () => {
    fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));

    const result = await fetchCurrentUser();

    expect(result).toEqual({ ok: false, failure: { kind: "network" } });
  });

  it("请求被取消时向上抛出，不当作网络错误渲染给用户", async () => {
    fetchMock.mockRejectedValue(new DOMException("The operation was aborted.", "AbortError"));

    await expect(fetchCurrentUser()).rejects.toThrowError(/aborted/i);
  });
});

describe("fetchCurrentUser 对配置错误的处理", () => {
  it("api 基址漏配时把配置错误抛出去，不洗成「网络连接失败」", async () => {
    vi.stubEnv("NEXT_PUBLIC_API_BASE_URL", "");

    // 关键在于"不被降级"：配置错误是永久性的，伪装成网络抖动会让用户对着一个
    // 永远点不通的重试按钮反复重试。
    await expect(fetchCurrentUser()).rejects.toThrowError(/NEXT_PUBLIC_API_BASE_URL/);
  });

  it("api 基址写错时同样上抛", async () => {
    vi.stubEnv("NEXT_PUBLIC_API_BASE_URL", "localhost:3001");

    await expect(fetchCurrentUser()).rejects.toThrowError(/NEXT_PUBLIC_API_BASE_URL/);
  });

  it("配置错误时根本不该发出请求", async () => {
    vi.stubEnv("NEXT_PUBLIC_API_BASE_URL", "");

    await expect(fetchCurrentUser()).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("真正的网络失败仍然归为 network，这条修复不能把网络分支弄丢", async () => {
    fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));

    await expect(fetchCurrentUser()).resolves.toEqual({
      ok: false,
      failure: { kind: "network" },
    });
  });
});
