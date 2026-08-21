import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { anonymousSession, stubFetch } from "@/test-support/stub-fetch";
import { SignOutButton } from "./sign-out-button";

describe("SignOutButton", () => {
  it("点击后请求登出，成功了才通知调用方", async () => {
    const onSignedOut = vi.fn();
    const fetchStub = stubFetch({
      "/sign-out": { status: 200, body: { success: true } },
      "/get-session": anonymousSession,
    });
    render(<SignOutButton onSignedOut={onSignedOut} />);

    await userEvent.setup().click(screen.getByRole("button", { name: "登出" }));

    await waitFor(() => expect(onSignedOut).toHaveBeenCalledTimes(1));
    expect(fetchStub.callsTo("/sign-out")).toHaveLength(1);
  });

  it("登出失败时给出提示，且不假装已经登出", async () => {
    const onSignedOut = vi.fn();
    stubFetch({ "/sign-out": { status: 500, body: { message: "boom" } } });
    render(<SignOutButton onSignedOut={onSignedOut} />);

    await userEvent.setup().click(screen.getByRole("button", { name: "登出" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("服务暂时不可用");
    expect(onSignedOut).not.toHaveBeenCalled();
  });

  it("请求进行中时禁用按钮，避免重复提交把自己限流", async () => {
    let release = (): void => {};
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        await pending;
        return new Response(JSON.stringify({ success: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }),
    );
    render(<SignOutButton onSignedOut={vi.fn()} />);

    await userEvent.setup().click(screen.getByRole("button", { name: "登出" }));

    expect(await screen.findByRole("button", { name: "登出中…" })).toBeDisabled();
    release();
  });
});
