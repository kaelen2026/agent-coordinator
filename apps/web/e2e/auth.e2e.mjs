/**
 * 认证流程的真实浏览器验收脚本。
 *
 * 为什么需要它：src 下的 129 个用例把全局 `fetch` stub 掉了，能断言"请求带了
 * credentials: include"，但**无法**覆盖浏览器实际是否把 cookie 发了出去、
 * api 的 SameSite / Partitioned / Access-Control-Expose-Headers 这套组合在真实
 * Chromium 下是否成立——而这正是 api 侧反复确认过的地方。这里全程真实：
 * 真实浏览器、真实 api、真实数据库，不 mock 任何东西。
 *
 * 不接 CI（需要先起基建与 api），由人手动跑。用法见同目录 README.md。
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";

const WEB = process.env.WEB_BASE_URL ?? "http://localhost:3000";
const API = process.env.API_BASE_URL ?? "http://localhost:3001";
const OUT = process.env.E2E_ARTIFACT_DIR ?? mkdtempSync(join(tmpdir(), "auth-e2e-"));

const stamp = Date.now();
const EMAIL = `e2e-${stamp}@example.com`;
const PASSWORD = "correct-horse-battery-staple";
const NAME = "端到端阿玖";

const results = [];
const check = (label, ok, detail = "") => {
  results.push({ label, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// api 对 sign-in / sign-up 的限流是每 IP 每窗口只有几次。步骤之间必须让窗口过去，
// 否则测出来的是限流而不是功能。窗口长度是服务端配置，这里取一个宽裕值。
const cooldown = () => sleep(11000);

// Next 自己会插一个空的 role="alert" 路由播报节点，按 data-slot 精确定位到业务 Alert
const businessAlert = (page) => page.locator('[data-slot="alert"]');

const shot = (page, name) => page.screenshot({ path: join(OUT, `${name}.png`), fullPage: true });

const preflight = async () => {
  for (const [label, url] of [
    ["web", WEB],
    ["api", `${API}/healthz`],
  ]) {
    try {
      await fetch(url);
    } catch {
      console.error(
        `\n${label} 起来了吗？连不上 ${url}。\n请先按 e2e/README.md 起好基建、api 与 web，或用 WEB_BASE_URL / API_BASE_URL 指到实际地址。\n`,
      );
      process.exit(1);
    }
  }
};

await preflight();
console.log(`web=${WEB}  api=${API}\n截图输出目录：${OUT}\n`);

const browser = await chromium.launch();
const context = await browser.newContext();
const page = await context.newPage();

try {
  // ── 1. 未登录访问受保护页 → 被引导到登录 ────────────────────────────────
  await page.goto(`${WEB}/dashboard`);
  await page.waitForURL(/\/sign-in/, { timeout: 15000 });
  check(
    "未登录访问 /dashboard 被引导到登录页并带上 redirectTo",
    page.url().includes("/sign-in?redirectTo=%2Fdashboard"),
    page.url(),
  );
  await shot(page, "01-guard-redirect");

  // ── 2. 注册 → 自动登录 → 落到受保护页 ──────────────────────────────────
  // 关键：**从被弹到的这个登录页出发**，点链接去注册，全程不 goto。
  // 用 goto 重新整页加载会把客户端的会话缓存清空，正好绕开"守卫已经判过一次未登录"
  // 这个状态——真实用户不会那么走，这条路径上曾经藏过一个 BLOCKER。
  await page.getByRole("link", { name: "注册一个" }).click();
  await page.waitForURL(/\/sign-up/, { timeout: 15000 });
  await page.getByLabel("姓名").fill(NAME);
  await page.getByLabel("邮箱").fill(EMAIL);
  await page.getByLabel("密码").fill(PASSWORD);
  await page.getByRole("button", { name: "注册" }).click();
  await page.waitForURL(/\/dashboard/, { timeout: 20000 });
  await page.getByText(EMAIL).waitFor({ timeout: 20000 });
  check(
    "从被守卫弹出的登录页出发注册，自动登录并落到 /dashboard（不经整页刷新）",
    page.url().includes("/dashboard") && (await page.getByText(EMAIL).isVisible()),
    `${page.url()} / ${EMAIL}`,
  );
  await shot(page, "02-signed-up-dashboard");

  // ── 3. 会话只走 HttpOnly cookie，明文 token 不落本地存储 ────────────────
  const storage = await page.evaluate(() => ({
    local: Object.entries(window.localStorage),
    session: Object.entries(window.sessionStorage),
  }));
  check(
    "localStorage / sessionStorage 里没有任何 token",
    storage.local.length === 0 && storage.session.length === 0,
    JSON.stringify(storage),
  );
  const sessionCookie = (await context.cookies()).find((c) => c.name.includes("session_token"));
  check(
    "会话走 HttpOnly cookie（浏览器真的收下并回传了它）",
    sessionCookie !== undefined && sessionCookie.httpOnly === true,
    JSON.stringify(sessionCookie ?? null),
  );

  // ── 4. 刷新后仍在登录态 ────────────────────────────────────────────────
  await page.reload();
  await page.getByText(EMAIL).waitFor({ timeout: 20000 });
  check("刷新页面后仍是登录态", page.url().includes("/dashboard"));
  await shot(page, "03-after-reload");

  // ── 5. 登出 ────────────────────────────────────────────────────────────
  await page.getByRole("button", { name: "登出" }).click();
  await page.waitForURL(/\/sign-in/, { timeout: 20000 });
  check(
    "登出后跳到登录页并渲染出登录表单",
    page.url().includes("/sign-in") &&
      (await page.getByRole("button", { name: "登录" }).isVisible()),
    page.url(),
  );
  await shot(page, "04-signed-out");

  // ── 6. 登出后受保护页再次被拦 ──────────────────────────────────────────
  await page.goto(`${WEB}/dashboard`);
  await page.waitForURL(/\/sign-in/, { timeout: 20000 });
  check("登出后访问 /dashboard 再次被引导到登录", page.url().includes("redirectTo=%2Fdashboard"));

  // ── 7. 密码错：不透露账号是否存在 ──────────────────────────────────────
  await cooldown();
  await page.goto(`${WEB}/sign-in`);
  await page.getByLabel("邮箱").fill(EMAIL);
  await page.getByLabel("密码").fill("definitely-the-wrong-password");
  await page.getByRole("button", { name: "登录" }).click();
  const wrongPw = await businessAlert(page).textContent({ timeout: 20000 });
  check(
    "密码错提示「邮箱或密码不正确」，不区分账号是否存在",
    wrongPw.includes("邮箱或密码不正确") && !/未注册|不存在/.test(wrongPw),
    wrongPw.trim(),
  );
  await shot(page, "05-wrong-password");

  // ── 8. 重复邮箱 ────────────────────────────────────────────────────────
  await cooldown();
  await page.goto(`${WEB}/sign-up`);
  await page.getByLabel("姓名").fill(NAME);
  await page.getByLabel("邮箱").fill(EMAIL);
  await page.getByLabel("密码").fill(PASSWORD);
  await page.getByRole("button", { name: "注册" }).click();
  const dupe = await businessAlert(page).textContent({ timeout: 20000 });
  check("重复邮箱提示已被注册", dupe.includes("该邮箱已被注册"), dupe.trim());
  await shot(page, "06-duplicate-email");

  // ── 9. 密码过短：本地拦截，一个请求都不发（省限流额度）──────────────────
  await page.goto(`${WEB}/sign-up`);
  let signUpRequests = 0;
  const countSignUp = (req) => {
    if (req.url().includes("/api/auth/sign-up")) signUpRequests += 1;
  };
  page.on("request", countSignUp);
  await page.getByLabel("姓名").fill(NAME);
  await page.getByLabel("邮箱").fill(`short-${stamp}@example.com`);
  await page.getByLabel("密码").fill("short");
  await page.getByRole("button", { name: "注册" }).click();
  await page.getByText("密码至少 12 位").waitFor({ timeout: 15000 });
  await sleep(1000);
  page.off("request", countSignUp);
  check(
    "密码过短在本地就被拦下，没有发出注册请求",
    signUpRequests === 0,
    `requests=${signUpRequests}`,
  );
  await shot(page, "07-password-too-short");

  // ── 10. 429：页面显示的秒数必须等于响应头给的值 ─────────────────────────
  await cooldown();
  await page.goto(`${WEB}/sign-in`);
  let observedRetryAfter = null;
  page.on("response", (res) => {
    if (res.url().includes("/api/auth/sign-in") && res.status() === 429) {
      observedRetryAfter = res.headers()["x-retry-after"] ?? null;
    }
  });
  for (let i = 0; i < 5; i += 1) {
    await page.getByLabel("邮箱").fill(EMAIL);
    await page.getByLabel("密码").fill("wrong-password-attempt");
    const button = page.getByRole("button", { name: "登录" });
    if (!(await button.isEnabled())) break;
    await button.click();
    await sleep(700);
  }
  const limited = await businessAlert(page).textContent({ timeout: 20000 });
  check(
    "连打触发 429，UI 显示的等待秒数来自响应头 X-Retry-After（写死常量过不了这条）",
    /请在 \d+ 秒后重试/.test(limited) &&
      observedRetryAfter !== null &&
      limited.includes(`${observedRetryAfter} 秒`),
    `alert="${limited.trim()}"  X-Retry-After=${observedRetryAfter}`,
  );
  check("限流期间提交按钮被禁用", await page.getByRole("button", { name: "登录" }).isDisabled());
  await shot(page, "08-rate-limited");

  const before = await businessAlert(page).textContent();
  await sleep(2500);
  const after = await businessAlert(page).textContent();
  check("限流倒计时逐秒递减", before !== after, `${before.trim()} -> ${after.trim()}`);

  // ── 11. 深链接登录：被守卫弹到登录页，就地登录，必须回到目标页 ────────────
  // 这一步刻意**不** goto 登录页。直接构造 `/sign-in?redirectTo=...` 是整页加载，
  // 客户端会话缓存是干净的；而真实用户是被守卫从 /dashboard 弹过来的，
  // 那时缓存里已经存着一条"无会话"的结论。两者会走进完全不同的代码路径。
  await cooldown();
  await page.goto(`${WEB}/dashboard`);
  await page.waitForURL(/\/sign-in\?redirectTo=%2Fdashboard/, { timeout: 20000 });

  const navigations = [];
  const recordNavigation = (frame) => {
    if (frame === page.mainFrame()) navigations.push(frame.url());
  };
  page.on("framenavigated", recordNavigation);

  await page.getByLabel("邮箱").fill(EMAIL);
  await page.getByLabel("密码").fill(PASSWORD);
  await page.getByRole("button", { name: "登录" }).click();
  await page.getByText(EMAIL).waitFor({ timeout: 20000 });
  page.off("framenavigated", recordNavigation);

  check(
    "被守卫弹到登录页后就地登录，回到 /dashboard 并渲染出当前用户",
    page.url().includes("/dashboard") && (await page.getByText(EMAIL).isVisible()),
    page.url(),
  );
  // 登录成功后又被弹回登录页是曾经的 BLOCKER：URL 会先变 /dashboard 再跳回 /sign-in，
  // 只看最终状态可能因为重试而看不出来，所以把中途的导航序列也钉住。
  check(
    "登录成功后没有被弹回登录页（导航序列里不出现 sign-in 回跳）",
    !navigations.some((url) => url.includes("/sign-in")),
    `navigations=${JSON.stringify(navigations.map((u) => new URL(u).pathname + new URL(u).search))}`,
  );
  await shot(page, "09-signed-in-again");
} catch (error) {
  check("脚本执行", false, String(error));
  await shot(page, "99-failure");
} finally {
  await browser.close();
}

console.log("\n================ SUMMARY ================");
const failed = results.filter((r) => !r.ok);
console.log(`${results.length - failed.length}/${results.length} passed`);
console.log(`截图：${OUT}`);
for (const f of failed) console.log(`FAILED: ${f.label} — ${f.detail}`);
process.exit(failed.length > 0 ? 1 : 0);
