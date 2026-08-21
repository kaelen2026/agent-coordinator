"use client";

import type { ComponentProps } from "react";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";

/**
 * 表单字段：label + input + 字段级错误，三者用 id 关联好，键盘与读屏都能用。
 * 只组合 ui/ 里的原子组件，不复制它们的内部实现。
 */
export function AuthField({
  id,
  label,
  error,
  // 调用方可能自己挂了说明文字（比如注册页的密码规则提示）。这里必须**合并**而不是
  // 二选一：让外部值覆盖会把错误文案的关联挤掉，读屏用户只听得到"无效"、听不到原因；
  // 反过来让错误覆盖又会吞掉规则提示。两个 id 一起给。
  "aria-describedby": describedBy,
  ...inputProps
}: { id: string; label: string; error?: string | undefined } & ComponentProps<typeof Input>) {
  const errorId = `${id}-error`;
  const describedByIds = [describedBy, error === undefined ? undefined : errorId]
    .filter((value) => typeof value === "string" && value.length > 0)
    .join(" ");

  return (
    <Field>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <Input
        id={id}
        name={id}
        {...inputProps}
        // 这两个必须排在展开之后：它们是本组件对错误态的承诺，不接受被外部悄悄覆盖。
        aria-invalid={error !== undefined}
        aria-describedby={describedByIds === "" ? undefined : describedByIds}
      />
      {error !== undefined && (
        <p id={errorId} className="text-destructive text-sm">
          {error}
        </p>
      )}
    </Field>
  );
}
