import { Input as InputPrimitive } from "@base-ui/react/input";
import type * as React from "react";

import { cn } from "@/lib/utils";

function Input({ className, type, ...props }: React.ComponentProps<"input">) {
  return (
    <InputPrimitive
      type={type}
      data-slot="input"
      className={cn(
        // 浅色白底、暗色白 4% 填充；focus = border-ring + ring-2 ring/30（DESIGN.md 第 4 节）。
        // 字号 16px→md:14px 是有意的：移动端 <16px 的输入框会触发 iOS 聚焦缩放。
        "h-10 w-full min-w-0 rounded-md border border-input bg-white px-3 py-1 text-base transition-[background-color,border-color,color,opacity] duration-120 ease-console outline-none file:inline-flex file:h-6 file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30 disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-2 aria-invalid:ring-destructive/20 md:text-sm dark:bg-white/4",
        className,
      )}
      {...props}
    />
  );
}

export { Input };
