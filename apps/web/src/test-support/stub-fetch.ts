import { vi } from "vitest";

/**
 * 组件测试的唯一 mock 点：全局 `fetch`。
 *
 * 刻意**不**去 mock 请求层或 better-auth 客户端——「表单 → actions → better-auth →
 * 契约 schema → 失败归类 → 文案」这条链路是关键路径，必须被真实执行到
 * （testing.md：mock 只用于隔离外部边界）。
 */

export type StubRoute =
  | {
      status: number;
      body: unknown;
      headers?: Record<string, string>;
      /**
       * 响应挂起直到这个 promise 兑现。用来精确复现"请求还在路上"的那段窗口——
       * 会话相关的 bug 几乎都藏在这几十毫秒里，用真实延时会让测试变 flaky，
       * 用一个自己控制的闸门才能稳定重现。
       */
      pendingUntil?: Promise<unknown>;
    }
  | "network-error";

export type StubbedFetch = {
  calls: { url: string; init: RequestInit | undefined }[];
  callsTo: (path: string) => { url: string; init: RequestInit | undefined }[];
};

export const stubFetch = (routes: Record<string, StubRoute>): StubbedFetch => {
  const calls: { url: string; init: RequestInit | undefined }[] = [];

  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, init });

      const match = Object.entries(routes).find(([path]) => url.includes(path));
      if (match === undefined) throw new Error(`unstubbed request: ${url}`);

      const route = match[1];
      if (route === "network-error") throw new TypeError("Failed to fetch");

      if (route.pendingUntil !== undefined) await route.pendingUntil;

      return new Response(JSON.stringify(route.body), {
        status: route.status,
        headers: { "content-type": "application/json", ...(route.headers ?? {}) },
      });
    }),
  );

  return {
    calls,
    callsTo: (path) => calls.filter((call) => call.url.includes(path)),
  };
};

/** better-auth 在登录/注册/登出之后会自动重新拉一次会话，测试里得把这条路由也备好。 */
export const anonymousSession: StubRoute = { status: 200, body: null };

export const authenticatedSession = (
  user: unknown,
  pendingUntil?: Promise<unknown>,
): StubRoute => ({
  status: 200,
  body: { user, session: { id: "s1", expiresAt: "2099-01-01T00:00:00.000Z" } },
  pendingUntil,
});

/** 手动控制的闸门：用来把某个响应按住，直到测试自己放行。 */
export const gate = () => {
  let open = (): void => {};
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { opened, open: () => open() };
};
