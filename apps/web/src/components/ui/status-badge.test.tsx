import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { StatusBadge, StatusDot } from "./status-badge";

function dotOf(container: HTMLElement): HTMLElement | null {
  return container.querySelector("[data-slot=status-dot]");
}

describe("StatusBadge", () => {
  it.each([
    ["running", "运行中"],
    ["succeeded", "成功"],
    ["failed", "失败"],
    ["queued", "排队"],
    ["blocked", "阻塞"],
  ] as const)("%s 状态渲染默认中文标签「%s」", (status, label) => {
    render(<StatusBadge status={status} />);
    expect(screen.getByText(label)).toBeInTheDocument();
  });

  it("label 覆盖默认标签（如邮箱验证的「已验证」）", () => {
    render(<StatusBadge status="succeeded" label="已验证" />);
    expect(screen.getByText("已验证")).toBeInTheDocument();
    expect(screen.queryByText("成功")).not.toBeInTheDocument();
  });

  it("running 是唯一会动的状态：dot 带呼吸动画 class", () => {
    const { container } = render(<StatusBadge status="running" />);
    expect(dotOf(container)).toHaveClass("animate-status-breathe");
  });

  it.each(["succeeded", "failed", "queued", "blocked"] as const)(
    "%s 是静止状态：dot 不带呼吸动画 class",
    (status) => {
      const { container } = render(<StatusBadge status={status} />);
      const dot = dotOf(container);
      expect(dot).not.toBeNull();
      expect(dot).not.toHaveClass("animate-status-breathe");
    },
  );

  it("状态用颜色 + 文字双编码：dot 对读屏隐藏，语义由文字承担", () => {
    const { container } = render(<StatusBadge status="failed" />);
    expect(dotOf(container)).toHaveAttribute("aria-hidden", "true");
  });
});

describe("StatusDot", () => {
  it("可独立使用，running 带呼吸动画", () => {
    const { container } = render(<StatusDot status="running" />);
    expect(dotOf(container)).toHaveClass("animate-status-breathe");
  });

  it("终态静止", () => {
    const { container } = render(<StatusDot status="succeeded" />);
    expect(dotOf(container)).not.toHaveClass("animate-status-breathe");
  });
});
