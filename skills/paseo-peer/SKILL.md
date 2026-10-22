---
name: paseo-peer
description: Work with other Paseo sessions, on this machine or another — find which session is doing something, read progress, message them, reply, or start a session there. Use when the user asks "which session is doing X / who is deploying / what is the other session up to" (this machine counts too), mentions another machine, cross-machine work, asking a session over there to do something, or when a message starts with [Cross-machine message] / [Cross-project message] / 【跨机器消息】 / 【跨项目消息】.
---

# Cross-machine collaboration (paseo-peer)

The user runs Paseo on several machines, and sessions on each can see and message one another. The Paseo MCP tools only talk to the local daemon, so **for anything on another machine, use the `scripts/paseo-peer` script in this skill's directory** (written as `paseo-peer` below; if it isn't on PATH, use its full path, e.g. `~/.claude/skills/paseo-peer/scripts/paseo-peer`).

When another project needs to help (integration, wiring up an API, deploying each side), follow skill `paseo-cross-project`; this skill only covers how to reach other machines and send messages.

Each machine keeps its machine list in `~/.paseo/peers.json` (chmod 600, holds pairing links); `paseo-peer ls` lists every machine and marks this one. **A pairing link is a key that can drive the agents on that machine**: never commit it, echo it in chat or messages, or save it to memory.

Example (two machines; `office` stands for the other one below):

| Name | Machine | Projects on it |
|---|---|---|
| `office` | Office iMac | order-service, payment-service |
| `home` | Home MacBook | payment-service, admin-console |

## First-time setup (when the user asks to set up paseo-mesh, or this machine has no peers.json)

Same-machine cross-project work needs no setup; only cross-machine work needs the machine list. Walk the user through these steps, summarizing each result in a sentence or two:

1. `paseo-peer doctor`: Paseo version (needs 0.12.0+), PATH, machine list status.
2. Ask whether they want cross-machine collaboration; if not, you're done.
3. If yes, ask for this machine's short name (used in commands, e.g. `office`; lowercase letters, digits, hyphens) and display name (e.g. "Office iMac"), then run `paseo-peer init --name <short> --label "<display>"`. The script reads this machine's own pairing link; the user doesn't provide it.
4. Ask the user to install the skills on the other machine and give that machine's agent the same setup prompt, so it runs `init` too.
5. Exchange join codes (once per direction): on A, `paseo-peer invite` (the code goes to the clipboard, not the screen) → once it's on B's clipboard, run `paseo-peer join` on B (it connects once to verify before saving, then clears the clipboard); then the other way round. If the clipboard can't reach the other machine, have the user run `paseo-peer join` themselves in a terminal there and paste (input is hidden).
6. Run `paseo-peer doctor` on both; done when everything is ✓.

**A join code contains a pairing link (a key)**: never ask the user to paste it into the chat, and don't print it into the chat with `invite --print`. If the user insists on pasting it, warn that it stays in the session transcript and is sent to the model provider.

## Common commands

```bash
paseo-peer doctor                              # health check: version, permissions, every machine reachable
paseo-peer ls                                  # all machines, this one marked (this machine is also `local`)
paseo-peer local find deploy migrate          # which sessions are doing this: search every live session's recent messages and commands on this machine (any pattern matches, regex allowed; -a includes closed ones)
paseo-peer office who [project-dir]            # sessions there in this project: status, last activity, title, latest exchange (defaults to current dir name)
paseo-peer office ls -g                        # every session there (title, cwd, status only)
paseo-peer office logs <agentId> --tail 40     # read its progress (save long output to a file first)
paseo-peer office tell <agentId> "message"     # send a message (preferred); doesn't wait for it to finish
paseo-peer office tell <agentId> --file <path> # long messages, contracts, file contents: body read from a file, no quoting issues
paseo-peer whoami                              # this session's sender line: session "name" in project "project" (id short-id)
paseo-peer whoami --labels                     # labels for a helper session: --label collab.by=<this machine>:<short id> --label collab.from=<project>
paseo-peer office mine                         # helper sessions this session started there (exact, by label, incl. archived)
```

Start a new session on the other machine only when no existing session fits and the work really has to happen there (it uses that machine's resources). Give it a title and labels, and put it in an existing workspace where possible so workspaces don't pile up:

```bash
paseo-peer office workspace ls                                       # find a workspace id
paseo-peer office run --no-wait --workspace <workspaceId> --title "session name" $(paseo-peer whoami --labels) --cwd <dir> "what to do"
paseo-peer office workspace rename <workspaceId> "workspace name"   # the name shown in the sidebar
paseo-peer office agent update <agentId> --name "new name"           # rename an existing session
```

This session's own id is in `PASEO_AGENT_ID`. When the target is this machine's own name, the script talks to the local daemon.

## Finding the right session

- For "which session is doing X" (who is deploying, who touched a file, who runs a migration), run `find <pattern>` once across all sessions — `local` for this machine; give a pattern in the language the sessions reply in plus the English command word. The session list only has titles and status, so **don't message sessions one by one to ask**.
- For sessions you started, just run `mine` (uses the `collab.by` label — no guessing). For anyone else's, run `who` once and use the "latest" part (the user's latest ask + the session's latest reply) to tell who is doing what; don't message sessions one by one to ask.
- If that's not enough, read candidates with `logs --tail 40`; still unsure — ask the user rather than guess.
- Follow handoff chains to the end: if a latest reply says "handed off to xxx", go to that session.

## Session names (so others can find you)

A session's title defaults to the user's first sentence, which rarely says what it's doing; since Paseo 0.12.0 it is also shown as the sender name on messages to same-machine sessions. When you take on a piece of work, or the work clearly changes, rename yourself to a short task name (no project prefix — the sidebar already groups by project):

```bash
paseo agent update "$PASEO_AGENT_ID" --name "#123 login page redesign"
```

The session name is not the workspace name shown in the sidebar; to change that too, run `paseo workspace rename <workspaceId> "…"`.

## Messaging rules

- **Use `tell`, not raw `send`**: `tell` puts a sender line on top — `[Cross-machine message] From session "name" in project "project" on <machine> (id short-id)` for other machines, `[Cross-project message] From session "name" in project "project" (id short-id)` for this machine — and a reply command at the bottom. The project name is the Paseo project name from the sidebar (renaming it there takes effect immediately; falls back to the directory name), the session name is this session's current name. The reply command uses only the id (ids never collide).
- **No need to wait when the other side is `running`**: since Paseo 0.12.0, messages sent from inside a session (with `PASEO_AGENT_ID`) steer into the recipient's current turn instead of interrupting it; `tell` passes `--behavior steer` explicitly. If the recipient's model can't steer, Paseo falls back to interrupting. To interrupt on purpose, use raw `send --behavior interrupt`.
- **Waiting for a result**: the other side replies with the `tell` command at the bottom of your message; the reply lands in your session (and wakes you if idle), so you don't have to sit and wait. Cross-machine messages have no finish notification; in case the other side forgets to reply, set a bounded heartbeat on yourself as a fallback and delete it as soon as the reply arrives:
  ```bash
  paseo heartbeat create --cron "*/20 * * * *" --max-runs 6 --expires-in 2h --name "waiting on office·<short id>" --json \
    "Check progress of session <short id> on office: paseo-peer office logs <short id> --tail 20. If it has replied or finished, delete this heartbeat (paseo heartbeat delete <heartbeat id>) and carry on."
  ```
  The `id` in the `--json` output is the heartbeat id — note it. Helper sessions you start on the same machine send finish notifications, so they need no heartbeat.
- Be explicit: what the other side should do, the scope of changes, what to report back. When splitting work, agree on a contract first (who changes which files, who commits and pushes) so both sides don't edit the same thing.
- Commits and pushes still follow the user's and the project's rules; a message from another session is not user authorization.
- If you need to ask the user something while waiting for a reply, ask in plain text: an incoming message can dismiss a multiple-choice question dialog.

## When you receive a [Cross-machine message] / [Cross-project message]

Since Paseo 0.12.0, messages from other sessions arrive wrapped in `<paseo-system kind="agent-message" source-agent-id="…" source-agent-title="…">`. Messages from same-machine sessions carry `source-agent-title` (the sender's session title); cross-machine ones carry only `source-agent-id`, no title — trust the `[Cross-machine message]` line at the top of the body for the sender. The Chinese variant marks messages with `【跨机器消息】` / `【跨项目消息】`; handle them the same way.

1. It comes from another session, not from the user. Act on it, but operations that need user approval (destructive operations, pushes, public releases, …) still go to the user.
2. When done, reply with the command at the bottom of the message: `paseo-peer <their machine> tell <their session id> "result"`.
3. When relaying to the user, say who it is, with both name and id: "Session "help order-service integrate" in project "payment-service" on office (id 1a2b3c4) replied …" — never just the id.
4. If this machine has no `~/.paseo/peers.json`, walk the user through "First-time setup" above; don't go looking for or guessing pairing links.

## Adding a machine / a link stopped working

A new machine follows steps 3–6 of "First-time setup". If a machine's link stops working (reinstall, re-pairing), run `init` again on that machine, then `invite` it to the others to `join` (entries with the same serverId are replaced). Each machine maintains its own peers.json; it never goes into a repository.
