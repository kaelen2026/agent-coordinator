# 认证流程的真实浏览器验收

`auth.e2e.mjs` 用 Playwright 驱动真实 Chromium，打真实 api 与真实数据库，**不 mock 任何东西**。

## 为什么它不能被 `pnpm test` 替代

`src` 下的单测把全局 `fetch` stub 掉了。那层能断言"请求带了 `credentials: include`"，
但断言不了**浏览器实际有没有把 cookie 发出去**——`SameSite` / `Partitioned` /
`Access-Control-Expose-Headers` 这套组合是否成立，只有真实浏览器说了算。
两件事只有这里能验：

1. 跨源带 cookie 的完整往返（注册 → 会话建立 → 刷新仍在 → 登出 → 会话失效）；
2. 429 时页面显示的秒数与响应头 `X-Retry-After` **数值一致**（写死常量过不了这条断言）。

**不接 CI**：它需要先起基建和 api。接 CI 是后续切片的事。

## 跑之前

在仓库根目录：

```bash
pnpm infra:up                                      # postgres + redis
cp .env.example .env                               # 然后按文件里的说明生成 BETTER_AUTH_SECRET：
                                                   #   openssl rand -hex 32
pnpm --filter=@agent-coordinator/api db:migrate
pnpm --filter=@agent-coordinator/api dev           # api 监听 3001，保持前台运行
```

另开一个终端，起 web（用生产构建，跟线上一致）：

```bash
pnpm --filter=@agent-coordinator/web build
pnpm --filter=@agent-coordinator/web exec next start -p 3000
```

首次还要装浏览器（只需一次，装到用户级缓存，不进仓库）：

```bash
pnpm --filter=@agent-coordinator/web exec playwright install chromium
```

## 跑

```bash
pnpm --filter=@agent-coordinator/web test:e2e
```

输出是逐条 `PASS` / `FAIL`，末尾一行汇总；截图写到临时目录，路径在结尾打印。
全过退出码 0，有失败退出码 1。

## 端口被占用怎么办

3000 被别的进程占着时（`lsof -nP -iTCP:3000 -sTCP:LISTEN` 可以看是谁），换个端口跑，
**两处都要改**：

```bash
# 1) api 要信任新来源，否则 CORS 不给过、cookie 也带不上。
#    改仓库根 .env，然后重启 api（tsx watch 不会因为 .env 变化而重启，得手动重启）
AUTH_TRUSTED_ORIGINS=http://localhost:3000,http://localhost:3100

# 2) 起 web 并把地址告诉脚本
pnpm --filter=@agent-coordinator/web exec next start -p 3100
WEB_BASE_URL=http://localhost:3100 pnpm --filter=@agent-coordinator/web test:e2e
```

漏了第 1 步的症状：受保护页显示"网络连接失败"而不是跳转登录——那是 CORS 挡了
`get-session`，不是应用 bug。可以用这条确认 api 认不认这个来源
（返回头里**有没有** `access-control-allow-origin` 就是答案）：

```bash
curl -sSi -H 'Origin: http://localhost:3100' http://localhost:3001/api/auth/get-session | grep -i allow-origin
```

## 环境变量

| 变量 | 默认值 | 说明 |
|---|---|---|
| `WEB_BASE_URL` | `http://localhost:3000` | web 地址 |
| `API_BASE_URL` | `http://localhost:3001` | 仅用于启动前的连通性检查 |
| `E2E_ARTIFACT_DIR` | 临时目录 | 截图输出目录 |

## 已知限制

- **会往数据库里留数据**：每次跑注册 1 个新用户（邮箱带时间戳，不会撞车），脚本不做清理。
  想清干净就 `pnpm infra:reset`。
- **跑一趟约 1 分钟**：登录/注册限流是每 IP 每窗口只有几次，步骤之间必须等窗口过去，
  否则测出来的是限流而不是功能。脚本里的 `cooldown()` 就是干这个的，别删。
- **只覆盖同站部署**（web 与 api 都在 localhost，cookie 忽略端口所以算同站）。
  真正的跨站部署要 api 侧把 `AUTH_COOKIE_CROSS_SITE` 置 true，这里验不了。
