import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SessionGate } from "./session-gate";

const { replace } = vi.hoisted(() => ({ replace: vi.fn() }));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace, push: vi.fn(), refresh: vi.fn(), back: vi.fn(), forward: vi.fn() }),
  usePathname: () => "/dashboard",
}));

beforeEach(() => {
  replace.mockClear();
});

const secret = "只有登录后才能看到的内容";

describe("SessionGate 的四态", () => {
  it("加载中：显示加载提示，既不渲染受保护内容也不急着跳转", () => {
    render(
      <SessionGate state={{ status: "loading" }} onRetry={vi.fn()}>
        <p>{secret}</p>
      </SessionGate>,
    );

    expect(screen.getByRole("status")).toHaveTextContent("正在确认登录状态");
    expect(screen.queryByText(secret)).not.toBeInTheDocument();
    expect(replace).not.toHaveBeenCalled();
  });

  it("已登录：渲染受保护内容", () => {
    render(
      <SessionGate state={{ status: "authenticated" }} onRetry={vi.fn()}>
        <p>{secret}</p>
      </SessionGate>,
    );

    expect(screen.getByText(secret)).toBeInTheDocument();
    expect(replace).not.toHaveBeenCalled();
  });

  it("未登录：引导去登录页，并把当前路径带在 redirectTo 上", async () => {
    render(
      <SessionGate state={{ status: "anonymous" }} onRetry={vi.fn()}>
        <p>{secret}</p>
      </SessionGate>,
    );

    await waitFor(() => expect(replace).toHaveBeenCalledWith("/sign-in?redirectTo=%2Fdashboard"));
    expect(screen.queryByText(secret)).not.toBeInTheDocument();
  });

  it("未登录：跳转前给出可见提示与一个手动入口，不是白屏", () => {
    render(
      <SessionGate state={{ status: "anonymous" }} onRetry={vi.fn()}>
        <p>{secret}</p>
      </SessionGate>,
    );

    expect(screen.getByText(/需要登录/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "前往登录" })).toHaveAttribute(
      "href",
      "/sign-in?redirectTo=%2Fdashboard",
    );
  });

  it("会话读取失败：给出错误提示和重试入口，不把用户当成未登录踢走", async () => {
    const onRetry = vi.fn();
    render(
      <SessionGate state={{ status: "error", failure: { kind: "network" } }} onRetry={onRetry}>
        <p>{secret}</p>
      </SessionGate>,
    );

    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("网络连接失败");
    expect(replace).not.toHaveBeenCalled();
    expect(screen.queryByText(secret)).not.toBeInTheDocument();

    await userEvent.setup().click(screen.getByRole("button", { name: "重试" }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("服务端错误时同样不误判为未登录", () => {
    render(
      <SessionGate
        state={{ status: "error", failure: { kind: "server", status: 500 } }}
        onRetry={vi.fn()}
      >
        <p>{secret}</p>
      </SessionGate>,
    );

    expect(screen.getByRole("alert")).toHaveTextContent("服务暂时不可用");
    expect(replace).not.toHaveBeenCalled();
  });
});
