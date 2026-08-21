# Agent Coordinator 设计系统

Web 端所有界面工作的唯一视觉约束来源。新页面、新组件、视觉调整先读本文件；偏离本文件的选择必须在 PR 里说明理由。

## 1. 视觉主题与氛围

终端操作台（terminal ops console）。这是一个给开发者用的 agent 协调控制台，核心信息是「哪些 agent 在跑、跑成什么样」，所以状态本身是视觉主角，装饰一律退后。暗色优先，高信息密度，等宽字体承载标签与数据，界面应该读起来像一块被精心排版过的终端，而不是一个营销网站。

参照系：Temporal UI 的状态语义、Raycast 的暗色表面、Vercel 的等宽点缀。禁止出现的气质：渐变、玻璃拟态、营销 hero、卡片网格模板。

## 2. 调色板与角色

全部用 OKLCH。中性色统一朝 hue 200（冷青）微调 chroma 0.004–0.008，制造潜意识的一致性。60-30-10：表面中性 60%，次级文字与边框 30%，强调与状态 10%。

### 暗色（默认，:root）

| Token | 值 | 角色 |
|---|---|---|
| `--background` | `oklch(0.15 0.006 200)` | 页面画布，近黑实色 |
| `--foreground` | `oklch(0.93 0.005 200)` | 主文字（不用纯白） |
| `--card` | `oklch(1 0 0 / 3%)` | 卡片表面（画布上叠白 3%） |
| `--card-foreground` | `oklch(0.93 0.005 200)` | 卡片文字 |
| `--popover` | `oklch(0.21 0.008 200)` | 浮层（必须不透明） |
| `--popover-foreground` | `oklch(0.93 0.005 200)` | 浮层文字 |
| `--primary` | `oklch(0.78 0.15 155)` | 强调色：荧光绿，交互元素专用 |
| `--primary-foreground` | `oklch(0.16 0.03 155)` | 强调色上的文字（深绿黑） |
| `--secondary` | `oklch(1 0 0 / 6%)` | 次级填充（secondary 按钮等） |
| `--secondary-foreground` | `oklch(0.93 0.005 200)` | 次级填充上的文字 |
| `--muted` | `oklch(1 0 0 / 4%)` | 弱化表面 |
| `--muted-foreground` | `oklch(0.65 0.01 200)` | 次级文字 |
| `--accent` | `oklch(1 0 0 / 6%)` | hover 填充 |
| `--accent-foreground` | `oklch(0.93 0.005 200)` | hover 填充上的文字 |
| `--destructive` | `oklch(0.62 0.19 25)` | 破坏性操作 |
| `--border` | `oklch(1 0 0 / 8%)` | 标准边框 |
| `--input` | `oklch(1 0 0 / 10%)` | 输入框边框 |
| `--ring` | `oklch(0.78 0.15 155)` | 焦点环（= primary） |

### 状态色（签名系统，暗色值）

| Token | 值 | 语义 | 动效 |
|---|---|---|---|
| `--status-running` | `oklch(0.74 0.12 230)` | 运行中（青蓝） | 2s 呼吸脉动，唯一会动的状态 |
| `--status-succeeded` | `oklch(0.76 0.15 155)` | 成功（绿，与 primary 同族） | 静止 |
| `--status-failed` | `oklch(0.65 0.19 25)` | 失败（红，与 destructive 同族） | 静止 |
| `--status-queued` | `oklch(0.65 0.015 200)` | 排队/等待（灰） | 静止 |
| `--status-blocked` | `oklch(0.78 0.13 80)` | 阻塞/需人工（琥珀） | 静止 |

状态色的浅色主题值：明度统一降到 0.45–0.55 区间、chroma 微升，保证浅底对比度（如 running `oklch(0.52 0.12 230)`、succeeded `oklch(0.50 0.15 155)`、failed `oklch(0.55 0.20 25)`、queued `oklch(0.55 0.015 200)`、blocked `oklch(0.55 0.12 80)`）。

### 浅色（第二主题，跟随系统 `prefers-color-scheme: light`）

| Token | 值 |
|---|---|
| `--background` | `oklch(0.97 0.004 200)` |
| `--foreground` | `oklch(0.18 0.006 200)` |
| `--card` | `oklch(1 0 0)` |
| `--popover` | `oklch(1 0 0)` |
| `--primary` | `oklch(0.55 0.15 155)` |
| `--primary-foreground` | `oklch(0.98 0.01 155)` |
| `--secondary` / `--muted` / `--accent` | `oklch(0.93 0.005 200)` |
| `--muted-foreground` | `oklch(0.50 0.01 200)` |
| `--destructive` | `oklch(0.55 0.20 25)` |
| `--border` | `oklch(0.90 0.005 200)` |
| `--input` | `oklch(0.87 0.005 200)` |
| `--ring` | `oklch(0.55 0.15 155)` |

浅色卡片是白色实色 + `0 1px 3px rgba(0,0,0,0.10)` 阴影（浅色下卡片与画布明度差不足 4% 时阴影必须在）。

### 颜色纪律

- 状态色只用于状态语义。禁止拿 `--status-running` 的青蓝做链接色或装饰。
- 交互强调只有一个：荧光绿 `--primary`。succeeded 与它同族是有意的（正向语义对齐）。
- 禁止任何渐变。禁止彩色背景上放灰色文字（用背景色相降明度一档）。

## 3. 排版规则

两个家族，各司其职：

- **Martian Mono**（next/font/google，变量 `--font-mono`）：标题、区块标签、全部数据（ID、时间戳、计数、状态标签）。选它是因为它是为代码/技术界面设计的宽体等宽，个性强且不在 reflex 名单上——它就是「终端感」本体。
- **Geist**（现有，变量 `--font-sans`）：正文、表单、说明文字。密集数据 UI 的正文需要安静的底，声音由等宽与状态色发出——这是有理由的保留，不是 reflex。
- CJK fallback 两个家族都要挂：`"PingFang SC", "Noto Sans SC", sans-serif`。中文标题会自然落到 CJK 面，这是预期行为。

| 级别 | 字体 | 字号/行高 | 字重 | 其他 |
|---|---|---|---|---|
| 页面标题 | mono | 20px / 1.3 | 600 | 拉丁不加负字距（等宽字体禁止负字距） |
| 区块标题 | mono | 16px / 1.4 | 600 | |
| 拉丁标签（如 STATUS、ID） | mono | 11px / 1 | 500 | uppercase，tracking +0.08em |
| 中文标签 | sans | 12px / 1.5 | 400 | 不 uppercase、不加字距 |
| 正文 | sans | 14px / 1.7 | 400 | 中文行高 ≥1.7 |
| 辅助文字 | sans | 13px / 1.6 | 400 | `--muted-foreground` |
| 数据值（ID/时间/计数） | mono | 13px / 1.5 | 400 | `tabular-nums` 必开 |

- 根布局一次性应用 `-webkit-font-smoothing: antialiased; -moz-osx-font-smoothing: grayscale`。
- 标题 `text-wrap: balance`，正文 `text-wrap: pretty`。
- 禁止给 CJK 文字加负字距。

## 4. 组件样式

所有交互元素共有：`transition` 显式列属性（background-color, border-color, color, opacity, scale），120ms `cubic-bezier(0.16, 1, 0.3, 1)`；按压 `active:scale-[0.98]`；焦点 `focus-visible:ring-2 ring-ring`（禁止无替代的 outline:none）；命中区 ≥40×40px。

**Button**
- default：`bg-primary text-primary-foreground`，hover 明度升一档（`hover:bg-primary/90`），radius `--radius-md`。
- outline：透明底 + `border-input`，hover `bg-accent`。
- ghost：透明底，hover `bg-accent`。
- destructive：`bg-destructive`。
- disabled：opacity 50%，禁用指针。

**Card**：`bg-card` + `border border-border`，radius `--radius-lg`，暗色下无投影（抬升靠白色透明度台阶），浅色下白底 + 标准阴影。

**Input**：`bg-[oklch(1_0_0_/_4%)]`（浅色下白底），`border-input`，focus 时 `border-ring + ring-2 ring-ring/30`，radius `--radius-md`，文字 14px sans。

**StatusDot / StatusBadge**（签名组件）
- StatusDot：6px 圆点，颜色取对应 `--status-*`；`status="running"` 时应用 `animate-status-breathe`（2s opacity 1→0.35→1 ease-in-out 无限），其余状态静止。
- StatusBadge：dot + 标签，标签用中文（运行中/成功/失败/排队/阻塞），sans 12px；背景 `color-mix(in oklch, var(--status-*) 12%, transparent)`，边框同色 25%，radius `--radius-sm`。
- 同一容器内所有状态共用同一字号——状态切换只变色与动效，绝不变字号（防肉眼抖动）。
- `prefers-reduced-motion: reduce` 下呼吸动画禁用（保持全不透明度静止）。

**Alert**：与 Card 同表面语言；destructive 变体边框与文字用 `--destructive`，背景 `color-mix` 10%。

## 5. 布局原则

- 4px 基础网格。密度取紧凑档：内容 gap 8/12/16，卡片 padding 20，页面 padding 24（移动 16）。
- 外层容器 padding 等于内层元素 gap（间距是系统不是逐值）。
- 左对齐优先，禁止居中 hero；页面内容左对齐到统一版心（认证类窄版心 max-w-md，工作区 max-w-5xl）。
- 正文段落宽度约束 ~65ch。
- 装饰背景默认关。

## 6. 深度与抬升（暗色靠台阶，不靠投影）

| 层级 | 暗色 | 浅色 |
|---|---|---|
| 画布 | `--background` 实色 | `--background` |
| 卡片 | 白 3% 叠加 + 边框白 8% | 白实色 + `0 1px 3px rgba(0,0,0,0.10)` |
| 抬升面（hover 行等） | 白 5% | 明度降一档 |
| 浮层（popover/dropdown） | 实色 `--popover` + 边框白 10% | 白实色 + `0 4px 12px rgba(0,0,0,0.12)` |

圆角刻度（第一个组件前已承诺，全站共用）：`--radius-xs: 2px`（badge 内小元素）、`--radius-sm: 4px`（badge/tag）、`--radius-md: 6px`（按钮/输入）、`--radius-lg: 10px`（卡片/浮层）。禁止 pill、禁止临时挑值。

## 7. Do's 和 Don'ts（本项目专属）

- ✅ 状态永远同时用「颜色 + 文字/图形」双编码，不裸靠颜色（色盲可达）。
- ✅ 一切 ID、时间戳、计数用 mono + `tabular-nums`。
- ✅ 只有 running 会动；succeeded/failed/queued/blocked 绝对静止。
- ✅ 图标只用 lucide 一套。
- ❌ 暗色表面上禁止 box-shadow 投影（浮层的浅色阴影除外——暗色浮层也不用投影，用实色台阶 + 边框）。
- ❌ 禁止渐变、`background-clip: text`、`backdrop-filter` 玻璃拟态。
- ❌ 禁止 `transition: all`；禁止动 width/height/padding。
- ❌ 禁止宽于 1px 的彩色左/右边框当区块强调（要强调用状态点或背景块）。
- ❌ 禁止 modal 当溢出内容的出口（用内联展开/独立页）。
- ❌ 中文界面禁止 Title Case 与感叹号成功态；错误文案不用被动语态、不用「哎呀」开头。

## 8. 响应式行为

- 断点：375px（手机基线，另测 320px 按钮）、768px、1280px（桌面基线）。
- 触控目标 ≥40×40px；`touch-action: manipulation`。
- hover 态用 `@media(hover:hover)` 守卫（Tailwind: `[@media(hover:hover)]:hover:*` 或依赖 v4 默认 hover 行为）。
- 移动端 CTA：自然宽度左对齐，不全宽、不居中。
- 每次交付前在 1280px 与 375px 真实渲染验证，检查长邮箱、长错误文案是否溢出。

## 9. Agent prompt 指南

快速颜色参照：`背景 oklch(0.15 0.006 200)`、`文字 oklch(0.93 0.005 200)`、`强调绿 oklch(0.78 0.15 155)`、`running 青 oklch(0.74 0.12 230)`、`failed 红 oklch(0.65 0.19 25)`、`blocked 琥珀 oklch(0.78 0.13 80)`、`边框 白8%`、`卡片 白3%`。

示例 prompt（可直接粘用）：

1. 「在 `--background` 画布上做任务列表行：左侧 6px StatusDot（running 用 `--status-running` 加 2s 呼吸），任务名 Geist 14px `--foreground`，右侧任务 ID 用 Martian Mono 13px `tabular-nums` `--muted-foreground`；行 hover 背景白 5%，120ms cubic-bezier(0.16,1,0.3,1)；radius 6px。」
2. 「做一个 StatusBadge：running 态 = 青蓝 dot 呼吸 + 中文标签『运行中』sans 12px，背景 color-mix(in oklch, var(--status-running) 12%, transparent)，边框同色 25%，radius 4px，切换状态不变字号。」
3. 「做区块头：拉丁标签 AGENTS 用 Martian Mono 11px 500 uppercase tracking +0.08em 颜色 `--muted-foreground`，右侧计数 mono 13px tabular-nums；下方 1px `--border` 分隔线。」
4. 「做主操作按钮：`bg-primary`（荧光绿）文字 `--primary-foreground`，radius 6px，padding 8px 16px，active:scale-[0.98]，focus-visible ring-2 `--ring`；hover bg-primary/90。」
