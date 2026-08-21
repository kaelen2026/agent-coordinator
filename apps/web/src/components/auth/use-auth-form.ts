"use client";

import { type FormEvent, useCallback, useState } from "react";
import type { z } from "zod";
import type { AuthActionResult } from "@/lib/auth/actions";
import type { AuthFailure } from "@/lib/auth/failure";
import { fieldErrorsOf } from "@/lib/auth/forms";
import { type AuthOperation, reportAuthFailure } from "@/lib/observability/report";

/**
 * 登录与注册共用的提交状态机。两张表单只有字段不同，这套"校验 → 提交 → 归类 → 反馈"
 * 的流程完全一致，所以抽成一个 hook（第二次出现才抽象）。
 *
 * 三个状态是相互关联的（提交中就不该同时显示旧错误），合并成一个对象而不是三个
 * useState，避免出现"更新了一半"的中间态（react-nextjs skill 步骤 2）。
 */
export type AuthFormState = {
  submitting: boolean;
  fieldErrors: Record<string, string>;
  failure: AuthFailure | null;
};

const IDLE: AuthFormState = { submitting: false, fieldErrors: {}, failure: null };

type Options<Input> = {
  schema: z.ZodType<Input>;
  submit: (input: Input) => Promise<AuthActionResult>;
  operation: AuthOperation;
  onSuccess: () => void;
};

export const useAuthForm = <Input>({ schema, submit, operation, onSuccess }: Options<Input>) => {
  const [state, setState] = useState<AuthFormState>(IDLE);

  const handleSubmit = useCallback(
    (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();

      // 非受控表单：提交时才取值。输入过程中不校验、不发请求——api 对登录/注册的限流
      // 很紧（每 IP 每窗口只有几次），边打字边试探会把用户自己锁死。
      const formData = new FormData(event.currentTarget);
      const parsed = schema.safeParse(Object.fromEntries(formData.entries()));

      if (!parsed.success) {
        // 本地就能拦住的错误不消耗限流额度
        setState({ submitting: false, fieldErrors: fieldErrorsOf(parsed.error), failure: null });
        return;
      }

      setState({ submitting: true, fieldErrors: {}, failure: null });

      void submit(parsed.data).then((result) => {
        if (result.ok) {
          setState(IDLE);
          onSuccess();
          return;
        }
        reportAuthFailure(operation, result.failure);
        setState({ submitting: false, fieldErrors: {}, failure: result.failure });
      });
    },
    [schema, submit, operation, onSuccess],
  );

  /** 限流倒计时走完后清掉失败态，让按钮重新可用。 */
  const clearFailure = useCallback(() => {
    setState((current) => ({ ...current, failure: null }));
  }, []);

  return { state, handleSubmit, clearFailure };
};
