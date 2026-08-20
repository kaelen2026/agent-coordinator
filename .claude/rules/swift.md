# Swift / iOS 规则

适用于 iOS 端全部代码。兼容性类违反是 reviewer 的 MAJOR（客户端不可热修，兼容 bug 代价极高），涉及敏感信息的是 BLOCKER。

## UI 范式

- UI 一律 SwiftUI，禁止新建 UIKit 界面；确需系统能力时用 `UIViewRepresentable` 封装，桥接层保持最薄。
- View 中禁止业务逻辑（网络调用、数据变换、权限判断），业务逻辑归 ViewModel。

## 并发

- 统一 async/await + 结构化并发；禁止与手动 `DispatchQueue` 混用两套并发模型。
- UI 更新必须在 `@MainActor`；主线程禁止耗时操作（网络、解码、DB）。

## 向前兼容（客户端不可热修）

- Codable 解码必须容忍服务端新增的未知字段与未知枚举值，禁止因未知值解码失败导致功能不可用。
- 服务端返回意外值时降级展示，禁止 crash（禁止对外部数据 `try!` / 强制解包）。
- 涉及契约的新功能应配后端开关，线上出问题可由服务端关闭。

## 敏感信息（违反即 BLOCKER）

- token/凭证只进 Keychain，禁止 UserDefaults / 明文文件。
- 禁止在日志中打印敏感信息；禁止关闭证书校验（ATS 例外需说明原因并经评审）。
- 通用密钥红线见 `security.md`。
