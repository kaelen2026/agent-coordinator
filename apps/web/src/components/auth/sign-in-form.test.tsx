import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { anonymousSession, stubFetch } from "@/test-support/stub-fetch";
import { SignInForm } from "./sign-in-form";

const fillAndSubmit = async (
  email: string,
  password: string,
  user = userEvent.setup(),
): Promise<void> => {
  if (email !== "") await user.type(screen.getByLabelText("邮箱"), email);
  if (password !== "") await user.type(screen.getByLabelText("密码"), password);
  await user.click(screen.getByRole("button", { name: "登录" }));
};

describe("SignInForm 的表单校验（不发请求就能拦住的错误）", () => {
  it("邮箱格式不对时给出字段级提示，且不打网络请求——省下宝贵的限流额度", async () => {
    const fetchStub = stubFetch({});
    render(<SignInForm onSuccess={vi.fn()} />);

    await fillAndSubmit("not-an-email", "correct-horse-battery");

    expect(await screen.findByText("邮箱格式不正确")).toBeInTheDocument();
    expect(fetchStub.calls).toHaveLength(0);
  });

  it("字段为空时逐个提示，且不打网络请求", async () => {
    const fetchStub = stubFetch({});
    render(<SignInForm onSuccess={vi.fn()} />);

    await fillAndSubmit("", "");

    expect(await screen.findByText("请输入邮箱")).toBeInTheDocument();
    expect(fetchStub.calls).toHaveLength(0);
  });

  it("输入过程中不做校验也不发请求，避免用户边打字边把自己限流锁死", async () => {
    const fetchStub = stubFetch({});
    render(<SignInForm onSuccess={vi.fn()} />);

    await userEvent.setup().type(screen.getByLabelText("邮箱"), "a@example.com");

    expect(fetchStub.calls).toHaveLength(0);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});

describe("SignInForm 的成功路径", () => {
  it("提交成功后通知调用方，并且不在页面上留下任何 token", async () => {
    const onSuccess = vi.fn();
    stubFetch({
      "/sign-in/email": {
        status: 200,
        body: { token: "plaintext-session-token", user: { id: "u1" }, redirect: false },
      },
      "/get-session": anonymousSession,
    });
    render(<SignInForm onSuccess={onSuccess} />);

    await fillAndSubmit("a@example.com", "correct-horse-battery");

    await waitFor(() => expect(onSuccess).toHaveBeenCalledTimes(1));
    expect(document.body.textContent).not.toContain("plaintext-session-token");
    expect(window.localStorage.length).toBe(0);
  });

  it("提交过程中禁用按钮并给出进行中的提示（加载态）", async () => {
    let release = (): void => {};
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        await pending;
        return new Response(JSON.stringify({ token: "t", user: {} }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }),
    );
    render(<SignInForm onSuccess={vi.fn()} />);

    await fillAndSubmit("a@example.com", "correct-horse-battery");

    const button = await screen.findByRole("button", { name: "登录中…" });
    expect(button).toBeDisabled();
    release();
  });
});

describe("SignInForm 的错误分支", () => {
  it("凭证错时提示邮箱或密码不正确，且不透露该邮箱是否注册过", async () => {
    stubFetch({
      "/sign-in/email": {
        status: 401,
        body: { message: "Invalid email or password", code: "INVALID_EMAIL_OR_PASSWORD" },
      },
    });
    render(<SignInForm onSuccess={vi.fn()} />);

    await fillAndSubmit("a@example.com", "wrong-password-x");

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("邮箱或密码不正确");
    expect(alert).not.toHaveTextContent(/未注册|不存在/);
  });

  it("被限流时显示服务端给出的等待秒数，并禁用提交按钮", async () => {
    stubFetch({
      "/sign-in/email": {
        status: 429,
        body: { message: "Too many requests" },
        headers: { "content-type": "text/plain;charset=UTF-8", "X-Retry-After": "7" },
      },
    });
    render(<SignInForm onSuccess={vi.fn()} />);

    await fillAndSubmit("a@example.com", "correct-horse-battery");

    expect(await screen.findByRole("alert")).toHaveTextContent("请在 7 秒后重试");
    expect(screen.getByRole("button", { name: "登录" })).toBeDisabled();
  });

  it("服务端错误提示稍后重试，不暴露状态码", async () => {
    stubFetch({ "/sign-in/email": { status: 500, body: { message: "boom" } } });
    render(<SignInForm onSuccess={vi.fn()} />);

    await fillAndSubmit("a@example.com", "correct-horse-battery");

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("服务暂时不可用，请稍后重试");
    expect(alert).not.toHaveTextContent("500");
  });

  it("网络失败时提示检查网络，并且按钮恢复可点以便重试", async () => {
    stubFetch({ "/sign-in/email": "network-error" });
    render(<SignInForm onSuccess={vi.fn()} />);

    await fillAndSubmit("a@example.com", "correct-horse-battery");

    expect(await screen.findByRole("alert")).toHaveTextContent("网络连接失败");
    expect(screen.getByRole("button", { name: "登录" })).toBeEnabled();
  });

  it("失败后重新提交会清掉上一次的错误提示", async () => {
    const user = userEvent.setup();
    stubFetch({
      "/sign-in/email": { status: 500, body: { message: "boom" } },
    });
    render(<SignInForm onSuccess={vi.fn()} />);
    await fillAndSubmit("a@example.com", "correct-horse-battery", user);
    expect(await screen.findByRole("alert")).toBeInTheDocument();

    stubFetch({
      "/sign-in/email": { status: 200, body: { token: "t", user: {} } },
      "/get-session": anonymousSession,
    });
    await user.click(screen.getByRole("button", { name: "登录" }));

    await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
  });
});
