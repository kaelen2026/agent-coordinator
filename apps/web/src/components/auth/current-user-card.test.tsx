import type { AuthUser } from "@agent-coordinator/contracts";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { stubFetch } from "@/test-support/stub-fetch";
import { CurrentUserCard } from "./current-user-card";

const user: AuthUser = {
  id: "user_1",
  email: "a@example.com",
  name: "阿玖",
  emailVerified: false,
  image: null,
  createdAt: "2026-08-21T07:11:17.878Z",
};

describe("CurrentUserCard 的四态", () => {
  it("加载中：先给出加载提示，不是白屏", async () => {
    stubFetch({ "/api/me": { status: 200, body: { user } } });

    render(<CurrentUserCard />);

    expect(screen.getByRole("status")).toHaveTextContent("正在加载");
    await waitFor(() => expect(screen.queryByRole("status")).not.toBeInTheDocument());
  });

  it("成功：展示当前登录用户的姓名与邮箱", async () => {
    stubFetch({ "/api/me": { status: 200, body: { user } } });

    render(<CurrentUserCard />);

    expect(await screen.findByText("阿玖")).toBeInTheDocument();
    expect(screen.getByText("a@example.com")).toBeInTheDocument();
    // 邮箱验证状态用 StatusBadge 呈现，语义不变：仍以「已验证/未验证」文字为准
    expect(screen.getByText("未验证")).toBeInTheDocument();
  });

  it("未登录：给出去登录的引导，而不是空白或裸露的数据结构", async () => {
    stubFetch({
      "/api/me": {
        status: 401,
        body: {
          error: { code: "UNAUTHENTICATED", message: "authentication required", details: [] },
        },
      },
    });

    render(<CurrentUserCard />);

    expect(await screen.findByRole("alert")).toHaveTextContent("登录状态已失效");
    expect(screen.getByRole("link", { name: "重新登录" })).toHaveAttribute("href", "/sign-in");
  });

  it("错误：给出提示与重试入口，重试会真的再打一次接口", async () => {
    const failing = stubFetch({ "/api/me": "network-error" });
    render(<CurrentUserCard />);
    expect(await screen.findByRole("alert")).toHaveTextContent("网络连接失败");
    expect(failing.callsTo("/api/me")).toHaveLength(1);

    const recovered = stubFetch({ "/api/me": { status: 200, body: { user } } });
    await userEvent.setup().click(screen.getByRole("button", { name: "重试" }));

    expect(await screen.findByText("阿玖")).toBeInTheDocument();
    expect(recovered.callsTo("/api/me")).toHaveLength(1);
  });

  it("被限流：显示服务端 Retry-After 给出的等待秒数", async () => {
    stubFetch({
      "/api/me": {
        status: 429,
        body: { error: { code: "RATE_LIMITED", message: "too many", details: [] } },
        headers: { "Retry-After": "45" },
      },
    });

    render(<CurrentUserCard />);

    expect(await screen.findByRole("alert")).toHaveTextContent("请在 45 秒后重试");
  });

  it("服务端错误：只提示稍后重试，不暴露状态码", async () => {
    stubFetch({
      "/api/me": { status: 500, body: { error: { code: "X", message: "", details: [] } } },
    });

    render(<CurrentUserCard />);

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("服务暂时不可用");
    expect(alert).not.toHaveTextContent("500");
  });
});
