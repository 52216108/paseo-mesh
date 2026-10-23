显示模型每一轮的生成速度。Claude Code 或 Codex 的一轮对话完成后，对话末尾会出现一行小字：每秒 token 数、输出 token 数、生成耗时和模型请求次数。

## 工作原理

每轮完成后，插件在 daemon 机器上读取对应 CLI 自己的本地会话日志（Claude Code 为 `~/.claude/projects/…/<会话>.jsonl`，Codex 为 `~/.codex/sessions/…/rollout-…-<线程>.jsonl`）。对这一轮里的每次模型请求，取日志记录的输出 token 数，以及从最后一次输入（提示词或工具结果）到回复写完的时间。显示的速度是输出 token 总数除以请求总耗时。

- 输出 token 包含思考和推理 token。
- 请求耗时包含等待首个 token 的时间，所以这是端到端速度，不是纯解码速度。工具执行时间不计入。
- 支持 `CLAUDE_CONFIG_DIR` 和 `CODEX_HOME` 环境变量。

## 读取的内容

插件只从这些日志中读取时间戳、条目类型、消息 ID 和 token 数。不读取也不保存对话正文，不发任何网络请求，不写入磁盘。追加到对话里的那一行只包含上面这些数字。

## 已知限制

- 只支持 Claude Code 和 Codex，且日志须由 daemon 同一台机器上的 CLI 写入。
- 取消或失败的轮次不显示。
- 日志格式不是这些 CLI 的稳定接口，CLI 更新后可能暂时不显示，需要等插件更新。
- 这一行保存在 daemon 内存中，daemon 重启后历史行会消失。
