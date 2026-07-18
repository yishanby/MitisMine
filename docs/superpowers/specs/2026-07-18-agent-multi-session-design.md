# MitisMine 单 Agent 多 Session 设计

日期：2026-07-18  
状态：已实施；截至代码修订 `dcc1df4fb5cedd74ff2f8d19d17bf987e42e385a` 于 2026-07-18 完成验证

范围：在共享 Topic 和群体调研之外，为 Claude、Codex、Copilot 三个飞书 App 提供彼此独立、可持久化恢复的多 Session 体验。

## 1. 用户体验

Topic 仍是共享研究空间；Session 是某个 Agent 在该 Topic 内的一条独立连续对话。用户在三个 Agent App 中分别维护当前 Session，互不影响。

在任一 Agent App 中可使用：

- `/session new <标题>`：创建并选中新 Session。外部 CLI Session 在第一条普通消息时延迟创建。
- `/session list`：列出当前 Topic 下该 Agent 的 Session，标出当前项、状态、短 ID 与最近使用时间。
- `/session use <短 ID 或唯一标题>`：切换到已有 Session；下一条普通消息恢复其 CLI Session。
- `/session resume <短 ID 或唯一标题>`：`use` 的同义命令。
- `/session show`：显示当前 Session 的 provider、标题、ID、状态、外部 Session 是否已建立及上下文水位。
- `/session rename <标题>`：重命名当前 Session。
- `/session archive`：归档当前 Session，并选择最近使用的其他活动 Session；没有活动项时保持无选择。

普通消息发送给当前 Session。尚无 Session 时，系统自动创建并选择 `main`，从而兼容现有用户路径。归档 Session 不可继续对话；可在列表中看到，但不能切换过去。

Session 游标按 `(tenant, principal, topic, provider)` 保存。因此：

1. Claude、Codex、Copilot 各自有独立当前 Session。
2. 切换 Topic 后，再切回来会恢复该 provider 在该 Topic 的上次选择。
3. 同一个共享 Topic 可以同时容纳多个方向的单 Agent 深挖。
4. `/research` 群体调研继续由总控 App 管理，不使用 direct Session 游标。

## 2. App 与命令边界

三个 provider App 接受 `/topic use`、`/topic show`、`/status`、`/report`、全部 `/session` 命令及普通消息。Session 管理命令只作用于当前 App 对应的 provider；用户不需要再输入 provider 名称。

总控 App 不接受 `/session`，避免用户误以为群体调研属于某个单 Agent Session。若在总控 App 输入该命令，返回明确引导，要求到 Claude、Codex 或 Copilot App 使用。

命令的读取权限与 Topic 读取权限一致；创建、重命名、归档和发送普通消息要求 Topic 编辑权限。飞书事件仍按 `(app_role, event_id)` 幂等处理。

## 3. 数据模型

新增 `direct_sessions`：

| 字段 | 含义 |
|---|---|
| `id` | 稳定 ULID；供命令短前缀选择与事件关联 |
| `topic_id` | 所属共享 Topic |
| `provider` | `claude`、`codex` 或 `copilot` |
| `title` | 用户可读名称；同 Topic/provider 下大小写不敏感唯一 |
| `external_session_id` | CLI 返回的可恢复 Session/Thread ID，可为空 |
| `context_watermark` | 最近一次成功响应后纳入共享上下文的事件水位 |
| `status` | `active`、`running` 或 `archived` |
| `created_at` / `updated_at` | 创建和最近使用时间 |

新增 `direct_session_cursors`：

| 字段 | 含义 |
|---|---|
| `tenant_key` / `principal_id` | 用户稳定身份 |
| `topic_id` / `provider` | 游标作用域 |
| `session_id` | 当前 direct Session |
| `updated_at` | 最近切换时间 |

外键保证 Session 必须属于相同 Topic；Store 在设置游标时额外验证 provider 与状态。

现有 `agent_sessions` 保留给群体调研和兼容逻辑。数据库打开时，将每个 `(topic, provider, role='direct')` 的旧行幂等迁移成标题为 `main` 的 direct Session，保留 `id`、`external_session_id`、水位和状态；不会删除旧行，以便回滚和审计。

## 4. Context 隔离

Topic 的固定信息、用户笔记以及群体调研结果属于共享上下文。direct 对话事件带 `directSessionId`：

- `agent.direct.message` 保存用户问题、provider 和 Session ID。
- `agent.direct.completed` 保存响应、provider、Session ID 和外部 Session ID。

为某个 direct Session 构建 Context Pack 时：

1. 包含 Topic 元数据、共享消息/笔记和群体调研事件。
2. 包含当前 direct Session 的全部 direct 消息与响应（受字符预算压缩）。
3. 排除其他 direct Session 的消息和响应，包括同 provider 的其他 Session。

即使 CLI 自己通过外部 Session ID 保留对话，控制面仍提供经过隔离的共享 Topic 增量，以便重启、迁移或 provider 侧历史裁剪后保持语义稳定。

## 5. 调度与并发

不同 Session 可以并行运行。同一 Session 必须串行执行，以保持外部 CLI 的对话顺序。控制面用 keyed promise queue 按 direct Session ID 排队；排队只存在于进程内，持久状态用于崩溃后的恢复。

一次 direct turn 的事务顺序为：

1. 解析/自动创建并选择 Session。
2. 追加幂等的 `agent.direct.message` 事件。
3. 将 Session 标记为 `running`。
4. 若无 `external_session_id` 则调用 adapter `start`，否则调用 `resume`。
5. 成功后更新外部 ID、水位和 `active` 状态，并追加幂等完成事件。
6. 失败后恢复为 `active`，记录错误响应；用户下次可以继续重试。

同一个飞书事件重放不能创建第二个 Session、第二条消息或第二次有效完成事件。

## 6. 恢复与边界情况

- 服务重启：Session、游标和外部 ID 均来自 SQLite；下一条消息自动 resume。
- 旧数据库：打开时自动执行幂等迁移；无旧 direct 行时不创建多余 Session。
- 标题冲突：大小写不敏感拒绝，并提示使用现有 Session。
- 短 ID 冲突：要求提供更长前缀；标题只有唯一精确匹配时可选中。
- 归档当前项：自动选择最近更新的活动 Session；没有则下一条消息新建 `main`，若 `main` 已归档则创建带序号的 `main 2`。
- provider 不可用：Session 保留，响应报错但不丢失外部 ID。
- viewer：允许 list/show/use，拒绝 new/rename/archive/普通消息。

## 7. 验收标准

- 每个 provider App 可独立创建、列出、切换、重命名和归档多个 Session。
- 每个用户、Topic、provider 的当前 Session 可独立保存并在重启后恢复。
- 第一条普通消息兼容性地创建 `main`；后续消息正确 start/resume。
- 两个 Session 的上下文互不泄漏，同一 Session 的 turn 严格串行，不同 Session 可并行。
- 旧 `agent_sessions` direct 数据无损迁移。
- Topic viewer/editor 权限和飞书事件幂等规则覆盖 Session 操作。
- 群体 discuss/research 行为及既有测试不回归。

当前验证记录为：根级 `pnpm test:run` 通过 23 个测试文件、跳过 1 个，
221 个测试通过、3 个显式 live 用例跳过，耗时 5.73 秒；真实 CLI
start+resume 验证为 Claude 14,283 ms、Codex 27,676 ms、Copilot 31,747 ms，
3/3 通过。以上是仓库级回归与真实 provider 连续性证据，不表示每条验收标准
都分别经过独立的线上实证。
