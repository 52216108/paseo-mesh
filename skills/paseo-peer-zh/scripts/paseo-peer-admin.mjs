// paseo-peer setup commands: init / invite / join / doctor
// Invoked by the paseo-peer script with env: PASEO (CLI path), PEERS (peers.json path), LANG_UI (zh|en), SELF_CMD.
// Pairing links (keys to a machine) only ever live in memory and in peers.json (mode 600):
// never in argv, never printed unless the user explicitly asks with --print.
import { execFileSync, spawnSync } from "node:child_process"
import { existsSync, readFileSync, writeFileSync, chmodSync, statSync, renameSync } from "node:fs"
import { hostname } from "node:os"

const { PASEO, PEERS, LANG_UI, SELF_CMD } = process.env
const zh = LANG_UI === "zh"
const t = (z, e) => (zh ? z : e)
const PREFIX = "paseo-mesh-join:"
const cmd = SELF_CMD || "paseo-peer"
const [sub, ...args] = process.argv.slice(2)

const die = (z, e) => { console.error(t(z, e)); process.exit(1) }
const flag = (name) => args.includes(name)
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined }

// ---- paseo CLI ----
// host: pairing link for a remote daemon (passed via PASEO_HOST, not argv), or undefined for local
function paseoJson(cliArgs, host, timeout = 30000) {
  const env = { ...process.env }
  if (host) { env.PASEO_HOST = host; delete env.PASEO_HOME }
  const out = execFileSync(PASEO, [...cliArgs, "--json"], { encoding: "utf8", env, timeout, stdio: ["ignore", "pipe", "pipe"] })
  return JSON.parse(out)
}

// ---- peers.json ----
function loadPeers() {
  if (!existsSync(PEERS)) return { machines: [] }
  const d = JSON.parse(readFileSync(PEERS, "utf8"))
  d.machines ??= []
  return d
}
function savePeers(d) {
  // write to a 600 temp file, then rename, so the file is never briefly world-readable
  const tmp = `${PEERS}.tmp-${process.pid}`
  writeFileSync(tmp, JSON.stringify(d, null, 2) + "\n", { mode: 0o600 })
  chmodSync(tmp, 0o600)
  renameSync(tmp, PEERS)
}
function upsert(d, entry) {
  const clash = d.machines.find((m) => m.name === entry.name && m.serverId !== entry.serverId)
  if (clash) die(`机器名「${entry.name}」已被另一台机器（${clash.label}）占用，请用 --name 换一个`,
                 `Machine name "${entry.name}" is already used by another machine (${clash.label}); pick another with --name`)
  d.machines = d.machines.filter((m) => m.serverId !== entry.serverId)
  d.machines.push(entry)
}

// ---- this machine ----
function selfInfo() {
  const status = paseoJson(["status"])
  const pair = paseoJson(["pair"])
  if (!pair.relayEnabled || !pair.url)
    die("本机 daemon 没开中继，跨机器需要中继。在 Paseo 设置里打开中继（或运行 paseo pair --relay），再重试",
        "This daemon has no relay enabled; cross-machine use needs it. Enable the relay in Paseo settings (or run: paseo pair --relay), then retry")
  return { serverId: status.serverId, version: status.daemonVersion, pairing: pair.url }
}
function defaultLabel() {
  if (process.platform === "darwin") {
    const r = spawnSync("scutil", ["--get", "ComputerName"], { encoding: "utf8" })
    if (r.status === 0 && r.stdout.trim()) return r.stdout.trim()
  }
  return hostname()
}
const defaultName = () => hostname().split(".")[0].toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "") || "this-mac"

// ---- clipboard ----
const CLIP = process.platform === "darwin"
  ? { copy: ["pbcopy"], paste: ["pbpaste"] }
  : process.env.WAYLAND_DISPLAY
    ? { copy: ["wl-copy"], paste: ["wl-paste", "--no-newline"] }
    : { copy: ["xclip", "-selection", "clipboard"], paste: ["xclip", "-selection", "clipboard", "-o"] }
function clipCopy(text) {
  const r = spawnSync(CLIP.copy[0], CLIP.copy.slice(1), { input: text })
  return r.status === 0
}
function clipPaste() {
  const r = spawnSync(CLIP.paste[0], CLIP.paste.slice(1), { encoding: "utf8" })
  return r.status === 0 ? r.stdout : null
}

// ---- version compare ----
const atLeast = (v, min) => {
  const a = String(v).split(/[.-]/).map(Number), b = min.split(".").map(Number)
  for (let i = 0; i < b.length; i++) { if ((a[i] || 0) !== b[i]) return (a[i] || 0) > b[i] }
  return true
}

// ================= commands =================
if (sub === "init") {
  const me = selfInfo()
  const d = loadPeers()
  const old = d.machines.find((m) => m.serverId === me.serverId)
  const entry = {
    name: opt("--name") || old?.name || defaultName(),
    label: opt("--label") || old?.label || defaultLabel(),
    serverId: me.serverId,
    pairing: me.pairing,
  }
  if (!/^[a-z0-9][a-z0-9-]*$/.test(entry.name)) die("机器名只能用小写字母、数字和连字符", "Machine names may only use lowercase letters, digits and hyphens")
  upsert(d, entry)
  savePeers(d)
  console.log(t(
    `已登记本机：${entry.name}（${entry.label}，${entry.serverId}，Paseo ${me.version}）→ ${PEERS}（权限 600）\n下一步：在另一台机器上也运行 ${cmd} init，然后两边互相 invite / join。`,
    `Registered this machine: ${entry.name} (${entry.label}, ${entry.serverId}, Paseo ${me.version}) → ${PEERS} (mode 600)\nNext: run ${cmd} init on the other machine too, then invite / join in both directions.`))
  if (!atLeast(me.version, "0.12.0")) console.log(t("注意：本机 Paseo 低于 0.12.0，消息会打断对方而不是引导，建议升级", "Note: Paseo here is older than 0.12.0; messages will interrupt instead of steer — upgrade recommended"))
  process.exit(0)
}

if (sub === "invite") {
  const d = loadPeers()
  const status = paseoJson(["status"])
  const me = d.machines.find((m) => m.serverId === status.serverId)
  if (!me) die(`本机还没登记，先运行 ${cmd} init`, `This machine isn't registered yet; run ${cmd} init first`)
  const code = PREFIX + Buffer.from(JSON.stringify({ v: 1, name: me.name, label: me.label, serverId: me.serverId, pairing: me.pairing })).toString("base64url")
  if (flag("--print")) {
    console.error(t("⚠ 下面的加入码含本机配对链接（等同钥匙），只发给你自己的另一台机器，别贴进聊天或仓库：",
                    "⚠ The join code below contains this machine's pairing link (a key). Only move it to your own other machine; don't paste it into chats or repos:"))
    console.log(code)
  } else if (clipCopy(code)) {
    console.log(t(
      `本机（${me.name}）的加入码已复制到剪贴板（不在屏幕显示）。到另一台机器上运行 ${cmd} join 读入。\n剪贴板不能跨机器时：用你信任的方式把它带过去（例如 Apple 通用剪贴板），或在那台机器的终端里运行 ${cmd} join 粘贴（输入不回显）。不要贴进 Agent 对话。`,
      `This machine's (${me.name}) join code is on the clipboard (not shown). On the other machine, run ${cmd} join.\nIf the clipboard doesn't reach that machine, move it a way you trust (e.g. Apple Universal Clipboard), or run ${cmd} join in a terminal there and paste (input is hidden). Don't paste it into an agent chat.`))
  } else {
    die(`没有可用的剪贴板工具（${CLIP.copy[0]}）。改用 ${cmd} invite --print 输出到终端`, `No clipboard tool (${CLIP.copy[0]}). Use ${cmd} invite --print to print it to the terminal`)
  }
  process.exit(0)
}

if (sub === "join") {
  // Where the code comes from: --stdin, else the clipboard if it holds a code, else a hidden prompt on the terminal
  let raw = null, fromClip = false
  if (flag("--stdin")) raw = readFileSync(0, "utf8")
  else {
    const c = clipPaste()
    if (c && c.trim().startsWith(PREFIX)) { raw = c; fromClip = true }
  }
  if (raw === null) {
    // Hidden prompt only works on a real terminal; agents have none, so tell them what to do instead
    if (!process.stdin.isTTY) die(
      `剪贴板里没有加入码。请在对方机器上运行 ${cmd} invite 复制加入码，把它带到这台机器的剪贴板后再运行 ${cmd} join；或者请用户在这台机器的终端里亲自运行 ${cmd} join 粘贴。`,
      `No join code on the clipboard. Run ${cmd} invite on the other machine, get the code onto this machine's clipboard, then run ${cmd} join again; or ask the user to run ${cmd} join themselves in a terminal here and paste.`)
    process.stdout.write(t("粘贴另一台机器的加入码（不回显），回车确认：", "Paste the other machine's join code (hidden), then Enter: "))
    raw = spawnSync("bash", ["-c", 'IFS= read -rs line </dev/tty && printf %s "$line"'], { encoding: "utf8", stdio: ["inherit", "pipe", "inherit"] }).stdout
    process.stdout.write("\n")
  }
  raw = (raw || "").trim()
  if (!raw.startsWith(PREFIX)) die("这不是 paseo-mesh 加入码（应以 paseo-mesh-join: 开头）", "That is not a paseo-mesh join code (it should start with paseo-mesh-join:)")
  let peer
  try { peer = JSON.parse(Buffer.from(raw.slice(PREFIX.length), "base64url").toString("utf8")) } catch { die("加入码损坏，请重新 invite", "Corrupted join code; run invite again") }
  for (const k of ["name", "label", "serverId", "pairing"]) if (typeof peer[k] !== "string" || !peer[k]) die(`加入码缺少 ${k}`, `Join code is missing ${k}`)
  if (opt("--name")) peer.name = opt("--name")

  const selfId = paseoJson(["status"]).serverId
  if (peer.serverId === selfId) die("这是本机自己的加入码；要到另一台机器上 join", "That's this machine's own join code; run join on the other machine")

  // Actually connect through the link and check we reach the machine the code claims
  let remote
  try { remote = paseoJson(["status"], peer.pairing, 45000) }
  catch (e) { die(`连不上 ${peer.name}（${peer.label}）：${(e.stderr || e.message || "").toString().split("\n")[0]}\n确认那台机器的 Paseo 在运行、中继已开启`,
                  `Can't reach ${peer.name} (${peer.label}): ${(e.stderr || e.message || "").toString().split("\n")[0]}\nMake sure Paseo is running there with the relay enabled`) }
  if (remote.serverId !== peer.serverId) die(`连上的机器 serverId（${remote.serverId}）与加入码（${peer.serverId}）不一致，已放弃写入`,
                                              `Reached serverId ${remote.serverId}, but the code says ${peer.serverId}; nothing written`)
  const d = loadPeers()
  upsert(d, { name: peer.name, label: peer.label, serverId: peer.serverId, pairing: peer.pairing })
  savePeers(d)
  if (fromClip) clipCopy("") // don't leave the key sitting on the clipboard
  const iKnown = d.machines.some((m) => m.serverId === selfId)
  console.log(t(
    `已加入 ${peer.name}（${peer.label}，Paseo ${remote.daemonVersion}），连接正常 → ${PEERS}（权限 600）${fromClip ? "；剪贴板已清空" : ""}`,
    `Joined ${peer.name} (${peer.label}, Paseo ${remote.daemonVersion}); connection OK → ${PEERS} (mode 600)${fromClip ? "; clipboard cleared" : ""}`))
  console.log(iKnown
    ? t(`对方也需要知道本机：在本机运行 ${cmd} invite，再到 ${peer.name} 上 join（已做过可忽略）。`, `${peer.name} also needs this machine: run ${cmd} invite here, then join on ${peer.name} (skip if done).`)
    : t(`本机还没登记，先运行 ${cmd} init，再 invite 给 ${peer.name}。`, `This machine isn't registered yet: run ${cmd} init, then invite to ${peer.name}.`))
  process.exit(0)
}

if (sub === "doctor") {
  let bad = 0
  const ok = (z, e) => console.log("✓ " + t(z, e))
  const no = (z, e) => { bad++; console.log("✗ " + t(z, e)) }
  let selfId = null
  try {
    const s = paseoJson(["status"])
    selfId = s.serverId
    atLeast(s.daemonVersion, "0.12.0")
      ? ok(`本机 Paseo ${s.daemonVersion}（${s.serverId}）`, `Paseo ${s.daemonVersion} here (${s.serverId})`)
      : no(`本机 Paseo ${s.daemonVersion} 低于 0.12.0，消息会打断对方，请升级`, `Paseo ${s.daemonVersion} here is older than 0.12.0 (messages interrupt); upgrade`)
  } catch (e) { no(`本机 Paseo daemon 连不上：${(e.message || "").split("\n")[0]}`, `Can't reach the local Paseo daemon: ${(e.message || "").split("\n")[0]}`) }
  if (process.env.PASEO_AGENT_ID) ok("在 Paseo 会话里运行（有 PASEO_AGENT_ID）", "Running inside a Paseo session (PASEO_AGENT_ID set)")
  else console.log("· " + t("不在 Paseo 会话里（whoami、tell 的来源说明需要在会话里运行）", "Not inside a Paseo session (whoami and tell's sender line need one)"))
  const onPath = spawnSync("bash", ["-c", "command -v paseo-peer"], { encoding: "utf8" }).stdout.trim()
  onPath ? ok(`paseo-peer 在 PATH 里：${onPath}`, `paseo-peer on PATH: ${onPath}`)
         : console.log("· " + t("paseo-peer 不在 PATH 里（可选；加进去后回复命令更短）", "paseo-peer is not on PATH (optional; shorter reply commands if it is)"))
  if (!existsSync(PEERS)) {
    console.log("· " + t(`没有 ${PEERS}：只能做本机跨项目协作。要跨机器，运行 ${cmd} init`, `No ${PEERS}: same-machine cross-project only. For cross-machine, run ${cmd} init`))
  } else {
    const mode = (statSync(PEERS).mode & 0o777).toString(8)
    mode.endsWith("00") ? ok(`${PEERS} 权限 ${mode}`, `${PEERS} mode ${mode}`) : no(`${PEERS} 权限 ${mode}，请 chmod 600`, `${PEERS} mode ${mode}; run chmod 600`)
    const d = loadPeers()
    if (selfId && !d.machines.some((m) => m.serverId === selfId)) no(`本机不在清单里，运行 ${cmd} init`, `This machine isn't in the list; run ${cmd} init`)
    for (const m of d.machines.filter((x) => x.serverId !== selfId)) {
      try {
        const r = paseoJson(["status"], m.pairing, 45000)
        if (r.serverId !== m.serverId) no(`${m.name}：连上的是 ${r.serverId}，清单写的是 ${m.serverId}`, `${m.name}: reached ${r.serverId}, list says ${m.serverId}`)
        else if (!atLeast(r.daemonVersion, "0.12.0")) no(`${m.name}（${m.label}）可连，但 Paseo ${r.daemonVersion} 低于 0.12.0`, `${m.name} (${m.label}) reachable, but Paseo ${r.daemonVersion} < 0.12.0`)
        else ok(`${m.name}（${m.label}）可连，Paseo ${r.daemonVersion}`, `${m.name} (${m.label}) reachable, Paseo ${r.daemonVersion}`)
      } catch (e) { no(`${m.name}（${m.label}）连不上：${(e.stderr || e.message || "").toString().split("\n")[0]}`, `${m.name} (${m.label}) unreachable: ${(e.stderr || e.message || "").toString().split("\n")[0]}`) }
    }
    if (d.machines.length < 2) console.log("· " + t(`清单里只有本机；另一台机器 init 后，两边互相 invite / join`, `Only this machine is listed; after init on the other machine, invite / join both ways`))
  }
  process.exit(bad ? 1 : 0)
}

die(`未知命令：${sub}`, `Unknown command: ${sub}`)
