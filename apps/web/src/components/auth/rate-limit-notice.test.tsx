import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RateLimitNotice } from "./rate-limit-notice";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

const tick = async (seconds: number) => {
  await act(async () => {
    vi.advanceTimersByTime(seconds * 1000);
  });
};

describe("RateLimitNotice", () => {
  it("先显示服务端给出的等待秒数，而不是某个写死的默认值", () => {
    render(<RateLimitNotice retryAfterSeconds={7} onExpire={vi.fn()} />);

    expect(screen.getByRole("alert")).toHaveTextContent("请在 7 秒后重试");
  });

  it("逐秒倒数", async () => {
    render(<RateLimitNotice retryAfterSeconds={5} onExpire={vi.fn()} />);

    await tick(1);
    expect(screen.getByRole("alert")).toHaveTextContent("请在 4 秒后重试");

    await tick(3);
    expect(screen.getByRole("alert")).toHaveTextContent("请在 1 秒后重试");
  });

  it("数到 0 时改为提示可以重试，并且只通知调用方一次", async () => {
    const onExpire = vi.fn();
    render(<RateLimitNotice retryAfterSeconds={2} onExpire={onExpire} />);
    expect(onExpire).not.toHaveBeenCalled();

    await tick(2);

    expect(screen.getByRole("alert")).toHaveTextContent("已经可以重试了");
    expect(onExpire).toHaveBeenCalledTimes(1);
  });

  it("倒计时不会走成负数", async () => {
    render(<RateLimitNotice retryAfterSeconds={1} onExpire={vi.fn()} />);

    await tick(10);

    expect(screen.getByRole("alert")).toHaveTextContent("已经可以重试了");
    expect(screen.getByRole("alert").textContent).not.toMatch(/-\d/);
  });

  it("来了新的限流响应（秒数变了）时重新开始倒数", async () => {
    const { rerender } = render(<RateLimitNotice retryAfterSeconds={5} onExpire={vi.fn()} />);
    await tick(3);
    expect(screen.getByRole("alert")).toHaveTextContent("请在 2 秒后重试");

    rerender(<RateLimitNotice retryAfterSeconds={9} onExpire={vi.fn()} />);

    expect(screen.getByRole("alert")).toHaveTextContent("请在 9 秒后重试");
  });

  it("卸载后不再继续跑计时器", async () => {
    const onExpire = vi.fn();
    const { unmount } = render(<RateLimitNotice retryAfterSeconds={3} onExpire={onExpire} />);

    unmount();
    await tick(10);

    expect(onExpire).not.toHaveBeenCalled();
  });
});
