import { render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { anonymousSession, authenticatedSession, gate, stubFetch } from "@/test-support/stub-fetch";

/**
 * 深链接登录（QA 场景 5）：访问受保护页 → 被守卫弹到登录 → 登录成功 → 应当回到目标页。
 *
 * 这条路径的坑在于**会话 store 是模块级缓存**：匿名那次访问已经把它解析成"无会话"，
 * 登录成功后重新挂载受保护页时，store 会先同步吐出缓存的 `data=null`，
 * 真正的 get-session 还在路上。如果这一刻被判成"未登录"，用户就会在登录成功后
 * 被无声地弹回登录页——服务端会话其实已经建立了。
 *
 * QA 隔离出四种到达登录页的方式，区别只在"本次页面生命周期内守卫跑没跑过"：
 *   A) 直接整页加载 /sign-in           —— 守卫没跑过（= 全新的模块状态）
 *   B) 从 /dashboard 被守卫弹过来       —— 守卫跑过并判了未登录  ← 真实用户路径
 *   C) 从首页点链接进 /sign-in（SPA）   —— 守卫没跑过
 *   D) SPA 导航到 /dashboard 被弹走     —— 守卫跑过并判了未登录
 * 整页加载会重置模块状态，所以 A/C 天然没事；B/D 才是必须覆盖的。
 */

const { replace } = vi.hoisted(() => ({ replace: vi.fn() }));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace, push: vi.fn(), refresh: vi.fn() }),
  usePathname: () => "/dashboard",
}));

const USER = { id: "u1", name: "QA Web", email: "qa@example.com" };
const SECRET = "受保护内容";

beforeEach(() => {
  replace.mockClear();
  // 每个用例一份全新的模块图：better-auth 的会话 store 是模块级单例，
  // 不重置的话用例之间会互相污染（这正是被测 bug 的同款机制）。
  vi.resetModules();
});

/** 同一份模块图里取出守卫与登录动作——必须同源，否则共享不到同一个会话 store。 */
const loadAuth = async () => {
  const [{ RequireSession }, { signIn }] = await Promise.all([
    import("./require-session"),
    import("@/lib/auth/actions"),
  ]);
  const Protected = ({ children }: { children: ReactNode }) => (
    <RequireSession>{children}</RequireSession>
  );
  return { Protected, signIn };
};

const signInCredentials = { email: "qa@example.com", password: "correct-horse-battery" };

describe("深链接登录（B/D：守卫已经判过一次未登录）", () => {
  it("被守卫弹到登录页之后再登录，不能又被弹回登录页", async () => {
    const { Protected, signIn } = await loadAuth();

    // ── 阶段 1：未登录访问受保护页，守卫把人弹到登录页
    stubFetch({ "/get-session": anonymousSession });
    const first = render(<Protected>{SECRET}</Protected>);
    await waitFor(() => expect(replace).toHaveBeenCalledWith("/sign-in?redirectTo=%2Fdashboard"));
    first.unmount(); // 相当于导航去了 /sign-in

    // ── 阶段 2：在登录页输入正确密码，服务端会话建立成功
    // get-session 用闸门按住：真实环境里它比导航晚回来（QA 实测晚 18ms），
    // bug 就发生在这段窗口里。
    const sessionGate = gate();
    replace.mockClear();
    stubFetch({
      "/sign-in/email": { status: 200, body: { token: "t", user: USER } },
      "/get-session": authenticatedSession(USER, sessionGate.opened),
    });
    const result = await signIn(signInCredentials);
    expect(result).toEqual({ ok: true });

    // ── 阶段 3：登录成功后导航回目标页，此刻会话刷新还在路上
    render(<Protected>{SECRET}</Protected>);

    // 关键断言：会话尚未确认 ≠ 确定未登录。这一刻绝不能把人弹回登录页。
    await waitFor(() => expect(screen.getByRole("status")).toBeInTheDocument());
    expect(replace).not.toHaveBeenCalled();

    // ── 阶段 4：会话回来了，受保护内容渲染出来，全程没有被弹走
    sessionGate.open();
    expect(await screen.findByText(SECRET)).toBeInTheDocument();
    expect(replace).not.toHaveBeenCalled();
  });

  it("注册路径同样不能把新用户丢回登录页", async () => {
    const [{ RequireSession }, { signUp }] = await Promise.all([
      import("./require-session"),
      import("@/lib/auth/actions"),
    ]);

    stubFetch({ "/get-session": anonymousSession });
    const first = render(<RequireSession>{SECRET}</RequireSession>);
    await waitFor(() => expect(replace).toHaveBeenCalled());
    first.unmount();

    const sessionGate = gate();
    replace.mockClear();
    stubFetch({
      "/sign-up/email": { status: 200, body: { token: "t", user: USER } },
      "/get-session": authenticatedSession(USER, sessionGate.opened),
    });
    expect(await signUp({ name: "QA Web", ...signInCredentials })).toEqual({ ok: true });

    render(<RequireSession>{SECRET}</RequireSession>);
    expect(replace).not.toHaveBeenCalled();

    sessionGate.open();
    expect(await screen.findByText(SECRET)).toBeInTheDocument();
    expect(replace).not.toHaveBeenCalled();
  });

  it("真的没登录时仍然要弹到登录页——修复不能把守卫整个弄失效", async () => {
    const { Protected } = await loadAuth();

    stubFetch({ "/get-session": anonymousSession });
    render(<Protected>{SECRET}</Protected>);

    await waitFor(() => expect(replace).toHaveBeenCalledWith("/sign-in?redirectTo=%2Fdashboard"));
    expect(screen.queryByText(SECRET)).not.toBeInTheDocument();
  });

  it("登出之后再访问受保护页，仍然要弹到登录页（缓存里有旧会话也不行）", async () => {
    const [{ RequireSession }, { signOut }] = await Promise.all([
      import("./require-session"),
      import("@/lib/auth/actions"),
    ]);

    // 先建立登录态
    stubFetch({ "/get-session": authenticatedSession(USER) });
    const first = render(<RequireSession>{SECRET}</RequireSession>);
    expect(await screen.findByText(SECRET)).toBeInTheDocument();
    first.unmount();

    // 登出
    replace.mockClear();
    stubFetch({
      "/sign-out": { status: 200, body: { success: true } },
      "/get-session": anonymousSession,
    });
    expect(await signOut()).toEqual({ ok: true });

    // 再访问受保护页：必须被弹走，不能因为"可能在重校验"就把内容放出去
    render(<RequireSession>{SECRET}</RequireSession>);
    await waitFor(() => expect(replace).toHaveBeenCalledWith("/sign-in?redirectTo=%2Fdashboard"));
    expect(screen.queryByText(SECRET)).not.toBeInTheDocument();
  });
});

describe("A/C：整页加载登录页（守卫未跑过）——回归保护", () => {
  it("全新的模块状态下登录后能进受保护页", async () => {
    const { Protected, signIn } = await loadAuth();

    const sessionGate = gate();
    stubFetch({
      "/sign-in/email": { status: 200, body: { token: "t", user: USER } },
      "/get-session": authenticatedSession(USER, sessionGate.opened),
    });
    expect(await signIn(signInCredentials)).toEqual({ ok: true });

    render(<Protected>{SECRET}</Protected>);
    expect(replace).not.toHaveBeenCalled();

    sessionGate.open();
    expect(await screen.findByText(SECRET)).toBeInTheDocument();
  });
});
