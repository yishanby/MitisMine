# MitisMine 飞书多 Agent 调研系统设计

日期：2026-07-17
状态：已批准方向，待实施
范围：四个飞书企业自建 App、共享 Topic、Claude Code / Codex / Copilot CLI 并行调研、交叉校验与持久化恢复

## 1. 目标

MitisMine 让小团队只通过飞书即可随时发起、继续和审阅多 Agent 调研。系统必须满足：

1. 四个真实飞书机器人分别作为总控、Claude、Codex、Copilot 入口。
2. Topic 是跨机器共享的持久化调研空间，支持创建、切换、恢复、共享和归档。
3. Claude Code、Codex、Copilot CLI 先独立调研，再互相校验并按争议继续深挖。
4. 最终报告中的重要主张必须绑定证据片段、来源、获取时间和可信度。
5. 每个顶层 Agent 可提出子 Agent 任务；总并发不超过 6，每个顶层 Agent 最多 2 个子任务。
6. 默认自动调研最多 3 轮，用户可暂停、停止、追加上下文或要求继续。
7. 读取、搜索和测试自动执行；写文件、外部发消息、部署和删除等操作通过飞书卡片审批。
8. 云端控制面可以调度本地或云端 Worker；第一版允许同机运行，但使用同一 Worker 协议。

## 2. 非目标

- 第一版不建设独立桌面或 Web 客户端。
- 第一版不实现组织级计费、跨租户市场或复杂管理员后台。
- 第一版不允许模型进程直接持有飞书 App Secret。
- 第一版不追求多控制面实例的高可用；单实例加持久化磁盘即可服务小团队。

## 3. 飞书交互模型

### 3.1 App 与角色

| App | App ID | 职责 |
|---|---|---|
| MitisMine 总控 | `cli_aad0b5b7aeb89cc4` | Topic 管理、完整调研、状态卡片、最终报告 |
| MitisMine Claude | `cli_aad0b5ed06f8dd23` | 当前 Topic 内的 Claude Code 深挖 |
| MitisMine Codex | `cli_aad0b6053e78dd01` | 当前 Topic 内的 Codex 深挖 |
| MitisMine Copilot | `cli_aad0b65c14f8dd24` | 当前 Topic 内的 Copilot CLI 深挖 |

四个 App 连接同一控制面。系统优先以租户内稳定的 `(tenant_key, user_id)` 识别同一飞书用户；事件未提供 `user_id` 时回退到 `(tenant_key, union_id)`。`open_id` 是 App 相关标识，仅用于向对应 App 会话回发消息。启动时必须验证四个 App 对测试用户解析到同一主体，否则拒绝启用跨 App Topic 游标并报告配置错误。

### 3.2 Topic 命令

所有机器人都接受以下命令：

- `/topic new <标题>`：创建并切换到 Topic。
- `/topic list`：列出可访问 Topic 及最新状态。
- `/topic use <短 ID>`：全局切换当前 Topic；四个机器人同步生效。
- `/topic show`：显示当前 Topic、成员、活动 Run 和上下文水位。
- `/topic share @用户 <editor|viewer>`：共享 Topic。
- `/topic archive`：归档当前 Topic，不删除历史。
- `/note <内容>`：仅追加上下文，不触发 Agent。
- `/research <问题>`：启动完整三 Agent 调研。
- `/status`、`/stop`、`/report`：查看状态、停止活动 Run、获取最新报告。

总控机器人的普通消息等价于 `/research`；三个 Agent 机器人的普通消息只进入对应 Agent 的当前 Topic Session。若用户尚未选择 Topic，机器人先创建一个以消息摘要命名的 Topic，并继续执行。

## 4. 总体架构

系统分成控制面和数据面：

```text
4 x Feishu App (persistent connection)
                |
        Feishu Channel Gateway
                |
    Research Orchestrator + Approval Engine
        |           |             |
   Topic Store   Evidence Ledger  Outbox
                |
        Worker Gateway (WebSocket)
          /          |          \
   Claude Worker  Codex Worker  Copilot Worker
```

### 4.1 控制面组件

- **Feishu Channel Gateway**：建立四条官方 SDK 长连接，验证、去重和路由事件，渲染消息与交互卡片。
- **Topic Service**：Topic、成员、当前 Topic 指针、消息、附件与摘要管理。
- **Research Orchestrator**：持久化状态机、并发限制、轮次控制、互评分发和综合签核。
- **Approval Engine**：把高风险操作转成一次性审批卡片，并交给可信执行器。
- **Evidence Ledger**：保存证据及其与主张的支持、反驳关系。
- **Outbox Dispatcher**：可靠发送飞书响应，处理限流和重试。
- **Worker Gateway**：向远程 Worker 分发租约任务，接收心跳和流式事件。

### 4.2 Worker 组件

- 每种 CLI 一个 Adapter，统一暴露 `startSession`、`resumeSession`、`cancel` 和流式事件。
- 同机 Worker 与远程 Worker 使用相同消息协议；远程连接只需从 Worker 主动出站。
- 每个 `(topic_id, provider, role)` 使用独立持久 Session，绝不跨 Topic 复用。
- 模型进程运行在每 Topic 独立工作目录，无法读取控制面的 Secret 环境变量。

## 5. 数据模型

核心实体：

| 实体 | 关键字段 |
|---|---|
| `Topic` | id、tenant、title、owner、status、created_at、last_event_seq |
| `TopicMember` | topic_id、principal_id、role |
| `UserTopicCursor` | tenant、principal_id、current_topic_id |
| `TopicEvent` | seq、topic_id、type、actor、payload、created_at |
| `Artifact` | id、topic_id、kind、sha256、mime、storage_ref、source_message_id |
| `ResearchRun` | id、topic_id、question、state、round、budget、coordinator_provider |
| `AgentSession` | topic_id、provider、role、external_session_id、context_watermark |
| `AgentTurn` | run_id、session_id、phase、content、raw_event_ref、status |
| `Claim` | id、run_id、text、status、confidence、author_session_id |
| `Evidence` | id、url、title、publisher、quote、retrieved_at、sha256、tool_trace_id |
| `ClaimEvidence` | claim_id、evidence_id、relation、agent_vote |
| `Critique` | target_claim_id、reviewer、severity、text、status |
| `ApprovalRequest` | id、topic_id、action、target、risk、status、expires_at、idempotency_key |
| `OutboxMessage` | app_role、receive_id、payload、attempts、next_attempt_at、status |

`TopicEvent` 是可恢复历史的事实源；查询表是可重建投影。第一版使用 SQLite WAL 和事务 Outbox，数据库接口不暴露 SQLite 特性，便于迁移到 PostgreSQL。

## 6. Context Pack

Topic 保存完整历史，但不会把完整历史无条件塞进模型。每次调用生成带水位的 Context Pack：

1. Topic 元数据、成员和当前问题。
2. 经版本化的结构化摘要。
3. 最近相关消息与 Agent Turn。
4. 固定、上传或检索命中的 Artifact。
5. 当前 Claims、Evidence、Critiques 和未解决问题。
6. `event_seq` 水位与缺失历史的检索方式。

模型输出后，控制面先追加原始事件，再更新摘要和索引。摘要永远不能删除原始历史；用户可通过 `/report` 或 Topic 历史卡片查看完整内容。

## 7. 调研状态机

`ResearchRun` 状态：

```text
queued -> independent_research -> normalize_evidence
       -> cross_review -> resolve_disputes
       -> synthesize -> signoff -> completed
```

任意活动状态可进入 `paused`、`awaiting_approval`、`cancelled` 或 `failed`，恢复后从最后一个已提交事件继续。

### 7.1 独立调研

三个顶层 Agent 同时获得相同 Context Pack 和不同视角提示词，不能读取其他 Agent 本轮结果。这样降低从众和锚定效应。

### 7.2 证据规范化

每个输出必须通过统一 JSON Schema，至少包含：

- 结论摘要；
- Claim 列表；
- 每个 Claim 的 Evidence 引用；
- 原文片段、来源 URL、发布者、获取时间；
- 置信度及理由；
- 仍需验证的问题；
- 可选的子任务建议。

无效输出最多自动修复一次，仍失败则把该 Agent 标记为 degraded。

### 7.3 交叉审阅与深挖

每个 Agent 审阅另外两个报告，对 Claim 标注 `support`、`challenge` 或 `insufficient`，并给出 `low|medium|high` 严重级别。只有未解决的 medium/high 项进入下一轮。

默认最多 3 轮：第 1 轮包含独立调研与首次互评，第 2、3 轮只处理未解决争议。达到上限仍无共识时，系统不隐藏争议，而是在最终报告中展示各方观点和证据。

### 7.4 综合与签核

综合负责人按 Topic 的 Run 顺序在三种 Provider 间轮换，避免固定偏向。综合负责人生成报告，另外两个 Agent 做签核：

- 两者均批准：完成。
- 有 medium/high 问题且未超过轮次：返回定向深挖。
- 达到轮次上限：完成但明确标记未决争议。
- 少于两个 Provider 成功：暂停并通知用户决定重试或降级。

## 8. 子 Agent 策略

顶层 Agent 不直接无限制创建后台进程，而是输出 `SubtaskProposal`。Orchestrator 验证后创建同 Provider 的子 Session：

- 每个顶层 Agent 最多 2 个子任务；
- 全局活动 Session 不超过 6；
- 子任务有独立时间和调用预算；
- 子任务结果回到父 Agent 和 Topic Event Store；
- 取消父任务会级联取消尚未提交的子任务。

这保留了 Agent 定义多 Agent 工作的能力，同时保证资源可见、可停和可审计。

## 9. CLI Adapter 契约

### 9.1 Claude Code

使用 `claude -p --input-format stream-json --output-format stream-json`；新 Session 使用指定 UUID，后续使用 `--resume`。启用结构化 schema 和受控工具集。

### 9.2 Codex

使用 `codex exec --json --output-schema`；从 `thread.started` 记录线程 ID，后续使用 `codex exec resume <id>`。研究阶段使用只读 Sandbox。

### 9.3 Copilot CLI

使用 `copilot -p --output-format json --session-id <uuid> --no-ask-user`；通过 `--available-tools` 和细粒度 allow/deny 约束工具，并用 `--secret-env-vars` 去除敏感环境变量。

所有 Adapter 把原始 JSONL 保存到受限日志，再转换为统一事件：`session_started`、`delta`、`tool_call`、`tool_result`、`final`、`usage`、`error`。

## 10. 权限与审批

研究进程默认可读取 Topic Artifact、指定工作区、网页和公开来源，并可在自己的临时目录写缓存。以下动作不能由模型直接执行：

- 修改用户工作区文件；
- 向飞书或其他外部系统发送消息；
- 部署、发布、购买或更改权限；
- 删除数据、强推或执行不可逆命令。

模型只能输出 `ActionRequest`。Approval Engine 生成飞书卡片，包含动作、目标、差异/预览、风险、提出者、有效期和批准/拒绝按钮。批准令牌一次性使用并绑定用户、Topic、动作哈希；执行器用幂等键防止重复执行。由用户刚刚发出的命令直接触发的机器人回复、状态卡片更新和报告发送属于 Channel 的正常响应，不视为模型主动外发动作，无需再次审批。

## 11. 飞书接入

- 使用 `@larksuiteoapi/node-sdk` 的长连接能力，无需公网回调 URL。
- 四个 App 各自配置 `app_id` 和 `app_secret`，由 App Registry 映射到角色。
- Secret 仅从 `.env.local` 或云 Secret Manager 注入，`.env.local` 不进 Git。
- 事件先按飞书 `event_id` 去重，再解析 `tenant_key`、`union_id` 和 `open_id`。
- 回复通过 Outbox 发送；交互卡片回调同样去重。
- 机器人正在运行时持续更新一张状态卡片，避免刷屏；关键节点另发消息。

当前四个 App 已通过飞书 Agent 模板启用机器人、权限、消息事件和长连接订阅，并处于 Enabled/Published 状态。

## 12. 故障恢复

- **飞书重复事件**：`event_id` 唯一约束，重复事件直接确认。
- **Worker 掉线**：任务使用租约和心跳；租约超时后从最后已提交水位重派。
- **进程崩溃**：CLI Session ID 和阶段事件已持久化，恢复时用 Provider 的 resume 能力。
- **部分 Agent 失败**：自动重试一次；至少两个成功时生成降级报告，否则暂停。
- **限流**：指数退避加随机抖动，Outbox 保证最终发送。
- **上下文过长**：重建摘要并按证据相关度检索；原始事件保持不变。
- **无效 JSON**：一次格式修复，再失败则标记 degraded。
- **审批过期**：不执行，用户可重新发起。
- **服务重启**：扫描非终态 Run、过期租约和待发送 Outbox 后继续。

## 13. 安全与审计

- App Secret、CLI 登录令牌和用户私密文件不进入模型提示词或 Agent 环境。
- Worker 注册使用短期令牌；远程部署使用 TLS。
- Topic 访问按 owner/editor/viewer 校验。
- 所有工具调用、证据来源、审批和外部动作写入不可变审计事件。
- 日志默认脱敏 `app_secret`、访问令牌、Cookie 和授权头。
- 每个 Topic 使用隔离工作目录，路径解析后必须位于允许根目录内。

## 14. 可观测性

提供结构化日志和指标：

- Run 阶段耗时、成功率和重试次数；
- 每 Provider 调用次数、令牌/费用和失败类型；
- 活动 Worker、租约、队列深度；
- Feishu 事件延迟、Outbox 重试和限流；
- Claim 数量、证据覆盖率、争议数量和签核结果。

每条日志包含 `topic_id`、`run_id`、`session_id` 和 `event_seq`，但不包含 Secret。

## 15. 实现结构

采用 Node.js 24、TypeScript 和 pnpm：

```text
apps/control-plane/       # Feishu Gateway、HTTP 健康检查、Orchestrator
apps/worker/              # CLI 进程主管和 Worker Gateway 客户端
packages/domain/          # 实体、状态机、策略
packages/storage/         # SQLite Event Store、投影、Outbox
packages/feishu/          # 四 App Registry、消息与卡片
packages/agent-protocol/  # Worker 协议、CLI 统一事件、JSON Schema
packages/agent-adapters/  # Claude、Codex、Copilot Adapter
tests/fixtures/           # Feishu 与 CLI JSONL 固件
```

控制面和 Worker 可在同一进程启动用于本地开发；生产仍走相同协议，避免第二套逻辑。

## 16. 测试策略

### 16.1 单元测试

- Topic 生命周期、成员权限和全局游标；
- ResearchRun 状态机及三轮上限；
- Claims/Evidence/Critiques 规范化；
- Context Pack 水位和压缩；
- 审批令牌、过期和幂等；
- Secret 脱敏和路径隔离。

### 16.2 契约测试

为三个 CLI 提供假可执行文件和 JSONL 固件，验证：

- 新建、恢复、取消和异常退出；
- Session ID 提取；
- 流式事件转换；
- schema 错误和重试；
- 不向子进程泄露 Secret。

### 16.3 集成测试

- 使用临时 SQLite 数据库跑完整 `independent -> review -> synthesize` 流程；
- 使用 Feishu 事件固件验证四 App 路由、用户统一和 Topic 切换；
- 验证崩溃恢复、租约超时和 Outbox 重放；
- 验证审批前不执行、批准后只执行一次。

### 16.4 真实 Smoke Test

1. 分别启动四个真实 App 长连接。
2. 用户在总控创建 Topic 并发送一个低成本调研问题。
3. 验证三个真实 CLI 并行运行、交叉审阅并生成带证据报告。
4. 在 Claude/Codex/Copilot 机器人中继续同一 Topic，验证 Session 恢复。
5. 重启服务，验证 `/topic use`、`/status` 和 `/report` 仍可恢复。
6. 发起一个受控写操作，验证飞书审批卡片和幂等执行。

## 17. 验收标准

- 四个机器人都能识别同一用户与同一当前 Topic。
- Topic 创建、切换、恢复、共享、归档和完整历史可用。
- 完整调研同时调用三个真实 CLI，最多三轮并遵守并发上限。
- 三个 Agent 能看到对方上一阶段的结构化输出并产生可追溯 Critique。
- 最终报告的重要 Claim 均有 Evidence；无证据项明确标记。
- 未解决分歧不会被隐藏。
- 服务重启不会丢 Topic、Run、Session ID、证据、审批或报告。
- 读取/搜索/测试无需审批；高风险动作在批准前绝不执行。
- App Secret 不出现在 Git、日志、测试快照或 Agent 子进程环境中。
- 单元、契约、集成测试全部通过，真实四 App Smoke Test 有运行证据。
