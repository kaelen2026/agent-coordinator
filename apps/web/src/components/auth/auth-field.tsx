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
  ...inputProps
}: { id: string; label: string; error?: string | undefined } & ComponentProps<typeof Input>) {
  const errorId = `${id}-error`;

  return (
    <Field>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <Input
        id={id}
        name={id}
        aria-invalid={error !== undefined}
        aria-describedby={error !== undefined ? errorId : undefined}
        {...inputProps}
      />
      {error !== undefined && (
        <p id={errorId} className="text-destructive text-sm">
          {error}
        </p>
      )}
    </Field>
  );
}
