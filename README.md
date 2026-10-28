# pi-vcc：面向 Pi 的确定性上下文压缩与长期记忆

> 中文增强 Fork · 可验证的历史证据 · 可选 Jev 评分 · 默认离线运行

**pi-vcc** 是 [Pi coding agent](https://github.com/earendil-works/pi-coding-agent) 的上下文压缩扩展。它从会话消息、工具调用、文件修改和错误中直接提取结构化摘要，**压缩本身不调用 LLM**。历史消息继续保存在 Pi 的会话 JSONL 中，可通过 `vcc_recall` 找回。

本仓库是 [monotykamary/pi-vcc](https://github.com/monotykamary/pi-vcc) 的增强 Fork，维护了中文文本处理、跨压缩长期记忆、来源验证、上下文预算、异常恢复和可选 [Jev](https://jevmodel.org/) 评分。**这些增强仅保证存在于此 Fork 的 `tom` 分支；上游 npm 包不等于这个版本。**

[安装](#安装) · [使用](#基本使用) · [长期记忆](#长期记忆与证据) · [jev](#可选-jev-评分) · [测试](#测试与已知限制)

## 设计目标

| 能力 | 实现原则 |
| --- | --- |
| 压缩 | 规则提取、可重现、无摘要模型调用 |
| 多次压缩 | 旧摘要与新事件合并；关键约束和未解决问题单独保留 |
| 历史恢复 | 直接读取原始 session JSONL；默认只查询当前会话分支 |
| 证据可信度 | 区分用户确认与助手提议；记忆记录可附源消息 ID |
| 中文 | 中文句号/问号/感叹号、词片段、终端宽度与混合文字 Token 估算 |
| 模型增强 | Jev 可选、显式启用、失败回退；不负责删除原始历史 |
| 预算 | 按 API 类型预留输出空间，并从溢出错误学习实际窗口 |

**核心约束：**压缩不会让模型永久拥有完整旧 context。模型只能直接看到摘要与保留的近期消息；需要旧证据时必须调用 `vcc_recall`。旧历史是否能找回还依赖原始 session JSONL 是否仍存在。

## 安装

从本 Fork 安装，而不是使用上游已发布的 npm 版本：

```bash
pi install git:github.com/kunkun9527/pi-vcc
```

如已有上游版，请先检查 Pi 的扩展安装列表，避免同时加载两个 pi-vcc 副本。仓库开发依赖使用 Pi 1.3.0；具体宿主版本兼容性以 CI 的 Host 测试为准，不保证所有第三方 Pi 分支行为一致。

源码：[kunkun9527/pi-vcc](https://github.com/kunkun9527/pi-vcc/tree/tom)；改动历史可从 [Pull requests](https://github.com/kunkun9527/pi-vcc/pulls?q=is%3Apr+is%3Aclosed) 查询。

## 基本使用

在 Pi 交互式会话中：

```text
/pi-vcc
```

显式触发一次确定性压缩；当配置 `overrideDefaultCompaction: true` 时，普通 `/compact` 和自动压缩也由 pi-vcc 处理。

查看或检索历史：

```text
/pi-vcc-recall
/pi-vcc-recall 数据库连接失败
/pi-vcc-recall auth.ts scope:all
/pi-vcc-recall 登录 page:2
```

模型还可调用内置工具 `vcc_recall`：

```json
{"query": "数据库连接失败", "page": 1}
```

要展开已找到的消息，使用 `expand`；按指定压缩区段检索，使用 `scope: "compaction:latest"` 或 `scope: "compaction:N"`。`scope: "all"` 会跨越当前活动分支，应在确实需要查看其他分支时明确指定。

### 按证据 ID 直接取回历史

新生成的长期记忆可以带上来源元数据（示例 ID 仅用于说明）：

```text
[Long-term Memory]
- [constraint:1a2b3c4d] 项目必须使用简体中文
  @source:entry-123 status:confirmed
```

直接使用原始消息 ID，无需猜关键词：

```json
{"evidenceId": "entry-123"}
```

这里的 ID 是 Pi session 条目的 ID，**不是搜索结果的行号**。工具会从 JSONL 恢复原始消息，默认要求该 ID 属于当前活动分支；找不到时不会编造证据。旧版压缩摘要没有来源元数据的记录仍可以保留，但不能冒充已验证来源。

## 压缩如何工作

```text
Pi 原始消息与工具结果
    │
    ├─ 过滤噪声、识别轮次和任务边界
    ├─ 提取目标、偏好、错误、文件变更和因果线索
    ├─ 提取长期记忆 + 来源 ID + 确认状态
    └─ 与 previousSummary 合并
          │
          ├─ 历史摘要（受长度限制）
          ├─ Long-term Memory（分类配额）
          └─ 历史检索提示（vcc_recall）
                    │
                    └─ 原始 JSONL 仍在本地，可按需找回
```

摘要包括目标、偏好、文件、提交、未解决问题、早期轮次、简化转录和长期记忆等部分。并非所有旧对话都会一直完整留在 context。

### 长期记忆与证据

长期记忆记录分为 `constraint`（约束）、`blocker`（未解决问题）和 `decision`（决策），每类最多保留 **8 条**。约束和问题优先保留最早与最近的记录；决策优先依据可选 Jev 评分和新近程度排序。

每条新记录可附：

- `@source:<entryId>`：原始 Pi 消息来源；只有确实可定位的来源才会写入。
- `status:confirmed`：用户直接提出的要求；`status:proposed`：助手提出的决策或推断。

助手说“已经修好”**不会自动删除**未解决问题。要确认关闭、废弃或替代某条记录，用户可以输入带实际 8 位记忆 ID 的指令：

```text
已解决：1a2b3c4d
替代：1a2b3c4d
过期：1a2b3c4d
```

这是 **显式 ID 操作**，不是基于语义自动判断冲突或过期。保留名额有限，系统不保证所有历史事实永久驻留摘要；长期可靠性仍依赖 JSONL 原文及证据恢复。

### 多分支会话

pi-vcc 的检索默认以当前活动 lineage 为界。长期记忆合并时，也会过滤明确引用了当前分支之外消息的记录，避免在 `/tree` 返回旧节点后继承未来分支的结论。没有来源 ID 的旧版记忆属于兼容记录，其可信度弱于新格式。

### 压缩完整性

每次压缩会检查最早的受保护约束、未解决问题，以及对应的来源 ID 是否被意外丢失。异常会发出警告，提示使用 `vcc_recall` 核对；这不是形式化证明，也不替代原文校验。

## 中文与长上下文增强

- 支持 `。！？` 等中文句子边界；截断时尽量避开行内代码、链接与路径。
- 支持无空格汉字的双字词检索，保留英文代码标识符；长查询有长度与相关性限制。
- 终端换行按近似显示宽度处理全角字符，避免 UTF-16 代理对拆分。
- Token 估算区分汉字/假名/韩文/Emoji 与其他字符，但**不是模型分词器的精确计费数据**。
- 近期保留窗口的预算按不同 API 处理：Anthropic Messages 不额外预留输出能力；其他 API 的输出预留上限为上下文窗口的 25%。模型返回明确溢出窗口时，会按当前会话与模型记录更小的实际限制，供之后的压缩使用。

## 可选 Jev 评分

**默认关闭；不需要 API Key。** 如需启用远程 Jev：

```bash
export PI_VCC_JEV_ENABLED=1
export JEVMODEL_API_KEY="your-key"
```

启用后：

1. 在完成的 Agent 轮次中对有限数量的技术决策评分，以帮助决定优先保留哪些记录。
2. 对已有的少量 `vcc_recall` 词法候选进行相关性重排序。**Jev 不能生成原本不存在的检索结果。**
3. 网络错误、超时或不合法评分会退回原来的确定性排序；压缩主流程不会因此等待一个远程摘要模型。

**隐私：**启用后会把截断的候选内容发往 Jev 服务，虽然会尝试遮蔽常见密钥、邮箱、URL 和本地路径，但这不是完备脱敏。敏感会话应保持关闭或先审查外发内容。真实 Jev 效果、延迟和费用未在无凭据的 CI 中测试；CI 使用模拟 API 响应。

具体协议与限制：[JEV_MEMORY.md](docs/JEV_MEMORY.md)。

## TUI 配置面板

在 Pi 的交互式终端中输入：

```text
/pi-vcc-config
```

面板采用 Pi 原生 `SettingsList`（参考 billion-context-pi-lean）：**↑↓** 选择、**Enter** 切换、**Esc** 关闭，修改会即时保存并在后续压缩中生效。支持：

- 接管默认 `/compact` 的开关，以及全局和当前模型的压缩触发阈值（百分比、绝对 Token、预留 Token、继承）。
- 全局和当前模型近期保留 Token 设置；pi-vcc 自身仍以任务边界与预算逻辑为主。
- 调试日志开关，以及默认关闭的可选 Jev 评分开关（仍需单独提供 `JEVMODEL_API_KEY`）。

面板将设置写入同一份 `pi-vcc-config.json`，保留其他模型和未知字段；损坏的 JSON 会拒绝覆盖。没有选定模型时隐藏模型专属选项；非 TUI 模式会提示手动编辑设置文件。若设置了 `PI_VCC_JEV_ENABLED=0` 或 `=1`，环境变量的 Jev 开关优先于面板值。

## 配置

默认配置由扩展初始化生成。位置通常位于 Pi Agent 的配置目录下 `pi-vcc-config.json`；可用环境变量 `PI_VCC_CONFIG_PATH` 指定其他路径。

```json
{
  "overrideDefaultCompaction": true,
  "debug": false,
  "globalThreshold": { "compactPercent": 75 },
  "modelThresholds": {
    "provider/model-id": { "compactPercent": 65 }
  }
}
```

- `overrideDefaultCompaction`：`true` 时接管默认压缩；`false` 时只响应显式 `/pi-vcc`。
- `globalThreshold` 与 `modelThresholds`：按所有模型或单一模型定义触发阈值，也支持 `compactAtTokens` 和 `reserveTokens`。省略时使用 Pi 的全局设置。
- `debug`：记录调试信息，可能涉及摘要预览；生产或敏感会话建议关闭。

阈值负责“何时触发”，自适应预算负责“压缩后保留多少近期消息”；两者不同。Pi 原生 compaction、其他 context 引擎和 pi-fabric 的共同安装需特别检查哪个组件拥有压缩钩子，避免重复压缩。

## 测试与已知限制

```bash
bun install
bun run typecheck
bun test ./tests --path-ignore-patterns '**/real-sessions.test.ts'
bun run test:regression
bun run test:host
```

CI 执行 TypeScript、Bun、Vitest 回归以及 **真实 Pi 1.3.0 Host 的离线加载和压缩流程**。此外包含 150 轮中文长期记忆测试，以及 200 轮会话 JSONL / 精确来源恢复 / 跨分支拒绝的集成测试。

**测试结果该如何理解：**这些测试验证的是结构化记忆能在模拟多次压缩后保留、原文能从 session 文件取回。它们**不证明模型能在第 200 轮正确回答第 1 轮的任意问题**，也没有测出与 Lean 或原版 Pi 的公平 Token/价格优势。要评估真实问答准确率、Jev 效益、各服务商兼容性和端到端时延，需要额外的在线模型基准。

其他限制：长期记忆配额固定且有限；词法检索不是向量语义检索；显式记录废弃需要知道记忆 ID；删除原始 Pi session 文件后无法恢复对应完整历史；外部模型评分不能替代来源证明。

详细测试文档：[E2E_BENCHMARK.md](docs/E2E_BENCHMARK.md) · [LONG_MEMORY_STRESS.md](docs/LONG_MEMORY_STRESS.md) · [CJK_SUPPORT.md](docs/CJK_SUPPORT.md)。

## 与其他项目的关系

- [原始 pi-vcc](https://github.com/monotykamary/pi-vcc)：确定性 VCC 压缩核心。
- [billion-context-pi-lean](https://github.com/kunkun9527/billion-context-pi-lean)：启发了来源归属、预算自恢复、分支隔离和端到端验证；**没有移植其 ACP 压缩引擎或后台模型压缩**。
- [TextFold](https://github.com/chenxiachan/textfold)：启发了多语言文本边界处理。
- [Jev](https://jevmodel.org/)：可选决策排序和检索重排服务。

**发布说明：**本 Fork 的功能在 GitHub `tom` 分支。`package.json` 目前仍沿用上游包名与版本号；不要把 npm 上的 `@monotykamary/pi-vcc` 视为包含本 Fork 新增强的发行物。
