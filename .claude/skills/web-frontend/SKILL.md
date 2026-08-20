---
name: web-frontend
description: 实现 Web 前端功能（Next.js + TypeScript）时使用：从契约到类型与 schema、server/client 边界规划、请求层、四态页面、测试交付的完整 SOP。触发词：前端、页面、组件、Next.js、React、TypeScript、web。
---

# Web 前端 SOP（Next.js + TypeScript）

硬性约束见 `.claude/rules/typescript.md`；组件编写、hooks、重渲染、缓存与 Server Actions 的具体方法见 `react-nextjs` skill。**输入**：DoD + 已冻结的 API 契约。**输出**：四态齐全、通过 build/tsc/lint/测试的前端实现。

## 步骤 1：从契约生成类型与 schema

- 在 `types/`（或契约生成管线）为每个用到的 endpoint 建：zod schema + `z.infer` 导出的类型，schema 与类型同文件维护。
- 后端未就绪时，基于契约同时建 mock 数据（走同一 schema 校验，保证 mock 不会比真实数据"更宽松"）。
- ✅ 检查点：页面代码里没有手写的重复类型声明。

## 步骤 2：规划 server/client 边界

对每个页面/组件先回答：需要交互或浏览器 API 吗？

- 否 → Server Component（默认），数据在服务端获取（server component / route handler），避免瀑布式客户端请求；
- 是 → `"use client"` 压到叶子组件，客户端只拿它真正需要的数据。

状态归属顺序：能放 URL（searchParams）> 能放服务端 > 请求层缓存（React Query/SWR 或 fetch cache）> 最后才是客户端全局状态。

## 步骤 3：实现请求层

- 请求集中在 api client 模块，组件内不散落 fetch。
- 响应在此处过 zod 校验（运行时边界，见 typescript.md）；错误码 → 用户可读提示的映射统一维护在此。
- 4xx/5xx/网络失败区分为不同错误类型，供组件按类型渲染。

## 步骤 4：实现页面与组件（四态齐全）

每个数据页面必须实现四态，缺一视为未完成：

1. 加载中（路由段 `loading.tsx` 或组件级 skeleton）；
2. 空数据（有引导性的空态，不是白屏）；
3. 错误（路由段 `error.tsx` 兜底 + 组件级按错误类型提示，网络失败给重试入口）；
4. 未登录/无权限（跳转或提示，不裸露数据结构）。

404/重定向用 `notFound()`/`redirect()` 框架原语。前端表单校验只为体验，安全以后端为准。

## 步骤 5：测试

- 组件测交互行为与条件渲染：四态各有用例；
- 请求层测错误分支（4xx/5xx/网络失败/schema 校验失败）；
- 新业务逻辑按 `.claude/rules/tdd.md` 测试先行。

## 步骤 6：交付前验证

依次执行并贴输出：`tsc --noEmit` → lint → 测试 → `next build`。与真实 API（或标注清楚的契约 mock）联调关键路径。

## 完成检查

- [ ] 类型与 schema 契约同源，无重复声明
- [ ] client 边界压到叶子；状态归属经过步骤 2 的顺序检验
- [ ] 四态齐全且各有测试
- [ ] build/tsc/lint/测试全绿（有输出为证）；待联调项已标注

## 最佳实践（推荐，非强制；偏离时说明理由）

- 图片一律 `next/image`（自动尺寸/格式/懒加载）、字体一律 `next/font`（消除布局抖动）；给有尺寸的占位内容预留空间，控制 CLS。
- 重组件（图表、编辑器、地图）用 `next/dynamic` 按需加载；定期跑 bundle 分析，第三方库进 bundle 前先看体积。
- 无障碍从写的时候做：语义标签优先于 div、交互元素键盘可达、表单控件都有 label、图片有 alt——事后补的成本是当时的十倍。
- 每个页面用 Metadata API 声明 title/description；对外可见页面补 Open Graph。
- 全局挂 error boundary 并接上报（含 request_id 便于与后端日志串联）；console 里不留生产环境的调试输出。
- 用户输入的防抖/节流放请求层不放组件里；搜索类请求带取消（AbortController），避免竞态覆盖新结果。
- 文案不硬编码进组件：即使暂不做 i18n，也集中管理便于统一修改与后续国际化。
