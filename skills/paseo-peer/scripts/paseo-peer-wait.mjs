// paseo-peer <machine> wait <agentId>: wait for one turn of a session to finish, then print its last reply in full.
// Called by the paseo-peer script (never directly): the connection arrives as PEER_HOST / PEER_PASSWORD in the
// environment (never argv), PASEO is the CLI path, LANG_UI is zh|en, PEER_TARGET is the machine name as typed.
//
// Why this exists: a finish notification can be lost (sending to a session that is `closed` consumes the
// subscription with a stale "closed" event) and carries only the first 4000 characters of the reply.
//
// Status comes from `paseo inspect --json` fields, never from the column layout of `ls`.
import { execFile } from "node:child_process"
import { pathToFileURL } from "node:url"

export const EXIT = { done: 0, usage: 1, notStarted: 2, timeout: 3, permission: 4, unreachable: 5 }
export const DEFAULTS = { timeoutMin: 60, maxTimeoutMin: 120, intervalSec: 30, startGraceSec: 300 }

/** Parses `wait` arguments. Returns { id, timeoutMs, intervalMs, startGraceMs } or { error }. */
export function parseArgs(argv) {
  let id = ""
  let timeoutMin = DEFAULTS.timeoutMin, intervalSec = DEFAULTS.intervalSec, startGraceSec = DEFAULTS.startGraceSec
  const num = (v) => (v !== undefined && /^\d+(\.\d+)?$/.test(v) ? Number(v) : NaN)
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === "--timeout") timeoutMin = num(argv[++i])
    else if (a === "--interval") intervalSec = num(argv[++i])
    else if (a === "--start-grace") startGraceSec = num(argv[++i])
    else if (a.startsWith("-")) return { error: `unknown option ${a}` }
    else if (id) return { error: "only one agentId" }
    else id = a
  }
  if (!id) return { error: "missing agentId" }
  if (!(timeoutMin > 0 && timeoutMin <= DEFAULTS.maxTimeoutMin)) return { error: `--timeout must be 0–${DEFAULTS.maxTimeoutMin} minutes` }
  if (!(intervalSec >= 1 && intervalSec <= 600)) return { error: "--interval must be 1–600 seconds" }
  if (!(startGraceSec >= 0)) return { error: "--start-grace must be a number of seconds" }
  return { id, timeoutMs: timeoutMin * 60_000, intervalMs: intervalSec * 1000, startGraceMs: startGraceSec * 1000 }
}

/** Turns `paseo inspect --json` output into a sample; anything unreadable is { ok: false }. */
export function parseInspect(stdout) {
  let j
  try { j = JSON.parse(stdout) } catch { return { ok: false, error: "inspect output is not JSON" } }
  if (!j || typeof j.Status !== "string" || !j.Status) return { ok: false, error: "inspect output has no Status" }
  return {
    ok: true,
    id: typeof j.Id === "string" ? j.Id : "",
    status: j.Status,
    updatedAt: typeof j.UpdatedAt === "string" ? j.UpdatedAt : "",
    pending: Array.isArray(j.PendingPermissions) ? j.PendingPermissions : [],
  }
}

export function initialState(startMs) {
  return { phase: "waiting", startMs, polls: 0, baselineUpdatedAt: null, lastIdleAt: null, sinceMs: null,
           startedSeen: false, last: null, lastError: "" }
}

/**
 * One poll. Returns the new state plus, when the wait is over, `done: { code, status }`.
 * - running at any poll = the turn has started (already running on the first poll counts);
 * - after that, leaving running (to anything but initializing) = the turn is over;
 * - never seen running, but UpdatedAt moved and the session is idle/error again = a turn shorter than one interval;
 * - a pending permission request ends the wait at once (we only report it, never answer it);
 * - no running within the start grace = not started; still running at the timeout = timeout.
 */
export function step(state, sample, nowMs, opts) {
  const s = { ...state, polls: state.polls + 1 }
  const elapsed = nowMs - s.startMs
  if (!sample.ok) {
    s.lastError = sample.error || "unknown error"
    // Never read once (wrong id, machine down): give up after the start grace instead of the whole timeout
    if (!s.last && elapsed >= Math.min(opts.startGraceMs, opts.timeoutMs)) return { state: s, done: { code: EXIT.unreachable } }
    if (elapsed >= opts.timeoutMs) return { state: s, done: { code: s.last ? (s.phase === "running" ? EXIT.timeout : EXIT.notStarted) : EXIT.unreachable } }
    return { state: s }
  }
  s.last = sample
  s.lastError = ""
  if (sample.pending.length) return { state: s, done: { code: EXIT.permission, status: sample.status } }

  if (s.phase === "waiting") {
    if (sample.status === "running") {
      s.phase = "running"
      s.startedSeen = true
      // Reply lookup starts at the last poll that saw it not running (null = it was already running when we began)
      s.sinceMs = s.lastIdleAt
    } else {
      if (s.baselineUpdatedAt === null) s.baselineUpdatedAt = sample.updatedAt
      else if (sample.updatedAt !== s.baselineUpdatedAt && (sample.status === "idle" || sample.status === "error")) {
        s.sinceMs = s.lastIdleAt
        return { state: s, done: { code: EXIT.done, status: sample.status } }
      }
      s.lastIdleAt = nowMs
      if (elapsed >= Math.min(opts.startGraceMs, opts.timeoutMs)) return { state: s, done: { code: EXIT.notStarted, status: sample.status } }
      return { state: s }
    }
  }
  if (sample.status !== "running" && sample.status !== "initializing") return { state: s, done: { code: EXIT.done, status: sample.status } }
  if (elapsed >= opts.timeoutMs) return { state: s, done: { code: EXIT.timeout, status: sample.status } }
  return { state: s }
}

/** `logs --filter assistant --tail 1` prints the last assistant message untagged and untruncated. */
export function parseLastReply(stdout) {
  const text = (stdout || "").replace(/\s+$/, "")
  return !text || text === "No activity to display." ? "" : text
}

const pad = (n) => String(n).padStart(2, "0")
export const clock = (ms) => { const d = new Date(ms); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}` }

async function main() {
  const zh = process.env.LANG_UI === "zh"
  const L = (a, b) => (zh ? a : b)
  const target = process.env.PEER_TARGET || "local"
  const self = process.env.SELF_CMD || "paseo-peer"
  const args = parseArgs(process.argv.slice(2))
  if (args.error) {
    console.error(L(`用法：paseo-peer <机器> wait <agentId> [--timeout 分钟，默认 60、最长 120] [--interval 秒，默认 30] [--start-grace 秒，默认 300]（${args.error}）`,
                    `Usage: paseo-peer <machine> wait <agentId> [--timeout minutes, default 60, max 120] [--interval seconds, default 30] [--start-grace seconds, default 300] (${args.error})`))
    process.exit(EXIT.usage)
  }
  const env = { ...process.env }
  if (env.PEER_HOST) { env.PASEO_HOST = env.PEER_HOST; delete env.PASEO_HOME }
  if (env.PEER_PASSWORD) env.PASEO_PASSWORD = env.PEER_PASSWORD
  for (const k of ["PEER_HOST", "PEER_PASSWORD", "PEER_TARGET", "LANG_UI", "SELF_CMD"]) delete env[k]
  const run = (cliArgs) => new Promise((resolve) =>
    execFile(process.env.PASEO, cliArgs, { encoding: "utf8", maxBuffer: 64 << 20, env, timeout: 120_000 },
      (e, out, err) => resolve({ ok: !e, out: out || "", err: (err || e?.message || "").trim() })))

  const opts = { timeoutMs: args.timeoutMs, startGraceMs: args.startGraceMs }
  let state = initialState(Date.now())
  let done
  for (;;) {
    const r = await run(["inspect", args.id, "--json"])
    const sample = r.ok ? parseInspect(r.out) : { ok: false, error: r.err.split("\n").pop() || "inspect failed" }
    if (!sample.ok && state.polls === 0) console.error(L(`（查不到状态，继续重试：${sample.error}）`, `(could not read status, retrying: ${sample.error})`))
    ;({ state, done } = step(state, sample, Date.now(), opts))
    if (done) break
    await new Promise((ok) => setTimeout(ok, args.intervalMs))
  }

  const now = clock(Date.now())
  const id = state.last?.id || args.id
  const short = id.slice(0, 7)
  const last = state.last
  if (done.code === EXIT.done) {
    const logArgs = ["logs", id, "--filter", "assistant", "--tail", "1"]
    // 5 s margin for clock skew between machines; sinceMs is a poll that saw the session not running
    if (state.sinceMs !== null) logArgs.push("--since", new Date(state.sinceMs - 5000).toISOString())
    const r = await run(logArgs)
    const reply = r.ok ? parseLastReply(r.out) : ""
    console.log(L(`${target} 上的会话 ${short} 这一轮已跑完（${now}），最终状态 ${done.status}`,
                  `Session ${short} on ${target} finished its turn (${now}); final status ${done.status}`))
    if (done.status === "error") console.log(L("状态是 error：这一轮可能没做完（如 API 断线），看完回复再决定是否催它继续", "Status is error: the turn may be incomplete (e.g. a dropped API connection); read the reply, then decide whether to nudge it"))
    if (!r.ok) console.log(L(`读不到最后回复：${r.err}`, `Could not read the last reply: ${r.err}`))
    else if (!reply) console.log(L("这一轮没有文字回复", "No text reply in this turn"))
    else console.log(`${L("--- 最后一条回复（全文）---", "--- Last reply (full text) ---")}\n${reply}`)
  } else if (done.code === EXIT.notStarted) {
    console.log(L(`${target} 上的会话 ${short} 在 ${Math.round(args.startGraceMs / 1000)} 秒内一直没开始（${now}，当前状态 ${done.status ?? last?.status ?? "未知"}，最近活动 ${last?.updatedAt || "未知"}）。消息可能没送到；如果对方很快就做完了，用 ${self} ${target} logs ${short} --tail 20 看一下`,
                  `Session ${short} on ${target} did not start within ${Math.round(args.startGraceMs / 1000)} s (${now}; status ${done.status ?? last?.status ?? "unknown"}, last activity ${last?.updatedAt || "unknown"}). The message may not have arrived; if the turn was very quick, check ${self} ${target} logs ${short} --tail 20`))
  } else if (done.code === EXIT.timeout) {
    const span = args.timeoutMs >= 60_000 ? L(`${Math.round(args.timeoutMs / 60000)} 分钟`, `${Math.round(args.timeoutMs / 60000)} min`)
                                          : L(`${Math.round(args.timeoutMs / 1000)} 秒`, `${Math.round(args.timeoutMs / 1000)} s`)
    console.log(L(`等了 ${span}，${target} 上的会话 ${short} 还在跑（${now}，状态 ${done.status ?? last?.status}）。要继续等就再运行一次 wait`,
                  `Waited ${span}; session ${short} on ${target} is still running (${now}; status ${done.status ?? last?.status}). Run wait again to keep waiting`))
  } else if (done.code === EXIT.permission) {
    console.log(L(`${target} 上的会话 ${short} 停在权限请求（${now}），未代为批准，请转给用户决定：`,
                  `Session ${short} on ${target} is waiting on a permission request (${now}); not answered — ask the user:`))
    const r = await run(["permit", "ls", "--json"])
    let detail = null
    try {
      const all = JSON.parse(r.out)
      const mine = (Array.isArray(all) ? all : []).filter((p) => JSON.stringify(p).includes(id))
      if (mine.length) detail = mine
    } catch {}
    console.log(JSON.stringify(detail ?? last.pending, null, 2))
    console.log(L(`用户同意后：${self} ${target} permit allow ${short} <请求id>；拒绝：${self} ${target} permit deny ${short} <请求id>`,
                  `If the user agrees: ${self} ${target} permit allow ${short} <request id>; to refuse: ${self} ${target} permit deny ${short} <request id>`))
  } else {
    console.log(L(`一直查不到 ${target} 上会话 ${args.id} 的状态（${now}）：${state.lastError}`,
                  `Could not read the status of session ${args.id} on ${target} (${now}): ${state.lastError}`))
  }
  process.exit(done.code)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main()
