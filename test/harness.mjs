// End-to-end harness for paseo-peer: every "machine" is a real Paseo daemon in its own temporary HOME.
// Daemon setup adapted from jtsang4/paseo-mesh (MIT), src/test/e2e/harness.ts.
//
// Isolation rules (the developer's real daemon in ~/.paseo must never be touched):
// - every paseo / paseo-peer child gets a freshly built environment, never a copy of process.env, so no
//   inherited PASEO_HOME / PASEO_HOST / PASEO_AGENT_ID / CODEX_THREAD_ID can point back at the real setup;
// - HOME is the machine's temp dir (so ~/.paseo is its daemon home) and PATH holds only a bin dir with
//   `paseo` and `node` links plus the system dirs;
// - test daemons listen on a free loopback port, with the relay off and plugins on.
import { execFile } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync, chmodSync, rmSync } from "node:fs"
import net from "node:net"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
export const PASEO_BIN = process.env.PASEO_BIN || "/Applications/Paseo.app/Contents/Resources/bin/paseo"
export const PEER_SCRIPT = path.join(ROOT, "skills/paseo-peer/scripts/paseo-peer")
export const ECHO_PROVIDER_DIR = path.join(ROOT, "test/fixtures/echo-provider")
export const ECHO_MODEL = "peer-echo/echo-1"
// Where an already installed Paseo SDK lives; `link` needs one and the tests must not install from npm
export const REAL_SDK_DIR = process.env.PASEO_PEER_SDK || path.join(os.homedir(), ".paseo", "paseo-mesh-sdk")

export const haveDaemon = () => existsSync(PASEO_BIN)

export function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address()
      server.close(() => resolve(port))
    })
  })
}

/** Runs a command; resolves { code, stdout, stderr } instead of throwing on a non-zero exit. */
function run(file, args, options) {
  return new Promise((resolve) => {
    execFile(file, args, { encoding: "utf8", timeout: 180_000, maxBuffer: 16 << 20, ...options }, (error, stdout, stderr) => {
      resolve({ code: error ? (typeof error.code === "number" ? error.code : 1) : 0, stdout, stderr, error })
    })
  })
}

export class Machine {
  constructor(name) {
    this.name = name
    // realpath: on macOS os.tmpdir() is behind the /var -> /private/var symlink
    this.root = realpathSync(mkdtempSync(path.join(os.tmpdir(), `paseo-peer-e2e-${name}-`)))
    this.home = path.join(this.root, ".paseo")
    this.bin = path.join(this.root, "bin")
    this.label = `Test ${name.toUpperCase()}`
    this.port = 0
    this.serverId = ""
    this.started = false
  }

  /** The complete environment for child processes: nothing inherited except a few harmless basics. */
  env(extra = {}) {
    const env = {
      HOME: this.root,
      PATH: `${this.bin}:/usr/bin:/bin:/usr/sbin:/sbin`,
      TMPDIR: os.tmpdir(),
      LANG: "en_US.UTF-8",
      CI: "true",
      ...extra,
    }
    // Belt and braces: a test bug must never aim a child at the real home
    if (env.HOME === os.homedir() || env.PASEO_HOME) throw new Error("refusing to run a child against the real Paseo home")
    return env
  }

  get endpoint() {
    return `127.0.0.1:${this.port}`
  }

  /** paseo CLI against this machine's daemon (always with an explicit --home). */
  cli(args) {
    return run(PASEO_BIN, ["--home", this.home, ...args], { env: this.env(), cwd: this.root })
  }

  async cliJson(args) {
    const r = await this.cli([...args, "--json"])
    if (r.code !== 0) throw new Error(`paseo ${args.join(" ")} failed: ${r.stderr || r.stdout}`)
    return JSON.parse(r.stdout)
  }

  /** The paseo-peer script, run "on" this machine. */
  peer(args, extraEnv = {}) {
    if (!this.started) throw new Error(`daemon ${this.name} is not running`)
    return run(PEER_SCRIPT, args, { env: this.env(extraEnv), cwd: this.root })
  }

  async start() {
    mkdirSync(this.home, { recursive: true })
    mkdirSync(this.bin, { recursive: true })
    symlinkSync(PASEO_BIN, path.join(this.bin, "paseo"))
    symlinkSync(process.execPath, path.join(this.bin, "node"))
    this.port = await freePort()
    writeFileSync(path.join(this.home, "config.json"), JSON.stringify({
      daemon: { listen: this.endpoint, relay: { enabled: false } },
      features: { dictation: { enabled: false }, voiceMode: { enabled: false } },
      pluginsEnabled: true,
    }))
    const r = await this.cli(["daemon", "start", "--timeout", "120"])
    if (r.code !== 0) throw new Error(`daemon ${this.name} failed to start: ${r.stderr || r.stdout}`)
    this.started = true
    this.serverId = readFileSync(path.join(this.home, "server-id"), "utf8").trim()
    await this.cliJson(["plugin", "install", ECHO_PROVIDER_DIR])
  }

  /** Stops the daemon (even a half-started one) and deletes the temp dir; never throws. */
  async destroy() {
    if (existsSync(path.join(this.home, "config.json"))) await this.cli(["daemon", "stop", "--timeout", "20", "--force"]).catch(() => {})
    this.started = false
    rmSync(this.root, { recursive: true, force: true })
  }

  /** Starts an echo agent in <root>/<project> and waits for its first turn; returns { id, shortId }. */
  async agent(project, title, prompt) {
    const cwd = path.join(this.root, project)
    mkdirSync(cwd, { recursive: true })
    const a = await this.cliJson(["run", "--provider", ECHO_MODEL, "--title", title, "--cwd", cwd, "--wait-timeout", "60s", prompt])
    if (a.status !== "completed") throw new Error(`echo agent ${title} ended as ${a.status}`)
    return { id: a.agentId, shortId: a.agentId.slice(0, 7) }
  }

  async logs(agentId) {
    const r = await this.cli(["logs", agentId, "--tail", "200"])
    return r.stdout
  }

  /** Writes ~/.paseo/peers.json (mode 600) listing the given machines with direct daemon addresses. */
  writePeers(machines) {
    const file = path.join(this.home, "peers.json")
    writeFileSync(file, JSON.stringify({
      machines: machines.map((m) => ({ name: m.name, label: m.label, serverId: m.serverId, pairing: `tcp://${m.endpoint}` })),
    }, null, 2), { mode: 0o600 })
    chmodSync(file, 0o600)
  }
}

export async function waitFor(check, { timeoutMs = 30_000, intervalMs = 300, message = "condition not met" } = {}) {
  const deadline = Date.now() + timeoutMs
  let last
  while (Date.now() < deadline) {
    last = await check()
    if (last) return last
    await new Promise((r) => setTimeout(r, intervalMs))
  }
  throw new Error(message)
}
