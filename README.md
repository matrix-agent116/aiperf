# gh-triage-agent

配置驱动、多仓库轮询、**人在环路**的 GitHub Issue/PR 判定 Agent。

监控 `config.yaml` 里配置的仓库，对**别人**提交的 issue / PR 用 Claude 判定「要不要回复」以及「下一步动作」，然后把判断 + 上下文推送到 **Telegram**。所有对 GitHub 的写操作（发评论、关 issue、批准/拒绝 PR、打标签）**都要你在 Telegram 上按钮确认后才执行**——bot 绝不自动操作。

## 为什么不是又一个 GitHub Action

现有开源方案（`anthropics/claude-code-action`、Issue AI Agent、`Elifterminal/pr-triage`）几乎都是 GitHub Action：绑单仓库、事件触发、AI 直接发评论。本项目相反：一个常驻进程集中轮询多个仓库，判定结果先给人拍板，再回写 GitHub。

## 架构

```
常驻 Node 进程
├─ Poll Loop（每 N 分钟）
│   Octokit 拉「他人提交、游标之后」的 issue/PR
│     → Claude Agent SDK 判定（结构化 Decision）
│       → 推 Telegram（带内联按钮）→ 存 pending + 推进游标
└─ Telegram Loop（grammy 长轮询）
    接按钮回调 / 修改文本 → Octokit 回写 GitHub → 编辑消息回执
```

- **判定**（读）：Claude Agent SDK，只做推理不给任何工具，上下文由 poller 组装齐全。
- **拉取 + 回写**（读/写）：Octokit，写操作只在人工确认后触发。
- **状态**：`node:sqlite` 单文件（游标 + 去重指纹 + pending 决策），进程重启后按钮仍可用。

## 安装

```bash
npm install          # 纯 JS 依赖，无需原生编译
cp .env.example .env # 填 3 个 token
cp config.example.yaml config.yaml
```

需要 **Node.js ≥ 22**（用内置 `node:sqlite` 和原生 TS 执行）。已在 Node 26 上验证。

### 环境变量（`.env`）

| 变量 | 说明 |
|---|---|
| `CLAUDE_CODE_OAUTH_TOKEN` | **判定用，推荐**。先在终端跑 `claude setup-token` 生成，直接用你的 Claude Code 订阅，无需 API key |
| `GITHUB_TOKEN` | PAT/App token，**需对被监控仓库有写权限** |
| `TELEGRAM_BOT_TOKEN` | 找 [@BotFather](https://t.me/BotFather) 创建 |

> 判定走 Claude Agent SDK（底层是自带的 Claude Code 二进制），认证二选一：
> - **`CLAUDE_CODE_OAUTH_TOKEN`**（推荐）—— `claude setup-token` 生成，用订阅额度；
> - 或 `ANTHROPIC_API_KEY` —— 按 API 计费。
> 两者都设时 API key 会覆盖 OAuth token，只留一个即可。

> ⚠️ 因为要能关 issue / 审批 PR，被监控的仓库必须是你有写权限（维护者/协作者）的仓库。

### 配置（`config.yaml`）

```yaml
poll_interval_minutes: 5
model: claude-opus-4-8
telegram:
  chat_id: "123456789"        # 用 @userinfobot 查你的 chat_id
lookback_days_on_first_run: 7 # 首次只看最近 7 天，避免拉整个历史
reminder_after_hours: 24      # 卡片未处理时，每隔 N 小时催一次；0 关闭
http:                         # 草稿回复由本服务网页展示，卡片只放链接
  port: 8787
  base_url: "http://localhost:8787"  # 外部可达地址；不填默认 http://localhost:<port>
repos:
  - url: https://github.com/owner/repo
    watch: [issues, pulls]
    only_from_others: true    # 只处理非维护者提交的（按 author_association 判断）
    ignore_authors: []        # 额外忽略的作者（如自己的 bot）
```

## 运行

```bash
npm start          # 常驻 daemon（轮询 + Telegram 长轮询）
npm run poll-once  # 只跑一轮，判定并推送后退出（调链路用）
npm run typecheck  # tsc 类型检查
```

## Telegram 交互

- **需要回复（issue）**：卡片上「💬 草稿回复」是一个链接（`http.base_url` + `/reply/<id>`，展示草稿全文）；按钮 `✅ 批准并回复` / `✏️ 修改` / `🚫 忽略`。
  - 点「修改」后直接发一条文本，bot 用你的文本发**普通评论**到 issue；回执附上评论链接。
- **需要回复（PR）**：判定会产出**逐条、挂到代码行的审查意见**。卡片给一个 URL 按钮 `🔎 逐条审核并提交`（+ `🚫 忽略`），点开是本服务的**富审查网页**（`/review/<id>?t=<token>`）：
  - 每条意见展示 严重度 / `文件:行` / 意见 / 依据 / 对应代码片段，逐条勾选是否采纳。
  - 提交后作为**一次 `COMMENT` review**发到 GitHub：能定位到改动行的作为**行内评论**，无法定位的自动进 **review 正文**（不丢意见、也不会被 GitHub 拒绝）。
  - 提交成功后 Telegram 卡片收尾并附上这次 review 的链接。
  - 网页链接带 `token` 鉴权（每张卡一个），拿到链接即可查看+提交。
- **不需要回复**：展示建议动作 + 理由，按钮 `✅ 执行「动作」` / `🚫 忽略`（`pulls.createReview` 的 APPROVE / REQUEST_CHANGES 等）。
- 每次操作后原消息去掉按钮并追加回执（✅ 已回复 / ✅ 已提交 PR Review / ✅ 已关闭 …），防重复点击。
- 网页由 daemon 内置 HTTP 服务提供（`npm start` 随之启动，监听 `http.port`）；`npm run poll-once` 不启动该服务，链接打不开。

支持的动作：发评论、关闭 issue、批准 PR、要求修改 PR、关闭 PR、打标签。

### 逾期提醒

卡片推送后若一直没处理，bot 会**每隔 `reminder_after_hours`（默认 24h）催一次**（回复在原卡片下，显示已拖了多少小时），直到你处理为止；处理后（回复/执行/忽略）自动停。检查频率跟随轮询间隔，`reminder_after_hours: 0` 可关闭。

### 同一条的去重

- 已推送处理过的 issue/PR 不会重复推（按 `编号@updated_at` 指纹去重，落库、重启仍在）。
- 未批示、且该 issue/PR **没有新活动** → 不会重复推，静等你处理。
- 未批示、但该 issue/PR **来了新评论/被编辑**（`updated_at` 变了）→ 会重新判定并推一张新卡，同时**自动取消旧卡**（去掉按钮、标注已被取代），保证同一条只剩最新一张能点。
- 判定或推送**失败**的条目不会被误标为已处理，下一轮会重试，不会被静默漏掉。

## 目录

```
src/
  index.ts            # 入口：poll loop + telegram loop
  config.ts           # 读取 + zod 校验 config.yaml
  store.ts            # node:sqlite 持久化
  server.ts           # 内置 HTTP 服务：issue 草稿页 + PR 富审查页/提交
  diff.ts             # unified-diff 解析（行号 / 可评论行）
  types.ts            # TriageItem / PrContext
  github/
    client.ts         # Octokit 单例
    poller.ts         # 拉取 + 组装判定 payload
    actions.ts        # 回写 GitHub
  judge/
    judge.ts          # Claude Agent SDK 调用 + JSON 解析重试
    prompt.ts         # 判定 prompt
    schema.ts         # Decision 的 zod schema
  telegram/
    bot.ts            # grammy bot + 回调/修改文本处理
    render.ts         # Decision → Telegram 消息 + 按钮
```
