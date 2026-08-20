---
name: swiftui
description: 编写 SwiftUI 视图与使用框架机制时使用：视图拆分、状态归属与数据流、重渲染控制、导航与深链、.task 生命周期与并发的 SOP。触发词：SwiftUI、View、@State、@Observable、导航、NavigationStack、动画、渲染。
---

# SwiftUI SOP

与 `ios-development` skill 的分工：那边是功能交付流程（契约 → 五态 → 交付），本 skill 是写视图和用框架机制的方法。硬性约束见 `.claude/rules/swift.md`。

## 步骤 1：视图设计

- 按职责拆分：一个 View 只做一件事——组织布局（容器）、渲染数据（展示）、或封装一种交互；`body` 超过一屏就拆子视图。
- 子视图参数是行为契约：传值和闭包，不传"怎么渲染"的布尔开关堆（超过两三个改用组合/`@ViewBuilder` content 参数）。
- 复用样式抽 `ViewModifier`（配 `View` extension 暴露），不复制粘贴修饰符链。
- ✅ 检查点：每个 View 能一句话说清职责；初始化参数失控（>7）时回头拆。

## 步骤 2：状态归属与数据流

对每个状态先问归谁所有，再选包装器：

- 视图私有的 UI 状态（展开/选中/输入中间态）→ `@State`，且下放到用到它的最小子树；
- 子视图需要读写父状态 → `@Binding` 传递；
- 业务状态 → `@Observable` ViewModel，View 只读状态、发意图；
- 跨层共享的依赖/环境 → `@Environment` 注入，不用全局单例。

派生值不存 state：能从已有状态算出来的直接在 `body` 里算或用计算属性，存副本必然不同步。

- ✅ 检查点：每个 `@State` 都答得出"为什么它不能再往下放"。

## 步骤 3：重渲染与性能控制（按需，不预优化）

1. 先定位：用 `Self._printChanges()`（调试期）确认哪个视图为何刷新；
2. 结构手段优先：把高频变化的状态圈进最小子视图（如计时器文本单独成 View），别让它挂在大容器上；`@Observable` 按属性追踪，View 只读自己用到的属性就不会被无关变更刷新；
3. `body` 保持廉价：不在 `body` 里做排序/过滤/格式化等重计算，移入 ViewModel 或缓存为存储属性；
4. 列表用 `LazyVStack`/`List`，元素 `id` 用稳定业务标识，禁止用索引；
5. 动画显式绑定驱动值（`.animation(_:value:)`），不用无值全局动画。

- ✅ 检查点：性能改动前后各测一次（Instruments 或 _printChanges），凭数据不凭感觉。

## 步骤 4：导航与深链

- `NavigationStack` + 类型化路由：destination 建模为 Hashable enum，`navigationDestination(for:)` 集中注册。
- 导航路径提为可观察状态（`NavigationPath` 或 typed array），使"跳转到任意页"可编程——深链、推送落地页、测试都靠它。
- 模态（sheet/fullScreenCover）用 `Identifiable` item 驱动而非布尔堆，一个入口多种弹层时不会状态打架。
- ✅ 检查点：任何页面都能从冷启动通过构造路径直达。

## 步骤 5：生命周期与并发

- 视图期异步工作用 `.task`（离屏自动取消）/`.task(id:)`（依赖变化自动重启），不在 `onAppear` 里手动管理 Task 的启动与取消。
- ViewModel 方法标 `@MainActor`（或整个 ViewModel），耗时工作放后台 actor/`Task.detached`，回主线程只更新状态。
- 用户可能重复触发的操作（下拉刷新、快速切换 tab）要么幂等要么先取消前一个任务，防止旧结果覆盖新结果。

## 完成检查

- [ ] 状态归属经过步骤 2 检验，无全局单例传状态、无派生值副本
- [ ] 高频状态圈在最小子树；性能改动有前后测量
- [ ] 导航可编程直达任意页
- [ ] 异步工作用 .task 管生命周期，竞态已处理

## 最佳实践（推荐，非强制；偏离时说明理由）

- 每个 View 配多个 `#Preview`：正常态之外至少空态/错误态各一个，Preview 数据用工厂函数与测试共享。
- 长列表图片用带内存 + 磁盘缓存的异步加载（裸 `AsyncImage` 无磁盘缓存，滚动场景考虑封装或三方库）。
- `GeometryReader` 克制使用（它会吃掉提议尺寸且触发额外布局轮），优先用 `containerRelativeFrame`、alignment、`layoutPriority` 表达布局意图。
- 布局微调用 `padding`/`frame(maxWidth:)` 语义化表达，少用魔法数字 offset——不同 Dynamic Type 字号下 offset 会碎。
- 颜色/字号/间距收敛为语义化 token（extension 常量或 asset catalog），不散写字面量。
- 需要 UIKit 能力时 `UIViewRepresentable` 的 `updateUIView` 必须幂等（SwiftUI 会频繁调用），状态同步用 Coordinator。
- 弹性动效优先 `spring` 系列默认参数，自定义曲线是例外不是常态。
