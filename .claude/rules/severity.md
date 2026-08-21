# Finding 等级定义

评审（reviewer）与验收（qa）产出的 finding 统一用以下等级；各规则文件声明的"违反即 X"以本文件语义为准。

| 等级 | 定义 | 处置 |
|---|---|---|
| **BLOCKER** | 正确性 bug、安全红线（security/typescript/swift 中标注 BLOCKER 的条款）、或使功能不可用的问题 | 必须返工，不可合入，coordinator 无豁免权 |
| **MAJOR** | 架构违规、测试缺失、兼容性风险（各规则中标注 MAJOR 的条款） | 原则上返工；coordinator 可基于明确理由裁决豁免，豁免理由记录在 PR 中 |
| **MINOR** | 可维护性建议、最佳实践偏离 | 不阻塞合入；可当场顺手修或记为后续项 |

- 每个 finding 必须给出等级；给不出触发场景的疑似问题不报（见 reviewer 定义）。
- qa 的 FAIL 等价于 BLOCKER：必须返工后重新验收。
