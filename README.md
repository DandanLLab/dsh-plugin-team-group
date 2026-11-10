# dsh-plugin-team-group

团队群聊插件（dsh host plugin）：**角色卡 + 群组 + 导演发言规划器 + 逐角色执行引擎**，QQ 式群聊界面，SSE 实时流。

架构思路受 [Operit](https://github.com/AAswordman/Operit) 的角色群组 / group-execution 模式启发（发言规划器返回 JSON rounds，逐轮逐角色执行），在 dsh 插件体系上落地。

## 特性

- **角色卡**：每个成员一张卡——名字、二次元头像、主题色、人格基底（任选 registry 预设）、附加人设段、可选专属模型；每卡一个持久 agent 会话
- **群组（房间）**：成员混编——角色卡 + **任意渠道会话**（QQ 私聊/群、飞书……）。渠道会话本身就是团队成员（"一个会话即一个角色"），收到房间上下文后调用团队工具发言，不桥接消息流
- **导演发言规划器**：独立导演会话规划"谁说话、按什么焦点说"，返回 JSON rounds（最多可配轮数）；规划失败自动降级全员单轮
- **拉人审批流**：`team_group_invite` 不直接进房——写入待审批队列并通知管理员会话（大总管），`team_group_approve` 批准/驳回后才生效；Web UI 顶部有审批条，管理员可直接批
- **跨房间/跨频道喊话**：`team_group_convene` 支持一次召集多个房间；`team_group_ask` 跨房点名任何成员；管理员会话（如 QQ 私聊）可随时调用
- **QQ 式 UI**：头像 + 名字 + 气泡排版，用户消息右对齐，系统消息虚线居中；侧边栏「团队」入口，iframe 面板
- **动态化，零硬编码**：头像从 `ui/avatars/` 扫描下发、预设从 `agentPresets.list()` 动态拉取、渠道会话从 sessions 目录自动发现、管理员称呼可配置

## 架构

```
Web UI (iframe /team-group)          host 半 (lib/index.js)
┌─────────────────────────┐   SSE    ┌──────────────────────────────┐
│ 群聊列表 / 角色卡 / 气泡流 │ ◀──────  │ rooms.json / cards.json      │
│ 输入条（管理员插话）       │ ──POST▶  │ 导演会话 tg-director          │
└─────────────────────────┘          │ 成员会话 tg-<room>-<card>     │
                                     │ 渠道会话成员（resume 复用）     │
                                     │ 7 把 team_group_* 工具        │
                                     └──────────────────────────────┘
```

一轮发言：输入/工具触发 → 导演规划 JSON rounds → 逐轮逐成员 `followup`（带房间上下文）→ 成员调 `team_group_speak` 落账 → SSE 推流。

## 安装

在 dsh profile 的 `package.json` 里三刀接入（以 profile `my-profile` 为例）：

1. dependencies 加 `"dsh-plugin-team-group": "link:<本仓库路径>"`
2. `dsh.profile.bundles` 数组加 `"dsh-plugin-team-group"`
3. 建好 node_modules 链接（Windows junction：`cmd /c mklink /J`），重启 dsh

重启后侧边栏出现「团队」入口，日志可见 `[team-group] team tools registered`。

## 配置（插件 rawConfig）

| 键 | 默认 | 说明 |
|---|---|---|
| `masterName` | `Master` | 管理员在房间里的显示称呼 |
| `masterSessionId` | `qq-dm-$DSH_QQ_DM_TARGET` | 管理员会话（拉人审批通知发给它） |
| `qqSessionNames` | `{}` | 渠道会话展示名表，如 `{"qq-dm-123":"Owner","qq-group-456":"Main"}` |
| `maxRounds` | `3` | 导演规划的最大轮数 |
| `directorTimeoutMs` | `90000` | 导演规划超时（超时降级全员单轮） |
| `memberTimeoutMs` | `150000` | 单成员发言等待超时 |
| `historyLimit` | `300` | 房间历史保留条数 |
| `stateDir` | `~/.dsh/team-group` | cards.json / rooms.json 存放目录 |

## 团队工具（7 把，全会话可见）

| 工具 | 说明 |
|---|---|
| `team_group_speak` | 以你的角色身份在房间里发言 |
| `team_group_plan_submit` | 导演专用：提交 JSON 发言规划 |
| `team_group_create_room` | 创建新房间，返回 roomId |
| `team_group_invite` | 申请拉人进房（进入管理员审批流） |
| `team_group_approve` | 管理员审批：批准/驳回拉人申请 |
| `team_group_convene` | 召集一轮讨论，支持 `roomIds` 多房同喊 |
| `team_group_ask` | 跨房点名单个成员回答 |

## HTTP API（挂载于 `/team-group`）

| 路由 | 说明 |
|---|---|
| `GET/POST/DELETE /api/cards` | 角色卡增删查 |
| `GET/POST /api/rooms`、`DELETE /api/rooms/:id` | 房间管理 |
| `GET /api/rooms/:id/history` | 房间历史 |
| `POST /api/rooms/:id/say` | 管理员插话（触发一轮） |
| `GET /api/rooms/:id/invites`、`POST /api/rooms/:id/approve` | 拉人审批 |
| `GET /api/rooms/:id/sessions`、`GET /api/rooms/:id/events` | 会话列表 / SSE 实时流 |
| `GET /api/qq-sessions` | 渠道会话自动发现 |
| `GET /api/avatars`、`GET /api/presets` | 头像模板 / 可用预设 |

## 头像

`ui/avatars/` 下的 `*.png`（优先）/ `*.svg` 自动成为头像模板，卡片按 id 引用。本仓库的两张示例头像（breaker / mohist）为矢量绘制后导出的 512px PNG，可随意替换。

## License

MIT
