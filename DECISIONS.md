# 决策日志

只增不改的轻量决策留痕：选了什么、否掉了什么、什么条件下回来重审。决策被推翻时追加新条目并注明取代关系，不回改旧条目。只记有真实取舍、有改动成本、或依赖可变前提的决策。

## 2026-08-21 决策：暗色主题不加开关，实际效果为跟随系统

- 选了什么：暗色 token 放 `:root` 为默认，浅色走 `@media (prefers-color-scheme: light)`，不做显式主题开关。现代浏览器没有「无偏好」态（系统浅色即报告 light），所以实际用户效果等价于跟随系统。
- 否掉了什么 / 为什么：强制全员暗色——丢掉系统浅色用户的原生一致性；显式主题开关——当前只有认证和账号页，为一个开关引入持久化与首帧闪烁处理不划算。
- 当时的前提：页面只有认证 + 账号信息；「暗色优先」指设计投入顺序（先把暗色做到位），不是强制所有人见暗色。
- 何时重审：出现真正的控制台工作区页面、或明确想让多数用户默认见暗色时，加显式主题控制（class 策略 + 持久化）。
- 相关：`apps/web/src/app/globals.css`、`apps/web/DESIGN.md` §2、PR #11 的 QA 观察项。

## 2026-08-22 决策：不建 CHANGELOG

- 选了什么：不维护 `CHANGELOG.md`。
- 否掉了什么 / 为什么：新建 CHANGELOG——main 是 squash 合入的一条直线，每条 commit 即一个切片且正文写明「为什么」，`git log` 已是可读历史；没有外部消费者时再养一份人工同步的变更文件是纯负债。
- 当时的前提：无对外发布的包、无开放 API 消费者、单人开发。
- 何时重审：出现外部消费者时——发布 npm 包、开放 API 给第三方、或 iOS 上架需要 release notes。
- 相关：`README.md` 常用命令一节、PR #14 交付说明。

## 2026-08-22 决策：coordinator 是主会话角色，不默认 spawn

- 选了什么：主会话亲自承担 coordinator 角色；`coordinator` subagent 仅在多个互相独立的大需求需要并行编排时才 spawn（隔离各线编排上下文），并补 `Bash` 使其能走完收尾。
- 否掉了什么 / 为什么：description 原有的 "Use PROACTIVELY"（为普通多步骤需求 spawn coordinator）——多一层就多一次需求转述失真；subagent 够不着用户，无法用提问锁方向，而编排恰是决策最密集的环节；原工具集无 Bash，合 PR、清 worktree 等收尾做不了只能弹回主会话。
- 当时的前提：单人开发，需求以串行推进为主，很少出现多条独立大需求同时开工。
- 何时重审：经常出现 ≥2 条独立大需求并行推进时，验证 spawn 模式的实际收益与顺畅度。
- 相关：`.claude/agents/coordinator.md`、`CLAUDE.md` 默认工作流、PR #15。

## 2026-08-23 决策：任务列表游标的精度对齐，选"把列收窄到毫秒"而不是"让游标走全精度"

- 选了什么：`task.created_at` / `updated_at` 声明为 `timestamptz(3)`，让 `Date` 往返无损；游标继续用 `record.createdAt.toISOString()` 编码 `(created_at, id)`，repo 的 keyset 谓词与索引一个字不用改。
- 否掉了什么 / 为什么：让 repo/cursor 走全精度（drizzle `mode: "string"` 或自定义列类型，保留微秒原串再比较）——要改列映射、放弃 `Date` 的便利，换来的只是亚毫秒的创建时间分辨率，而任务列表不需要它。"什么都不做"不是选项：列为 `timestamptz(6)` 时游标上界被 `Date` **截断**（不是四舍五入），同毫秒内落在"截断值与页边界行之间"的记录**在之后任何一页都不会再出现**——实测 8 路并发插 200 次有 155 行处于风险中，10 条并发创建翻完全部页面只走到 8 条。
- 当时的前提：分页正确性只要求读写两侧对**同一个全序**达成一致，并列由 `id` 决胜即可（`id` 是 v4 UUID，同毫秒内的先后是任意但稳定的）。PG 在 `timestamptz(3)` 上是**进位**、JS `Date` 是**截断**，方向相反但无害——舍入只发生在赋值那一刻，此后列里每个值都是整毫秒（实测：40 行 `defaultNow()` 落库后微秒位全为 `000`，游标 ISO 回喂 PG 的相等性 40/40 为真；显式写 `.999600` 也被列收成整毫秒，即带外写入也塞不进亚毫秒值）。
- 何时重审：出现需要亚毫秒创建顺序的需求（例如按提交时刻严格排序的审计流），或换掉 drizzle 的 timestamptz→`Date` 映射时。届时要连带重审游标编码，两者必须同精度。
- 相关：`apps/api/src/modules/task/{schema.ts,cursor.ts,repo.ts}`、PR #18（reviewer 直连 Postgres 证出该 BLOCKER，QA 用 12 路并发复验 22 页不重不漏）。

## 2026-08-23 决策：自有端点的 CSRF 只在"带 cookie"时校验 Origin，且可信集合恒含 api 自身的源

- 选了什么：`shared/csrf.ts` 对状态改变方法（POST/PUT/PATCH/DELETE）仅在请求带 `Cookie` 头时要求 `Origin` ∈ `AUTH_TRUSTED_ORIGINS` ∪ {`BETTER_AUTH_URL` 的源}，否则 403 `INVALID_ORIGIN`；不带 cookie（bearer/原生客户端）跳过。`ownBaseUrl` 是 `CsrfOptions` / `AppDeps` 上的**必填**字段——漏传是编译错误，不是静默降级。
- 否掉了什么 / 为什么：① 照搬 better-auth 对 sign-in 的更严分支（无 cookie 也校验 Origin）——会把"iOS 能否调用自有写接口"绑到"`URLSession` 到底发了什么头"这个本仓库**未实测**的推断上，而客户端不可热修，赌错的代价是全量写操作 403，换来的安全收益为零（那一格本就没有可被冒用的凭证）。② 把 api 自身源加进 `AUTH_TRUSTED_ORIGINS`——那份清单同时是 CORS 白名单，为了 iOS 往里加东西等于放宽浏览器侧的信任边界；做成独立参数则"改配置改不掉这条规则"。③ 要求 iOS 关掉 cookie jar（`httpShouldSetCookies = false`）——同样押在未实测的客户端行为上，且客户端不可热修。
- 当时的前提：CSRF 防的是"浏览器**自动**附带凭证"，而只有 cookie 会被自动附带；bearer 必须由客户端主动写头，跨站页面拿不到，所以"bearer + 恶意 Origin"那一格没凭证只会 401。信任自身源不是放宽：`Origin` 由浏览器控制，跨站页面无法把它伪造成 api 自己的源；能伪造 Origin 的非浏览器调用方同样可以干脆不发 cookie。web 与 api **跨源**部署（3000 / 3001）。
- 何时重审：把 api 反代到与 web 同源时（CORS 整体不生效，`packages/contracts` §6 前提 a 已标注该部署形态需另做加固）；或 better-auth 改变 `getTrustedOrigins`（不再隐式信任 baseURL 源）时——本决策正是镜像它的行为。
- 相关：`apps/api/src/shared/csrf.ts`、`apps/api/src/app.ts`、`packages/contracts/src/index.ts` 第 4 节、PR #18（七格矩阵在中间件级与真端点级各有一套测试，QA 另打了后缀伪装 / scheme / 大小写 / 字面量 `null` 四种变体）。
