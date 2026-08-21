---
name: hono-api
description: 在 apps/api（Hono + 单体模块化）中实现接口功能时使用：模块归属判定、路由与 zod 校验、service/repo 分层、错误处理、测试的 SOP。触发词：api、Hono、模块、路由、endpoint 实现、middleware。
---

# Hono API SOP（单体模块化）

与 `api-design` skill 的分工：那边产出冻结的契约，本 skill 是在 `apps/api` 里把契约实现出来的方法。硬性边界见 `.claude/rules/architecture.md`「API 单体模块化」。

**目录形态**：

```
src/
  index.ts            入口：serve + 优雅停机（不放业务）
  app.ts              组装层：全局中间件 + 挂载各模块路由（不放业务）
  shared/             跨模块共享内核：errors、db、logger 等，保持最小
  modules/<domain>/   业务模块（health、task、…）
    index.ts          模块公开入口——跨模块只允许 import 这里
    routes.ts         路由：解析/校验/序列化，不含业务判断
    service.ts        业务逻辑（纯函数优先，依赖注入）
    repo.ts           数据访问（有存储时）
```

## 步骤 1：判定模块归属

新功能按领域名词归入 `modules/<domain>`；找不到合适模块就新建一个（目录 + index.ts 公开入口），不塞进"看起来接近"的模块。

- ✅ 检查点：模块名是领域词汇（task、schedule），不是技术词汇（utils、common）。

## 步骤 2：写路由（契约同源校验）

- 每个 endpoint 的请求/响应 schema 来自 `packages/contracts`，路由入口用 zod 校验输入（body/query/param），校验失败抛 `AppError(400, "VALIDATION_FAILED", ...)`。
- routes.ts 只做三件事：解析输入 → 调 service → 序列化输出；出现 if 业务判断就该下移到 service。
- 路由用链式定义并保持类型可导出（Hono 的 RPC 类型可供 web 端推导）。

## 步骤 3：写 service 与 repo

- service 是业务规则的家：接收已校验的输入，返回领域结果或抛 `AppError`（带稳定 code）。
- 依赖（repo、时钟、外部 client）通过参数/工厂注入，不在 service 内部就地构造——否则无法测试。
- repo 只做存取，不含业务判断；跨模块需要别人的数据时调对方模块的公开 service，不直连对方的表。

## 步骤 4：错误处理

- 业务错误一律抛 `shared/errors.ts` 的 `AppError(status, code, message)`；code 是契约的一部分，命名稳定（`TASK_NOT_FOUND`）。
- 不在模块内 try/catch 转 Response——`app.onError` 统一映射为契约错误格式；未知错误细节只进日志（security.md）。

## 步骤 5：测试

- 用 `createApp().request(...)` 直接打内存中的 app（无需起端口），断言状态码 + 用 contracts schema parse 响应。
- 每个 endpoint：正向 + 每个声明的错误路径各一个测试；service 的业务规则单测穷举边界。
- 按 `.claude/rules/tdd.md` 测试先行；分层与数据策略见 `backend-testing` skill。

## 完成检查

- [ ] 新代码都在正确的 module 内，跨模块只走公开入口
- [ ] 输入经 zod 校验、错误走 AppError + 稳定 code
- [ ] 每个 endpoint 有正向 + 错误路径测试（app.request 级）
- [ ] `turbo run build typecheck test --filter=@agent-coordinator/api` 全绿

## 最佳实践（推荐，非强制；偏离时说明理由）

- 模块间协作优先"调对方 service"；出现双向调用说明边界划错，考虑合并或抽第三个模块。
- shared/ 保持克制：放第三个模块也要用的东西；只有两个模块用时先放其中一方并从公开入口导出。
- 中间件按作用域挂载：全局的（日志、trace id）进 app.ts，模块私有的（某模块的鉴权）挂在该模块的 Hono 实例上。
- 单体模块化是为将来可拆服务留门：模块对外只暴露 service 接口 + 事件，不共享表结构——真要拆时边界就是现成的。
- 路由 handler 保持一屏内；超了先怀疑业务逻辑漏进了路由层。
- `dev` 用 tsx watch 跑 TS 源码；生产走 `build` 产物（node dist），两条路径都要能启动。
