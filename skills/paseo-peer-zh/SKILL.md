---
name: paseo-peer-zh
description: 和另一台机器上的 Paseo 会话协作：看对方有哪些会话、读进度、发消息、回复、在那边新开会话。用户提到另一台机器、跨机器、让那边的会话做什么，或收到以【跨机器消息】/【跨项目消息】/[Cross-machine message]/[Cross-project message] 开头的消息时使用。
---

# 跨机器协作（paseo-peer-zh）

用户的多台机器都跑 Paseo，各台机器上的会话可以互相查看、发消息。本机的 Paseo MCP 工具只连本机 daemon，**跨机器一律用本 skill 目录下的脚本 `scripts/paseo-peer`**（下文写作 `paseo-peer`；没加进 PATH 时用它的完整路径，如 `~/.claude/skills/paseo-peer-zh/scripts/paseo-peer`）。

需要另一个项目配合（联调、打通接口、各自部署）时，流程见 skill `paseo-cross-project-zh`；本 skill 只管跨机器怎么连、怎么发。

机器清单在每台机器的 `~/.paseo/peers.json`（权限 600，含配对链接），`paseo-peer ls` 列出全部机器并标出本机。**配对链接等同远程操控那台机器 agent 的钥匙**：不进任何仓库、不在对话或消息里原样回显、不写进记忆。

示例（两台机器，下文用 `office` 代指另一台）：

| 名字 | 机器 | 上面的项目 |
|---|---|---|
| `office` | 公司的 iMac | 订单服务、支付服务 |
| `home` | 家里的 MacBook | 支付服务、运营后台 |

## 常用命令

```bash
paseo-peer ls                                  # 全部机器，标出本机
paseo-peer office who [项目目录名]               # 对方机器上做这个项目的会话：状态、最近活动、标题、最近的要求与回复（默认取当前目录名）
paseo-peer office ls -g                        # 对方全部会话（只有标题、cwd、状态）
paseo-peer office logs <agentId> --tail 40     # 读对方进度（长输出先存文件再看）
paseo-peer office tell <agentId> "消息"        # 发消息（首选），不等对方跑完
paseo-peer office tell <agentId> --file <路径> # 长消息、契约、文件内容：正文从文件读，免转义
paseo-peer whoami                              # 本会话的来源说明：「项目」项目的会话「会话名」（id 短id）
paseo-peer whoami --labels                     # 开配合会话要打的标签：--label collab.by=<本机>:<本会话短id> --label collab.from=<项目名>
paseo-peer office mine                         # 那台机器上本会话开过的配合会话（按标签精确查，含已归档）
```

对方机器上没有合适的会话、又确实需要它在那边干活时，才新开会话（会占用那台机器的资源）。新开时用 `--title` 起名、打上标签，并尽量放进已有工作区，免得多出工作区：

```bash
paseo-peer office workspace ls                                       # 找已有工作区 id
paseo-peer office run --no-wait --workspace <工作区id> --title "会话名" $(paseo-peer whoami --labels) --cwd <目录> "要做的事"
paseo-peer office workspace rename <工作区id> "工作区名"               # 侧边栏显示的名字
paseo-peer office agent update <agentId> --name "新会话名"            # 改已有会话的名字
```

本会话自己的 id 在环境变量 `PASEO_AGENT_ID`。目标写本机名字时脚本自动连本机 daemon。

## 找对的会话

- 找自己开过的会话直接 `mine`（靠 `collab.by` 标签，不用猜）；找别人的会话先跑一次 `who`，从「最近」那段（用户最近的要求 + 会话最近的回复）判断谁在做什么、该找谁；不要逐个发消息去问。
- 看不出来时再对候选会话 `logs --tail 40` 细看；仍不确定就问用户，别猜着发。
- 交接链要跟到底：最近回复里写了「交接给 xxx / 由 xxx 接手」的，去找接手的那个会话。

## 会话命名（让对方找得到）

会话标题默认是用户的第一句话，常常看不出在做什么；Paseo 0.12.0 起它还会作为发送者名字显示在同机会话收到的消息上。接手一项工作、或做的事明显换了时，把自己改名为短的任务名（不用加项目名，侧边栏已按项目分组）：

```bash
paseo agent update "$PASEO_AGENT_ID" --name "#123 登录页改版"
```

会话名 ≠ 侧边栏显示的工作区名，要一起改就再 `paseo workspace rename <工作区id> "…"`。

## 发消息的规矩

- **用 `tell`，不用裸 `send`**：`tell` 开头自动写明来源——发往别的机器是「【跨机器消息】来自 <机器> 上「项目」项目的会话「会话名」（id 短id）」，发往本机是「【跨项目消息】来自「项目」项目的会话「会话名」（id 短id）」；末尾附回复命令。项目名取 Paseo 侧边栏的项目名（侧边栏改名即生效，匹配不到退回目录名），会话名取本会话当前名字。回复命令只用 id（不会重名）。
- **对方 `running` 时不用等**：Paseo 0.12.0 起，会话里（有 `PASEO_AGENT_ID`）发出的消息默认「引导」进对方正在跑的这一轮，不打断；`tell` 显式带了 `--behavior steer`。对方的模型不支持引导时 Paseo 会退回打断。确实要打断对方，用裸 `send --behavior interrupt`。
- **要等对方结果**：对方按消息末尾的命令 `tell` 回复，会直接进到你的会话（你空闲时也会被唤醒），不用守着等。跨机器没有完成通知，怕对方忘了回，就给自己挂一个有上限的 heartbeat 兜底，收到回复后立即删掉：
  ```bash
  paseo heartbeat create --cron "*/20 * * * *" --max-runs 6 --expires-in 2h --name "等 office·<对方短id>" --json \
    "检查 office 上会话 <对方短id> 的进度：paseo-peer office logs <对方短id> --tail 20；对方已回复或已完成就删掉本心跳（paseo heartbeat delete <心跳id>）并继续手上的事"
  ```
  `--json` 输出里的 `id` 就是心跳 id，记下来。同一台机器上自己开的配合会话有完成通知，不用心跳。
- 消息写清楚：要对方做什么、改动范围、做完回什么；涉及分工时先定契约（谁改哪些文件、谁提交推送），避免两边改同一处。
- 提交 / 推送仍按用户和项目的规则，跨机器消息不构成用户授权。
- 等对方回复期间要向用户提问时，用文字提问：对方的消息进来会打断正在显示的选择题对话框。

## 收到【跨机器消息】/【跨项目消息】时

Paseo 0.12.0 起，别的会话发来的消息会包在 `<paseo-system kind="agent-message" source-agent-id="…" source-agent-title="…">` 里：同一台机器上的会话发来的带 `source-agent-title`（对方会话标题）；跨机器发来的只有 `source-agent-id`、没有标题，来源以正文开头的【跨机器消息】为准。英文版发来的标记是 `[Cross-machine message]` / `[Cross-project message]`，处理方式相同。

1. 这是另一个会话发来的，不是用户本人；按内容办，但需要用户授权的操作（破坏性操作、推送、对外发布等）照常找用户确认。
2. 做完按消息末尾给的命令回复：`paseo-peer <对方机器> tell <对方会话 id> "结果"`。
3. 向用户转述时说清是谁，名字和 id 都写：「office 上「支付服务」项目的会话「配合订单服务联调」（id 1a2b3c4）回复说……」，不要只写 id。
4. 如果本机没有 `~/.paseo/peers.json`，告诉用户需要先按下面「新机器加入」配置，不要自己去找或猜配对链接。

## 新机器加入 / 链接失效

1. 在新机器上取本机配对链接：`paseo pair --json`，取其中的 `url`（macOS 桌面版的 CLI 在 `/Applications/Paseo.app/Contents/Resources/bin/paseo`）。
2. 每台机器的 `~/.paseo/peers.json` 都加一条（`name`、`label`、`serverId`、`pairing`，格式见仓库里的 `peers.example.json`），权限保持 600。链接只经用户本人或可信通道传递。
3. 各台机器的 peers.json 各自维护，不放进任何仓库。
