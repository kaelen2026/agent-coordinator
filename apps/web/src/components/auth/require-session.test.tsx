import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { anonymousSession, authenticatedSession, stubFetch } from "@/test-support/stub-fetch";
import { toGateState } from "./require-session";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn(), refresh: vi.fn() }),
  usePathname: () => "/dashboard",
}));

describe("toGateState（会话状态 → 四态）", () => {
  it("还在请求且没有结果时是加载态", () => {
    expect(toGateState({ isPending: true, error: null, hasSession: false })).toEqual({
      status: "loading",
    });
  });

  it("有会话时是已登录", () => {
    expect(toGateState({ isPending: false, error: null, hasSession: true })).toEqual({
      status: "authenticated",
    });
  });

  it("请求完成且确认没有会话时才判定为未登录", () => {
    expect(toGateState({ isPending: false, error: null, hasSession: false })).toEqual({
      status: "anonymous",
    });
  });

  it("读会话出错时是错误态，绝不降级成未登录——那会把一次网络抖动变成一次莫名登出", () => {
    expect(toGateState({ isPending: false, error: { status: 500 }, hasSession: false })).toEqual({
      status: "error",
      failure: { kind: "server", status: 500 },
    });
  });

  it("拿不到响应（status 为 0）时归为网络失败", () => {
    expect(toGateState({ isPending: false, error: { status: 0 }, hasSession: false })).toEqual({
      status: "error",
      failure: { kind: "network" },
    });
  });

  it("即使已经有旧会话，出错时也要如实报错", () => {
    expect(toGateState({ isPending: false, error: { status: 503 }, hasSession: true })).toEqual({
      status: "error",
      failure: { kind: "server", status: 503 },
    });
  });
});

describe("RequireSession 与真实 better-auth 客户端的接线", () => {
  // better-auth 的会话 store 是模块级单例（nanostores），跨用例会残留上一次的会话。
  // 每个用例前重置模块注册表并重新 import，拿到全新的客户端与全新的 atom，
  // 保证用例互不依赖执行顺序（testing.md）。
  beforeEach(() => {
    vi.resetModules();
  });

  const loadRequireSession = async () => (await import("./require-session")).RequireSession;

  it("会话有效时渲染受保护内容，并且是向 api 的 get-session 问的", async () => {
    const fetchStub = stubFetch({
      "/get-session": authenticatedSession({ id: "u1", name: "阿玖", email: "a@example.com" }),
    });
    const RequireSession = await loadRequireSession();

    render(
      <RequireSession>
        <p>受保护内容</p>
      </RequireSession>,
    );

    expect(await screen.findByText("受保护内容")).toBeInTheDocument();
    const call = fetchStub.callsTo("/get-session")[0];
    expect(call?.url).toContain("http://api.test/api/auth/get-session");
    expect(call?.init?.credentials).toBe("include");
  });

  it("没有会话时不渲染受保护内容", async () => {
    stubFetch({ "/get-session": anonymousSession });
    const RequireSession = await loadRequireSession();

    render(
      <RequireSession>
        <p>受保护内容</p>
      </RequireSession>,
    );

    await waitFor(() => expect(screen.getByText(/需要登录/)).toBeInTheDocument());
    expect(screen.queryByText("受保护内容")).not.toBeInTheDocument();
  });
});
