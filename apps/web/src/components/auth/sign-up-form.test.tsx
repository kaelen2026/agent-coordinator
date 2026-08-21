import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { anonymousSession, stubFetch } from "@/test-support/stub-fetch";
import { SignUpForm } from "./sign-up-form";

const fillAndSubmit = async (values: { name?: string; email?: string; password?: string }) => {
  const user = userEvent.setup();
  if (values.name !== undefined) await user.type(screen.getByLabelText("姓名"), values.name);
  if (values.email !== undefined) await user.type(screen.getByLabelText("邮箱"), values.email);
  if (values.password !== undefined) {
    await user.type(screen.getByLabelText("密码"), values.password);
  }
  await user.click(screen.getByRole("button", { name: "注册" }));
};

describe("SignUpForm 的本地校验", () => {
  it("密码不足 12 位时本地就拦下，不浪费限流额度", async () => {
    const fetchStub = stubFetch({});
    render(<SignUpForm onSuccess={vi.fn()} />);

    await fillAndSubmit({ name: "阿玖", email: "a@example.com", password: "short" });

    expect(await screen.findByText("密码至少 12 位")).toBeInTheDocument();
    expect(fetchStub.calls).toHaveLength(0);
  });

  it("姓名为空时给出字段级提示", async () => {
    stubFetch({});
    render(<SignUpForm onSuccess={vi.fn()} />);

    await fillAndSubmit({ email: "a@example.com", password: "correct-horse-battery" });

    expect(await screen.findByText("请输入姓名")).toBeInTheDocument();
  });
});

describe("SignUpForm 的提交", () => {
  it("成功后通知调用方，且响应体里的明文 token 不出现在页面上", async () => {
    const onSuccess = vi.fn();
    const fetchStub = stubFetch({
      "/sign-up/email": {
        status: 200,
        body: { token: "plaintext-session-token", user: { id: "u1" } },
      },
      "/get-session": anonymousSession,
    });
    render(<SignUpForm onSuccess={onSuccess} />);

    await fillAndSubmit({
      name: "阿玖",
      email: "a@example.com",
      password: "correct-horse-battery",
    });

    await waitFor(() => expect(onSuccess).toHaveBeenCalledTimes(1));
    expect(fetchStub.callsTo("/sign-up/email")).toHaveLength(1);
    expect(document.body.textContent).not.toContain("plaintext-session-token");
  });

  it("邮箱已被注册时提示换一个邮箱或直接登录", async () => {
    stubFetch({
      "/sign-up/email": {
        status: 422,
        body: { message: "User already exists", code: "USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL" },
      },
    });
    render(<SignUpForm onSuccess={vi.fn()} />);

    await fillAndSubmit({
      name: "阿玖",
      email: "taken@example.com",
      password: "correct-horse-battery",
    });

    expect(await screen.findByRole("alert")).toHaveTextContent("该邮箱已被注册");
  });

  it("服务端判定密码过短时也给出可操作的提示（前后端规则不同步时的兜底）", async () => {
    stubFetch({
      "/sign-up/email": {
        status: 400,
        body: { message: "Password too short", code: "PASSWORD_TOO_SHORT" },
      },
    });
    render(<SignUpForm onSuccess={vi.fn()} />);

    await fillAndSubmit({
      name: "阿玖",
      email: "a@example.com",
      password: "correct-horse-battery",
    });

    expect(await screen.findByRole("alert")).toHaveTextContent("密码至少 12 位");
  });

  it("被限流时显示服务端给出的等待秒数并禁用按钮", async () => {
    stubFetch({
      "/sign-up/email": {
        status: 429,
        body: { message: "Too many requests" },
        headers: { "content-type": "text/plain;charset=UTF-8", "X-Retry-After": "9" },
      },
    });
    render(<SignUpForm onSuccess={vi.fn()} />);

    await fillAndSubmit({
      name: "阿玖",
      email: "a@example.com",
      password: "correct-horse-battery",
    });

    expect(await screen.findByRole("alert")).toHaveTextContent("请在 9 秒后重试");
    expect(screen.getByRole("button", { name: "注册" })).toBeDisabled();
  });
});
