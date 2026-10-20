# paseo-mesh

**简体中文** | [English](README.en.md)

> 让 [Paseo](https://paseo.sh) 里的会话互相找到、互相说话——跨项目，也跨机器。

Paseo 自带的编排能力，是**一个会话管它自己的子 agent**：派活、等通知、收结果，而且只在本机。真实的工作往往不是这样：

- 订单服务的会话需要支付服务那边配合改接口、联调、各自部署；
- 公司那台机器上的会话，要让家里那台机器上的会话接着干，或者问它进度；
- 同一个项目里并行着好几个会话，彼此需要知道谁在做什么。

paseo-mesh 是两个 Agent Skill 加一个小脚本，补上的就是这块：**会话与会话之间（同机跨项目、跨机器）的发现、通信与协作规矩**。

## 能做什么

- **跨机器操作会话**：经 Paseo 中继连到另一台机器的 daemon，看它有哪些会话、读进度、发消息、在那边新开会话、改名。
- **消息自带「我是谁、怎么回」**：每条消息开头写明来源，末尾附回复命令，对方即使是刚开的新会话也知道怎么回：
  ```
  【跨机器消息】来自 公司的 iMac 上「订单服务」项目的会话「退款接口打通」（id 1a2b3c4）
  ---
  ……正文……
  ---
  （回复请运行：paseo-peer office tell 1a2b3c4 "回复内容"，长回复用 --file；用法见 skill paseo-peer-zh）
  ```
  项目名直接取 Paseo 侧边栏里的项目名，会话名取发送方当前的会话名，改名即生效；同机跨项目标为【跨项目消息】。
- **不打断对方**：消息引导（steer）进对方正在跑的这一轮，而不是打断它（Paseo 0.12.0+）。
- **找得回自己开的会话**：开配合会话时自动打 `collab.by` / `collab.from` 标签，`paseo-peer <机器> mine` 一次精确找回。
- **跨项目协作的规矩**：在对方项目开专门工作区和配合会话、契约先行、分工、兼容性（扩展-收缩）、部署按各自项目规则、发起方统一核对与汇报——写成 skill，会话照着做。
- **等回复不空等**：对方回复会直接唤醒你的会话；怕对方忘了回，用有上限的 heartbeat 兜底。

## 包含什么

| Skill | 语言 | 作用 |
|---|---|---|
| `paseo-peer-zh` / `paseo-peer` | 中文 / English | 跨机器连接与通信，含脚本 `scripts/paseo-peer` |
| `paseo-cross-project-zh` / `paseo-cross-project` | 中文 / English | 跨项目协作流程（同机或跨机） |

中英两套功能相同，按你的语言装一套即可；两种语言的消息标记双方都认，混用也能互通。

## 环境要求

- Paseo **0.12.0+**（每台机器），daemon 开启中继（官方中继或[自建中继](https://github.com/getpaseo/paseo/blob/main/public-docs/connectivity.md)）
- PATH 里有 `bash` 和 `node`
- macOS 或 Linux；Paseo CLI 在 PATH 里，或使用 macOS 桌面版自带的 `/Applications/Paseo.app/Contents/Resources/bin/paseo`

## 安装

1. 在每台机器上安装 skill（中文版）：
   ```bash
   npx skills add 52216108/paseo-mesh -g -s paseo-peer-zh -s paseo-cross-project-zh
   ```
   英文版把 skill 名换成 `paseo-peer`、`paseo-cross-project`。

2. 把脚本放进 PATH（可选，推荐；回复命令会因此变短）：
   ```bash
   mkdir -p ~/.local/bin
   ln -s ~/.claude/skills/paseo-peer-zh/scripts/paseo-peer ~/.local/bin/paseo-peer
   ```
   路径以 `npx skills add` 实际安装的位置为准。

3. 在每台机器上写机器清单 `~/.paseo/peers.json`（格式见 [`peers.example.json`](peers.example.json)）：
   ```bash
   paseo pair --json          # 在每台机器上取它自己的配对链接（url）和 serverId
   chmod 600 ~/.paseo/peers.json
   ```
   每台机器的清单都要列出所有机器（包括它自己），`name` 是你在命令里用的短名。

4. 试一下：
   ```bash
   paseo-peer ls              # 列出机器，标出本机
   paseo-peer office ls -g    # 看另一台机器上的会话
   ```

之后在会话里直接说「让公司那台机器上做支付服务的会话看一下这个问题」「让支付服务配合把退款接口打通」，会话就会按 skill 来做。

### 自己改 skill？直接用仓库

想边用边改的话，不必用 `npx skills add` 的副本，把仓库克隆下来，再把 skill 目录链接进去：

```bash
git clone https://github.com/52216108/paseo-mesh ~/projects/paseo-mesh
ln -s ~/projects/paseo-mesh/skills/paseo-peer-zh ~/.claude/skills/paseo-peer-zh
ln -s ~/projects/paseo-mesh/skills/paseo-cross-project-zh ~/.claude/skills/paseo-cross-project-zh
```

其他机器 `git pull` 即更新。

## 安全

- **配对链接 = 钥匙**。拿到它的人可以操控那台机器上的 agent。`peers.json` 只放本机、`chmod 600`、不进任何仓库；skill 也要求会话不在对话、消息、记忆里回显它。脚本把链接经环境变量（`PASEO_HOST`）交给 Paseo CLI，不出现在命令行参数里（其他系统用户用 `ps` 看不到）；`peers.json` 权限不是 600 时脚本拒绝运行。
- 跨机器流量经 Paseo 中继转发（端到端加密，中继读不到内容，见 [Paseo 安全文档](https://github.com/getpaseo/paseo/blob/main/public-docs/security.md)）；对中继有顾虑可以[自建中继](https://github.com/getpaseo/paseo/blob/main/public-docs/connectivity.md)。
- 来自其他会话的消息**不等于用户授权**：skill 要求推送、发布、破坏性操作照常找用户确认。

## 已知限制

- 跨机器发来的消息，Paseo 只带发送方 id、不带会话名，所以来源靠消息开头那一行辨认。
- 跨机器没有完成通知，靠对方回复或 heartbeat 兜底。
- 项目名按会话所在目录匹配 Paseo 项目；开在 Paseo 管理的 worktree 里的会话，项目名会退回 worktree 目录名。
- 等对方回复期间，对方消息进来可能打断 Claude Code 的选择题对话框（skill 里已要求此时用文字提问）。

## 许可

[MIT](LICENSE)
