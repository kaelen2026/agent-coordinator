import { cn } from "@/lib/utils";

/**
 * 签名状态组件（DESIGN.md 第 4 节）：状态是这个产品的视觉主角。
 * 五个状态字面量联合，映射表驱动；只有 running 会动，其余四个绝对静止。
 * 状态永远颜色 + 文字双编码：dot 对读屏隐藏，语义由文字承担。
 */
export type Status = "running" | "succeeded" | "failed" | "queued" | "blocked";

const STATUS_META = {
  running: {
    label: "运行中",
    dot: "bg-status-running animate-status-breathe",
    badge:
      "border-[color-mix(in_oklch,var(--status-running)_25%,transparent)] bg-[color-mix(in_oklch,var(--status-running)_12%,transparent)]",
  },
  succeeded: {
    label: "成功",
    dot: "bg-status-succeeded",
    badge:
      "border-[color-mix(in_oklch,var(--status-succeeded)_25%,transparent)] bg-[color-mix(in_oklch,var(--status-succeeded)_12%,transparent)]",
  },
  failed: {
    label: "失败",
    dot: "bg-status-failed",
    badge:
      "border-[color-mix(in_oklch,var(--status-failed)_25%,transparent)] bg-[color-mix(in_oklch,var(--status-failed)_12%,transparent)]",
  },
  queued: {
    label: "排队",
    dot: "bg-status-queued",
    badge:
      "border-[color-mix(in_oklch,var(--status-queued)_25%,transparent)] bg-[color-mix(in_oklch,var(--status-queued)_12%,transparent)]",
  },
  blocked: {
    label: "阻塞",
    dot: "bg-status-blocked",
    badge:
      "border-[color-mix(in_oklch,var(--status-blocked)_25%,transparent)] bg-[color-mix(in_oklch,var(--status-blocked)_12%,transparent)]",
  },
} as const satisfies Record<Status, { label: string; dot: string; badge: string }>;

function StatusDot({ status, className }: { status: Status; className?: string }) {
  return (
    <span
      data-slot="status-dot"
      data-status={status}
      aria-hidden="true"
      className={cn("size-1.5 shrink-0 rounded-full", STATUS_META[status].dot, className)}
    />
  );
}

function StatusBadge({
  status,
  label,
  className,
}: {
  status: Status;
  /** 覆盖默认中文标签（如「已验证」）；状态语义与配色仍由 status 决定。 */
  label?: string;
  className?: string;
}) {
  return (
    <span
      data-slot="status-badge"
      data-status={status}
      className={cn(
        // 同一容器内所有状态共用同一字号：状态切换只变色与动效，绝不变字号
        "inline-flex w-fit items-center gap-1.5 rounded-sm border px-2 py-0.5 font-sans text-xs leading-normal text-foreground",
        STATUS_META[status].badge,
        className,
      )}
    >
      <StatusDot status={status} />
      {label ?? STATUS_META[status].label}
    </span>
  );
}

export { StatusBadge, StatusDot };
