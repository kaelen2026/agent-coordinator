# TypeScript 规则（Web 端）

适用于 Web 端全部代码。类型逃逸类违反是 reviewer 的 MAJOR，涉及敏感信息的是 BLOCKER。

## 类型纪律

- `tsconfig` 必须 `strict: true`，不允许为通过编译而关闭任何 strict 子项。
- 禁止 `any`：无法收窄时用 `unknown` + 类型守卫。
- 禁止用 `as` 强转绕过检查（`as const` 与收窄到字面量类型除外）。
- 禁止 `@ts-ignore`；确需压制时用 `@ts-expect-error` 并在同行注明原因。

## 类型与契约同源

- API 请求/响应类型从契约生成，或集中手写在 `types/` 单一位置；组件/页面内不得私自重复声明。
- 前后端字段不一致视为 bug，修契约或修类型，不允许用可选字段 + 兜底值掩盖。

## 运行时边界校验

- 一切运行时边界的数据（API 响应、表单输入、searchParams、localStorage）必须经 schema 校验（zod 等）后才进入类型世界；禁止裸 `as` 断言外部数据的类型。

## 敏感信息（Next.js，违反即 BLOCKER）

- secret 只能在服务端代码使用；服务端专用模块加 `server-only` 防止被客户端误引。
- 暴露给浏览器的环境变量必须 `NEXT_PUBLIC_` 前缀，且加前缀前确认不含敏感内容。
- 通用密钥红线见 `security.md`。
