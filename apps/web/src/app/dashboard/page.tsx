import type { Metadata } from "next";
import { AuthPageShell } from "@/components/auth/auth-page-shell";
import { DashboardPanel } from "@/components/auth/dashboard-panel";

export const metadata: Metadata = {
  title: "我的账号 · Agent Coordinator",
  description: "查看当前登录的账号信息。",
};

/**
 * 受保护页面。守卫在客户端（见 RequireSession 的注释）：会话 cookie 属于 api 的域，
 * 跨站部署时 Next 服务端根本收不到它，服务端守卫会静默失效。
 */
export default function DashboardPage() {
  return (
    <AuthPageShell title="我的账号" description="当前登录的账号信息。">
      <DashboardPanel />
    </AuthPageShell>
  );
}
