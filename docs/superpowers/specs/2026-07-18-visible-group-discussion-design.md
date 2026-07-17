# 飞书可见群聊自动讨论设计

日期：2026-07-18  
状态：已批准，进入实现  
范围：在保留 Hub 后台调研与三个 Agent 单聊多 Session 的基础上，新增由 Hub 主持、三个 Agent 公开发言、用户可随时 steer 的飞书群聊讨论模式。

## 1. 产品目标

群聊本身是讨论现场，而不是后台任务的通知窗口。用户在同一个飞书群中看到 Claude、Codex、Copilot 以各自机器人身份发言；Hub 自动安排下一位发言者、维护讨论状态和生成结论。用户不需要记忆一组控制命令，可以在讨论进行中随时补充信息、纠正方向或要求某个视角得到关注。

现有行为保持不变：

- Hub 单聊普通消息和 `/research` 继续执行证据化后台调研。
- Claude、Codex、Copilot 单聊继续使用每 Topic 多 Session。
- 群聊讨论不复用 direct Session，也不改变后台 ResearchRun 的状态机。

## 2. 群聊体验

### 2.1 开始讨论

用户把四个机器人加入群聊后，向 Hub 提出问题。第一版以 `@Hub <问题>` 作为可靠入口；若飞书向 Hub 投递未 @ 的群消息，系统也按相同规则处理。

每个群聊绑定一个当前 Topic：

- 尚未绑定时，第一条问题创建 Topic，标题取问题摘要。
- 已绑定且没有活动讨论时，新问题在同一 Topic 中创建新的 Discussion。
- 已有活动讨论时，用户消息作为 steer，而不是创建第二个并发 Discussion。
- 同一个群同一时刻最多一个活动 Discussion，避免多条机器人对话交叉。

### 2.2 自动推进

Hub 采用顺序圆桌，默认次序为 Claude → Codex → Copilot，下一轮轮换首位，避免固定的首发偏差。每个 Agent 的发言作为该 Agent App 发送的群消息，包含：

- 对当前问题或最新 steer 的直接回应；
- 对已有观点的支持、修正或反驳；
- 新证据、风险或未解决问题；
- 是否仍有必要继续讨论的结构化判断。

讨论默认最多三轮。完成一整轮后，如果三个 Agent 均判断没有新的重要问题，Hub 提前进入总结；否则自动开始下一轮。达到上限时必须总结，并明确保留尚未解决的分歧。

### 2.3 用户 steer

活动讨论中的人类群消息都会作为 steer 持久化，并在下一位 Agent 发言前进入 Context Pack。steer 不需要命令，支持：

- 补充事实或附件说明；
- 指出错误或改变目标；
- 要求关注某个角度；
- 自然语言指定“下一位让 Claude/Codex/Copilot 回应”。

默认是软转向：不截断已经开始生成的发言，但保证下一位 Agent 优先处理所有尚未消费的 steer。需要立即中断时，用户点击控制卡片的“暂停”；暂停会取消当前调用，保留 steer，点击“继续”后重新调度。

机器人发出的消息绝不能成为 steer。Gateway 根据飞书 `sender_type` 丢弃机器人/应用消息，防止四个 App 互相触发形成回环。

### 2.4 单张控制卡片

Hub 在开始时发送一张控制卡片，并持续更新同一条消息。卡片显示：

- Topic 和讨论问题；
- `讨论中 / 已暂停 / 总结中 / 已完成 / 已停止 / 失败`；
- 当前或下一位发言者；
- 当前轮次与最多轮次；
- 待处理 steer 数；
- 最近一个未解决问题；
- 动态按钮：暂停或继续、立即总结、停止。

Agent 正文不塞进控制卡片，避免卡片变成长文。最终总结由 Hub 另发一条消息，控制卡片只更新为完成状态并给出摘要提示。

## 3. 命令与自然交互

群聊模式不新增需要记忆的 slash 命令。产品入口与控制为：

| 行为 | 交互 |
|---|---|
| 开始 | `@Hub <问题>` |
| steer | 直接发送补充或纠正；可靠路径为 `@Hub <内容>` |
| 指定视角 | 自然语言写明希望哪个 Agent 下一位回应 |
| 暂停/继续 | 控制卡片按钮 |
| 立即总结 | 控制卡片按钮 |
| 停止 | 控制卡片按钮 |

已有 `/status`、`/report`、`/stop` 仍服务于后台 ResearchRun，不与群聊 Discussion 混用。

## 4. 状态与持久化

新增 `group_chat_topics`：

- `tenant_key`, `chat_id`：群聊作用域，联合主键；
- `topic_id`：群当前 Topic；
- `updated_at`。

新增 `group_discussions`：

- `id`, `topic_id`, `tenant_key`, `chat_id`, `question`；
- `state`: `active | paused | summarizing | completed | stopped | failed`；
- `round`, `turn_index`, `next_provider`, `max_rounds`；
- `preferred_provider`：steer 请求的下一位 Agent，可为空；
- `control_message_id`：Hub 控制卡片的飞书 message ID，可为空；
- `active_turn_id`：当前调用，可为空；
- `created_at`, `updated_at`。

新增 `discussion_steers`：

- `id`, `discussion_id`, `topic_event_seq`；
- `principal_id`, `text`, `preferred_provider`；
- `status`: `pending | consumed`；
- `created_at`, `consumed_at`；
- 飞书 `message_id` 唯一，保证同一人类消息跨 App 投递时只产生一次 steer。

新增 `discussion_turns`：

- `id`, `discussion_id`, `provider`, `round`, `turn_index`；
- `state`: `queued | running | completed | cancelled | failed`；
- `external_session_id`, `text`, `continue_discussion`, `open_questions_json`；
- `started_at`, `completed_at`；
- `(discussion_id, turn_index)` 唯一。

每个 Discussion/provider 使用独立 `agent_sessions` role：`discussion:<discussion_id>`。因此服务重启后可以恢复 CLI Session，但不会与单聊或后台 ResearchRun 串线。

所有用户 steer、Agent 发言、状态变化和总结同时写入 TopicEvent，完整群聊语义可以重建。

## 5. 组件边界

### 5.1 Feishu Gateway

- 解析 `chat_type` 与 `sender_type`。
- P2P 保持现有路由。
- 群聊中只接受人类消息；跨 App 以 `message_id` 全局去重。
- 无活动 Discussion 时把 Hub 群消息解释为开始；有活动 Discussion 时解释为 steer。
- Provider App 收到的人类 @ 消息也进入同一 Discussion，并将对应 provider 设为 preferred；它不直接启动单聊 Session。

### 5.2 DiscussionCoordinator

独立于 `ResearchOrchestrator`，负责一个清晰职责：推进可见圆桌的下一步。

1. 事务性创建下一条 `discussion_turns`。
2. 获取尚未消费的 steer，并构建只属于该 Discussion 的 Context Pack。
3. 调用目标 provider 的 `start/resume`。
4. 解析统一输出 `{message, continueDiscussion, openQuestions}`；无效 JSON 退化为原文本并默认继续。
5. 保存结果，消费本轮 steer，通过对应 provider App 写入 Outbox。
6. 更新控制卡片，选择下一 provider 或进入总结。

Coordinator 同一 Discussion 只允许一个推进循环；不同群的 Discussion 可以并行，并继续受全局 provider 并发上限保护。

### 5.3 可更新 Outbox

Outbox 增加 `create | update` 操作：

- `create` 使用 `im.message.create`，保存返回的 message ID。
- `update` 使用 `im.message.patch` 更新同一控制卡片。
- 创建控制卡片成功后，delivery effect 把 message ID 写回 `group_discussions.control_message_id`，并立即补发当前最新状态，避免首个 Agent 很快完成造成卡片过期。
- Agent 发言和最终总结始终使用 `create`，并保留稳定 UUID 与重试。

## 6. 控制卡片安全

按钮 value 包含 `discussionId`、`action` 和随机版本号，不包含 Secret。回调必须验证：

- 卡片由 Hub App 发出；
- Discussion 与回调所在 tenant/chat 匹配；
- 操作者拥有稳定用户身份；
- Discussion 当前状态允许该转换；
- `(discussion_id, action, callback_event_id)` 幂等。

群成员可以 steer、暂停、继续或要求总结。只有 Discussion 发起者或 Topic owner 可以停止。第一版不尝试从飞书重新同步完整群成员列表；权限来自已验证的回调操作者与该 Discussion 的群作用域。

## 7. 状态机与并发

```text
active ──pause──> paused ──resume──> active
   │                 │
   ├──consensus──────┤
   ├──round limit────┴──> summarizing ──> completed
   ├──summarize button───> summarizing
   ├──stop───────────────> stopped
   └──fatal failure──────> failed
```

- pause/stop 会 Abort 当前 provider 调用；turn 标记为 cancelled。
- resume 从同一 provider 和未消费 steer 重新创建新 turn，不重复已经公开的发言。
- 同一个飞书消息或卡片回调重放不创建第二个 Discussion、steer、turn 或群消息。
- 同一 Discussion 的 turn 严格串行，不同 Discussion 可并行。

## 8. Context 隔离

Discussion Context Pack 包含：

- Topic 元数据与共享笔记；
- 当前 Discussion 的问题、公开 Agent 发言和用户 steer；
- 尚未解决问题与轮次；
- 本轮尚未消费的 steer，放在最高优先级。

它排除：

- 其他群 Discussion 的对话；
- 单聊 direct Session 内容；
- 后台 ResearchRun 的内部中间 JSON；最终报告可作为共享 Topic 结果引用。

## 9. 恢复与失败体验

- 服务启动时将 `running` turn 变为 `queued`，恢复 `active/summarizing` Discussion。
- 单个 Agent 失败时，在群里由该 Agent App 发出简短失败提示，Hub 自动转到下一位；同一轮少于两个 Agent 成功则暂停并在控制卡片提示。
- Provider 未登录或配额失败不会结束整个 Discussion；用户仍可 steer、总结或停止。
- 控制卡片 update 失败走 Outbox 重试，不阻塞 Agent 发言。
- 服务关闭时取消活动调用，保留未消费 steer 和下一 provider。

## 10. 验收标准

- 在一个包含四个机器人的真实飞书群中，`@Hub` 问题会创建一个 Discussion 和一张控制卡片。
- Claude、Codex、Copilot 以各自 App 身份公开发言，并自动推进至少一整轮。
- 用户中途 steer 后，下一位 Agent 的输入与公开回复能够证明已吸收 steer。
- 控制卡片始终更新同一 message ID；暂停、继续、总结和停止符合状态机且幂等。
- 机器人消息不会触发新 Discussion 或 steer，不会产生回环。
- 同群不并发两场 Discussion，不同群可以并行。
- 重启后 active Discussion、CLI Session、未消费 steer、下一 provider 和控制卡片均可恢复。
- P2P 后台 Research 与单 Agent 多 Session 全部不回归。
- 确定性测试、类型检查、构建、密钥扫描通过；真实群聊 smoke 留下四 App 发言、steer 和同卡更新证据。
