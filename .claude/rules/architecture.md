# 架构规则

所有实现与评审必须遵守。违反其中任何一条属于 reviewer 的 MAJOR 及以上 finding。

## Monorepo 边界（Turborepo + pnpm workspace）

- 仓库布局：`apps/*` 是可部署单元（web / api / worker / ios），`packages/*` 是共享库；操作方法见 `monorepo` skill。
- 依赖方向单向：apps 只能依赖 packages；packages 之间可以依赖但不得成环；**禁止 packages 依赖 apps、禁止 app 之间互相 import**。
- API 契约唯一来源是 `packages/contracts`（zod schema + 类型）：web/api/worker 直接 import，iOS 据此生成/手写 Codable 模型；契约类型在别处重复声明视为违规。
- 内部包引用一律 `workspace:*`，禁止跨包 deep import 内部路径（只走包的 `exports` 入口）。

## 分层与依赖方向

- 分层：`api（handler/router）→ service（业务逻辑）→ repository（数据访问）→ infra（DB/队列/外部客户端）`。
- 依赖只能向下，不允许反向依赖或跨层跳跃（handler 不得直接操作数据库）。
- 业务逻辑集中在 service 层：handler 只做参数解析/校验/序列化，repository 只做数据存取，不含业务判断。

## API 单体模块化（apps/api，Hono）

- `apps/api` 是单体模块化（modular monolith）：业务代码按领域组织在 `src/modules/<domain>/`，每个模块内部自带 routes/service/repo 分层；实现方法见 `hono-api` skill。
- 每个模块只有一个公开入口 `index.ts`：跨模块与组装层（app.ts）只允许 import 该入口，禁止深入模块内部文件。
- 跨模块协作只走对方公开的 service 接口，禁止直接访问对方的 repo 或表。
- `src/shared/` 是最小共享内核（errors/db/logger）；`index.ts`（入口）与 `app.ts`(组装) 不含业务逻辑。
- 业务错误统一抛 `AppError`（稳定 code），由全局 `onError` 映射为 `packages/contracts` 的错误格式；禁止在模块内自行拼错误响应。

## 模块边界

- 模块间通过显式接口（函数签名 / interface / protocol）交互，不 import 对方内部实现。
- 共享代码放公共模块，禁止两个业务模块互相 import（出现即说明需要抽第三方模块）。
- 每个模块用领域词汇命名（如 `task`、`worker`、`schedule`），不用技术词汇兜底（如 `utils2`、`common_helpers`）。

## 接口与契约

- 对外 API 契约先于实现确定（见 `api-design` skill），实现不得偷偷扩展或收窄契约。
- 破坏性变更（删字段、改语义、改状态码）必须走版本化或兼容过渡，不允许直接改。

## 状态与副作用

- 服务进程无状态：会话、任务进度、锁一律放外部存储（DB / Redis），不放进程内存，保证可水平扩展。
- 所有写外部系统的操作必须幂等或有幂等键（见 `distributed-systems` skill）。
- 定时/异步任务通过队列机制（见 `job-queue` skill），不用裸线程 + sleep。

## 配置与依赖注入

- 配置从环境变量/配置文件读取，代码中不出现硬编码的地址、端口、密钥。
- 外部依赖（DB 连接、HTTP client、队列 client）在入口处构造并注入，不在业务代码里就地 new——否则无法测试。

## 错误处理

- 不吞异常：捕获了就必须处理（重试、降级、或转换语义后上抛），禁止空 catch / 裸 except / 只打日志然后当没发生。
- 错误分类程序可判定：可重试错误（网络超时、依赖 5xx、死锁）与不可重试错误（参数非法、业务规则拒绝）在类型或结构上区分开，调用方与队列重试机制能据此决策，不靠解析错误文案。
- 错误信息带上下文（哪个操作、哪个关键 ID 失败），便于排障；但不含敏感信息（红线见 `security.md`）。
- Fail fast：前置条件不满足时立即失败并说明原因，不带病继续产生更难排查的连锁错误。

## 简单优先

- 不为"将来可能"引入抽象：一个实现不需要 interface；出现第二个实现时再抽。
- 单文件超过 ~400 行、单函数超过 ~50 行时考虑拆分，但以内聚为准，不机械执行。
