---
name: react-nextjs
description: 编写 React 组件与使用 Next.js 框架机制时使用：组件拆分、hooks 纪律、重渲染控制、渲染模式与缓存决策、Server Actions 与数据变更的 SOP。触发词：React、组件、hooks、useEffect、渲染、缓存、Server Action、revalidate。
---

# React / Next.js SOP

与 `web-frontend` skill 的分工：那边是功能交付流程（契约 → 四态 → 交付），本 skill 是写组件和用框架机制的方法。硬性约束见 `.claude/rules/typescript.md`。

## 步骤 1：组件设计

- 先按职责拆分：一个组件只做一件事——要么组织布局（容器），要么渲染数据（展示），要么封装一种交互。
- props 定义行为契约：传数据和回调，不传"怎么渲染"的布尔开关堆（`isCompact`、`hideHeader` 超过两三个时改用组合/children/slots）。
- 复用的判断标准是"第二次出现"，不预先抽象。
- ✅ 检查点：每个组件能用一句话说清职责；props 数量失控（>7）时回头拆。

## 步骤 2：Hooks 纪律

- **先质疑 useEffect**：同步派生值用直接计算或 `useMemo`；响应用户操作放事件处理器；订阅外部系统才是 useEffect 的正当用途。"用 effect 把一个 state 拷贝成另一个 state"是 bug 信号。
- 依赖数组诚实完整，靠 lint（`react-hooks/exhaustive-deps`）保证；想"少触发"不是删依赖，而是重构（把函数移进 effect、用 ref 存最新值、拆分 effect）。
- 相互关联的状态合并为一个对象或 `useReducer`，不维护多个必须同步更新的 useState。
- 逻辑在两个组件间重复时抽自定义 hook（`useXxx`），hook 内部同样遵守以上规则。
- ✅ 检查点：新代码里每个 useEffect 都能回答"订阅了什么外部系统"，答不上来的重构掉。

## 步骤 3：重渲染控制（按需，不预优化）

1. 先找重渲染来源：状态放得太高（下沉状态）、context 值每次渲染新建（拆分 context、memo value）、列表项拿到新引用的 props；
2. 结构手段优先：状态下沉、`children` 提升（把不依赖状态的子树作为 children 传入）；
3. 结构解决不了再用 `memo` / `useMemo` / `useCallback`，且三者配套使用才有效（memo 的组件收到未 memo 的回调等于白 memo）；
4. 列表 key 用稳定业务 ID，禁止用数组索引作可变列表的 key。

- ✅ 检查点：加 memo 前先用 Profiler/渲染日志确认该组件确实是热点。

## 步骤 4：Next.js 渲染与缓存决策

对每个页面按序回答：

1. **内容对所有用户相同且可预生成？** → 静态渲染（默认），更新用 `revalidate`（ISR）；
2. **依赖请求上下文（cookies/headers/searchParams）？** → 动态渲染，只在需要的组件里读取，别让一个 `cookies()` 把整页拖成动态；
3. **数据多久算新鲜？** → 用 fetch 的 `next.revalidate` / `cache` 选项按数据源分别声明，不全局 `no-store` 一刀切；
4. **写操作后如何刷新？** → `revalidatePath`/`revalidateTag` 精确失效，不靠客户端强刷。

- ✅ 检查点：能说出每个页面是静态还是动态、为什么。

## 步骤 5：数据变更（mutation）

- 表单提交与写操作用 Server Action（配 `useActionState` 拿 pending/错误状态），或 route handler（供非表单客户端调用）；二选一，同类操作全项目统一。
- Server Action 内部：先校验输入（zod，见 typescript.md）、再鉴权、再执行，最后 `revalidatePath`/`revalidateTag`；Action 是公开入口，安全要求等同 API endpoint。
- 乐观更新只用于低风险、可回滚的交互（点赞、切换开关），失败必须回滚并提示。

## 完成检查

- [ ] 无"state 拷贝 state"式 useEffect；依赖数组过 lint
- [ ] memo/useMemo 只出现在确认过的热点上
- [ ] 每个页面的渲染模式与缓存策略能说出理由
- [ ] Server Action 有输入校验与鉴权，写后精确失效缓存

## 最佳实践（推荐，非强制；偏离时说明理由）

- 文件组织按功能就近（colocate）：组件与它的 hook、测试、样式放同目录；跨功能复用的才提升到共享层——过早提升制造伪公共代码。
- Context 按变更频率拆分：静态配置（主题、用户身份）与高频状态分开，避免高频更新震荡整棵订阅树。
- 表单默认非受控 + 提交时取值（配 Server Action 天然契合）；只有需要实时联动（即时校验、依赖字段）才受控。
- Suspense 边界放在"用户可感知的加载单元"上（一个卡片、一个列表），不是每个组件一个，也不是整页一个。
- RSC → client 组件的 props 是序列化边界：传 id 和标量，不传整个大对象图；client 组件需要更多数据时自己通过请求层取。
- 派生状态不存 state：能从 props/state 算出来的值直接算，存副本必然出现不同步。
- 自定义 hook 返回稳定结构（对象字段固定），内部用 `useCallback`/`useMemo` 稳定引用，让调用方可以安全地放进依赖数组。
