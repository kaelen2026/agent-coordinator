import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { AuthActionResult } from "@/lib/auth/actions";
import { useAuthForm } from "./use-auth-form";

const schema = z.object({ email: z.string().email({ message: "邮箱格式不正确" }) });

type Submit = (input: { email: string }) => Promise<AuthActionResult>;

/**
 * 用一个最小宿主表单驱动 hook：走真实的 submit 事件，而不是伪造 FormEvent。
 * 这里要盯的是状态机在异常下能不能恢复，所以只把 submitting / failure 暴露到 DOM。
 */
function Host({ submit, onSuccess }: { submit: Submit; onSuccess: () => void }) {
  const { state, handleSubmit } = useAuthForm({
    schema,
    submit,
    operation: "sign-in",
    onSuccess,
  });

  return (
    <form onSubmit={handleSubmit}>
      <input aria-label="邮箱" name="email" defaultValue="a@example.com" />
      <button type="submit" disabled={state.submitting}>
        {state.submitting ? "提交中" : "提交"}
      </button>
      <p data-testid="failure">{state.failure === null ? "" : state.failure.kind}</p>
    </form>
  );
}

const submitOnce = async () => {
  await userEvent.setup().click(screen.getByRole("button"));
};

describe("useAuthForm 的异常兜底", () => {
  it("submit 返回的 promise reject 时退出提交中状态并给出失败", async () => {
    render(<Host submit={() => Promise.reject(new Error("boom"))} onSuccess={vi.fn()} />);

    await submitOnce();

    await waitFor(() => expect(screen.getByRole("button")).toBeEnabled());
    expect(screen.getByTestId("failure")).toHaveTextContent("unexpected");
  });

  it("submit 同步抛异常时同样能恢复——.catch 接不到同步抛，所以必须 try/catch", async () => {
    render(
      <Host
        submit={() => {
          throw new Error("boom");
        }}
        onSuccess={vi.fn()}
      />,
    );

    await submitOnce();

    await waitFor(() => expect(screen.getByRole("button")).toBeEnabled());
    expect(screen.getByTestId("failure")).toHaveTextContent("unexpected");
  });

  it("onSuccess 抛异常时不把表单永久锁死", async () => {
    render(
      <Host
        submit={() => Promise.resolve({ ok: true })}
        onSuccess={() => {
          throw new Error("navigation failed");
        }}
      />,
    );

    await submitOnce();

    await waitFor(() => expect(screen.getByRole("button")).toBeEnabled());
    expect(screen.getByTestId("failure")).toHaveTextContent("unexpected");
  });

  it("一切正常时不冒出失败态", async () => {
    const onSuccess = vi.fn();
    render(<Host submit={() => Promise.resolve({ ok: true })} onSuccess={onSuccess} />);

    await submitOnce();

    await waitFor(() => expect(onSuccess).toHaveBeenCalledTimes(1));
    expect(screen.getByTestId("failure")).toBeEmptyDOMElement();
  });
});
