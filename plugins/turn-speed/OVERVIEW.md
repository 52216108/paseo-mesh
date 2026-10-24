Shows how fast the model generated each turn. When a Claude Code or Codex turn completes, a small row appears at the end of the turn: tokens per second, output tokens, generation time, and the number of model requests.

## How it works

After each completed turn, the daemon plugin reads the provider's own local session log on the daemon machine (`~/.claude/projects/…/<session>.jsonl` for Claude Code, `~/.codex/sessions/…/rollout-…-<thread>.jsonl` for Codex). For each model request in the turn it takes the reported output tokens and the time from the last input (prompt or tool result) to the end of the reply. The row shows total output tokens divided by total request time.

- Output tokens include thinking and reasoning tokens.
- Request time includes time to first token, so this is end-to-end speed, not pure decoding speed. Tool execution time is excluded.
- `CLAUDE_CONFIG_DIR` and `CODEX_HOME` are honored.

## What it reads

The plugin parses those logs locally and retains only metrics: timestamps, entry types, message IDs, and token counts. The log lines it reads contain conversation text, which is discarded as each line is parsed and is never stored, logged, or sent anywhere. The plugin makes no network requests and writes nothing to disk. The row it adds contains only the numbers above.

## Known limits

- Only Claude Code and Codex agents are supported, and their logs must be written by the CLI on the daemon machine.
- Canceled or failed turns get no row.
- The log formats are not stable interfaces of those CLIs; a CLI update can stop the row from appearing until the plugin is updated.
- Rows live in the daemon's memory and disappear after a daemon restart.
